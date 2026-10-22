const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  assertNoDuplicateComponentCodes,
  assertPercentOfBasicHasBasic,
  assertActiveBalancingComponent,
  dryRunStructureEvaluation
} = require("../services/compensationStructureValidation");

const structure = {
  structureId: "S1",
  structureCode: "TEST",
  structureName: "Test"
};

describe("compensationStructureValidation", () => {
  it("rejects duplicate component codes", () => {
    assert.throws(() => {
      assertNoDuplicateComponentCodes([
        { componentCode: "BASIC_DA", formulaType: "PERCENT_OF_CTC" },
        { componentCode: "BASIC_DA", formulaType: "FIXED" }
      ]);
    });
  });

  it("requires BASIC_DA when percent-of-basic rules exist", () => {
    assert.throws(() => {
      assertPercentOfBasicHasBasic([
        { componentCode: "HRA", formulaType: "PERCENT_OF_BASIC", status: "Active" }
      ]);
    });
  });

  it("requires exactly one balancing component", () => {
    assert.throws(() => {
      assertActiveBalancingComponent([
        { formulaType: "PERCENT_OF_CTC", status: "Active" }
      ]);
    });
  });

  it("dry-runs structure reconciliation", () => {
    dryRunStructureEvaluation(structure, [
      {
        structureComponentId: "1",
        componentCode: "BASIC_DA",
        componentCategory: "EARNINGS",
        displayOrder: 1,
        formulaType: "PERCENT_OF_CTC",
        formulaValue: 40,
        includeInCtc: true,
        status: "Active"
      },
      {
        structureComponentId: "2",
        componentCode: "SPECIAL_ALLOWANCE",
        componentCategory: "ALLOWANCE",
        displayOrder: 2,
        formulaType: "BALANCING",
        includeInCtc: true,
        status: "Active"
      }
    ]);
    assert.ok(true);
  });
});
