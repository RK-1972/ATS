const compensationRepository = require("../repositories/compensationRepository");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getActiveStructures(pool) {
  const rows = await compensationRepository.findActiveStructures(pool);
  return rows.map(compensationRepository.mapStructureRow);
}

async function getStructureComponents(pool, structureId) {
  const structure = await compensationRepository.findStructureById(pool, structureId);

  if (!structure) {
    throw httpError(`Compensation structure not found: ${structureId}`, 404);
  }

  const rows = await compensationRepository.findStructureComponents(pool, structureId);

  return {
    structure: compensationRepository.mapStructureRow(structure),
    components: rows.map(compensationRepository.mapStructureComponentRow)
  };
}

async function getDefaultStructureComponents(pool) {
  const structure = await compensationRepository.findDefaultStructure(pool);

  if (!structure) {
    throw httpError("Default compensation structure is not configured.", 404);
  }

  const rows = await compensationRepository.findStructureComponents(
    pool,
    structure.structure_id
  );

  return {
    structure: compensationRepository.mapStructureRow(structure),
    components: rows.map(compensationRepository.mapStructureComponentRow)
  };
}

module.exports = {
  getActiveStructures,
  getStructureComponents,
  getDefaultStructureComponents
};
