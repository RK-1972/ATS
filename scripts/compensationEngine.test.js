const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const compensationEngineService = require("../services/compensationEngineService");

function buildStructure() {
  return {
    structureId: "STRUCT-TEST",
    structureName: "Test Structure",
    structureCode: "TEST"
  };
}

function component(overrides) {
  return {
    structureComponentId: overrides.structureComponentId,
    componentCode: overrides.componentCode,
    componentName: overrides.componentName,
    componentCategory: overrides.componentCategory || "EARNINGS",
    displayOrder: overrides.displayOrder,
    formulaType: overrides.formulaType,
    formulaValue: overrides.formulaValue,
    fixedAmount: overrides.fixedAmount,
    includeInCtc: overrides.includeInCtc !== false,
    editable: false,
    mandatory: true
  };
}

const standardComponents = [
  component({
    structureComponentId: "SC-1",
    componentCode: "BASIC_DA",
    componentName: "Basic + DA",
    componentCategory: "EARNINGS",
    displayOrder: 1,
    formulaType: "PERCENT_OF_CTC",
    formulaValue: 40
  }),
  component({
    structureComponentId: "SC-2",
    componentCode: "HRA",
    componentName: "HRA",
    componentCategory: "EARNINGS",
    displayOrder: 2,
    formulaType: "PERCENT_OF_BASIC",
    formulaValue: 40
  }),
  component({
    structureComponentId: "SC-3",
    componentCode: "EMPLOYER_PF",
    componentName: "Employer PF",
    componentCategory: "EMPLOYER_CONTRIBUTION",
    displayOrder: 3,
    formulaType: "PERCENT_OF_BASIC",
    formulaValue: 12
  }),
  component({
    structureComponentId: "SC-4",
    componentCode: "EMPLOYER_ESI",
    componentName: "Employer ESI",
    componentCategory: "EMPLOYER_CONTRIBUTION",
    displayOrder: 4,
    formulaType: "PERCENT_OF_CTC",
    formulaValue: 3.25
  }),
  component({
    structureComponentId: "SC-5",
    componentCode: "SPECIAL_ALLOWANCE",
    componentName: "Special Allowance",
    componentCategory: "ALLOWANCE",
    displayOrder: 5,
    formulaType: "BALANCING"
  })
];

describe("compensationEngineService.evaluateStructure", () => {
  it("calculates Basic as percent of annual CTC", () => {
    const annualCtc = 1200000;
    const result = compensationEngineService.evaluateStructure(
      annualCtc,
      buildStructure(),
      standardComponents
    );

    const basic = result.components.find((item) => item.componentCode === "BASIC_DA");
    assert.equal(basic.amount, 480000);
  });

  it("calculates HRA as percent of Basic", () => {
    const annualCtc = 1200000;
    const result = compensationEngineService.evaluateStructure(
      annualCtc,
      buildStructure(),
      standardComponents
    );

    const basic = result.components.find((item) => item.componentCode === "BASIC_DA");
    const hra = result.components.find((item) => item.componentCode === "HRA");
    assert.equal(hra.amount, basic.amount * 0.4);
  });

  it("applies PF wage ceiling for employer PF", () => {
    const annualCtc = 3000000;
    const result = compensationEngineService.evaluateStructure(
      annualCtc,
      buildStructure(),
      standardComponents
    );

    const pf = result.components.find((item) => item.componentCode === "EMPLOYER_PF");
    assert.equal(pf.amount, 21600);
  });

  it("zeros employer ESI when monthly earnings exceed threshold", () => {
    const annualCtc = 1200000;
    const result = compensationEngineService.evaluateStructure(
      annualCtc,
      buildStructure(),
      standardComponents
    );

    const esi = result.components.find((item) => item.componentCode === "EMPLOYER_ESI");
    assert.equal(esi.amount, 0);
  });

  it("reconciles balancing component to approved annual CTC", () => {
    const annualCtc = 1200000;
    const result = compensationEngineService.evaluateStructure(
      annualCtc,
      buildStructure(),
      standardComponents
    );

    assert.equal(result.verifiedCtcTotal, annualCtc);
    assert.equal(result.totalCtc, annualCtc);
  });

  it("rejects non-positive annual CTC", () => {
    assert.throws(() => {
      compensationEngineService.evaluateStructure(0, buildStructure(), standardComponents);
    });
  });
});
