const compensationEngineService = require("./compensationEngineService");
const compensationRepository = require("../repositories/compensationRepository");
const {
  GROSS_EARNING_CATEGORIES,
  isIncludedInGrossCategory
} = require("./compensationPayrollConstants");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertStructureIdMatchesComponent(structureId, componentRow) {
  const expected = String(structureId || "").trim();
  const actual = String(componentRow?.structure_id || "").trim();

  if (!expected || !actual || expected !== actual) {
    throw httpError(
      "Compensation component does not belong to the requested structure.",
      400
    );
  }
}

function assertActiveBalancingComponent(components) {
  const balancing = (components || []).filter(
    (item) => item.formulaType === "BALANCING" && item.status !== "Inactive"
  );

  if (balancing.length !== 1) {
    throw httpError(
      "Compensation structure must contain exactly one active balancing component.",
      400
    );
  }
}

function assertNoDuplicateComponentCodes(components) {
  const seen = new Set();

  for (const component of components || []) {
    const code = String(component.componentCode || "").trim();

    if (!code) {
      continue;
    }

    if (seen.has(code)) {
      throw httpError(`Duplicate component code in structure: ${code}`, 400);
    }

    seen.add(code);
  }
}

function assertPercentOfBasicHasBasic(components) {
  const hasBasic = (components || []).some(
    (item) => String(item.componentCode || "").trim() === "BASIC_DA"
  );
  const needsBasic = (components || []).some(
    (item) =>
      item.formulaType === "PERCENT_OF_BASIC" && item.status !== "Inactive"
  );

  if (needsBasic && !hasBasic) {
    throw httpError(
      "Structures with percent-of-Basic rules require a Basic component (BASIC_DA).",
      400
    );
  }
}

function dryRunStructureEvaluation(structure, components, sampleAnnualCtc = 1200000) {
  try {
    compensationEngineService.evaluateStructure(
      sampleAnnualCtc,
      structure,
      components.filter((item) => item.status !== "Inactive")
    );
  } catch (error) {
    throw httpError(
      `Compensation structure failed reconciliation check: ${error.message}`,
      400
    );
  }
}

async function validateStructureIntegrity(pool, structureId) {
  const structureRow = await compensationRepository.findStructureById(pool, structureId);

  if (!structureRow) {
    throw httpError(`Compensation structure not found: ${structureId}`, 404);
  }

  const rows = await compensationRepository.findStructureComponents(pool, structureId);
  const components = rows.map(compensationRepository.mapStructureComponentRow);

  assertNoDuplicateComponentCodes(components);
  assertPercentOfBasicHasBasic(components);
  assertActiveBalancingComponent(components);

  dryRunStructureEvaluation(
    compensationRepository.mapStructureRow(structureRow),
    components
  );
}

module.exports = {
  GROSS_EARNING_CATEGORIES,
  isIncludedInGrossCategory,
  assertStructureIdMatchesComponent,
  assertActiveBalancingComponent,
  assertNoDuplicateComponentCodes,
  assertPercentOfBasicHasBasic,
  dryRunStructureEvaluation,
  validateStructureIntegrity
};
