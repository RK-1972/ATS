const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const compensationLetterBridgeService = require("../services/compensationLetterBridgeService");
const compensationEngineService = require("../services/compensationEngineService");

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
    mandatory: true,
    status: "Active"
  };
}

const structure = {
  structureId: "STRUCT-TEST",
  structureName: "Test",
  structureCode: "TEST"
};

const standardComponents = [
  component({
    structureComponentId: "SC-1",
    componentCode: "BASIC_DA",
    componentCategory: "EARNINGS",
    displayOrder: 1,
    formulaType: "PERCENT_OF_CTC",
    formulaValue: 40
  }),
  component({
    structureComponentId: "SC-2",
    componentCode: "HRA",
    componentCategory: "EARNINGS",
    displayOrder: 2,
    formulaType: "PERCENT_OF_BASIC",
    formulaValue: 40
  }),
  component({
    structureComponentId: "SC-3",
    componentCode: "EMPLOYER_PF",
    componentCategory: "EMPLOYER_CONTRIBUTION",
    displayOrder: 3,
    formulaType: "PERCENT_OF_BASIC",
    formulaValue: 12
  }),
  component({
    structureComponentId: "SC-4",
    componentCode: "EMPLOYER_ESI",
    componentCategory: "EMPLOYER_CONTRIBUTION",
    displayOrder: 4,
    formulaType: "PERCENT_OF_CTC",
    formulaValue: 3.25
  }),
  component({
    structureComponentId: "SC-5",
    componentCode: "SPECIAL_ALLOWANCE",
    componentCategory: "ALLOWANCE",
    displayOrder: 5,
    formulaType: "BALANCING"
  })
];

describe("compensationLetterBridgeService", () => {
  it("maps employer ESI to ESIC display name for annexure", () => {
    const evaluation = compensationEngineService.evaluateStructure(
      1200000,
      structure,
      standardComponents
    );
    const rows = compensationLetterBridgeService.mapEvaluationToPersistedRows(evaluation);
    const esiRow = rows.find((row) => row.component_code === "EMPLOYER_ESI");

    assert.equal(esiRow.component_name, "ESIC");
  });

  it("keeps evaluation and aggregated persisted totals aligned", () => {
    const annualCtc = 1200000;
    const evaluation = compensationEngineService.evaluateStructure(
      annualCtc,
      structure,
      standardComponents
    );
    const rows = compensationLetterBridgeService.mapEvaluationToPersistedRows(evaluation);
    const fromEvaluation =
      compensationLetterBridgeService.buildSalaryBreakupFromEvaluation(evaluation);
    const aggregated = compensationLetterBridgeService.aggregatePersistedLetterRows(rows);

    assert.equal(aggregated.totalCtc, annualCtc);
    assert.equal(fromEvaluation.totalCTC, annualCtc);
    assert.equal(aggregated.salaryBreakup.esicAnnual, fromEvaluation.esicAnnual);
    assert.equal(aggregated.gross, fromEvaluation.grossAnnual);
  });

  it("includes allowance components in gross earnings total", () => {
    const components = [
      ...standardComponents.filter((item) => item.componentCode !== "SPECIAL_ALLOWANCE"),
      component({
        structureComponentId: "SC-M",
        componentCode: "MEDICAL_ALLOWANCE",
        componentCategory: "ALLOWANCE",
        displayOrder: 4,
        formulaType: "FIXED",
        fixedAmount: 15000
      }),
      component({
        structureComponentId: "SC-5",
        componentCode: "SPECIAL_ALLOWANCE",
        componentCategory: "ALLOWANCE",
        displayOrder: 6,
        formulaType: "BALANCING"
      })
    ];

    const evaluation = compensationEngineService.evaluateStructure(1200000, structure, components);
    const medical = evaluation.components.find(
      (item) => item.componentCode === "MEDICAL_ALLOWANCE"
    );

    assert.ok(medical.includeInGross);
    assert.ok(evaluation.gross >= medical.amount);
  });
});
