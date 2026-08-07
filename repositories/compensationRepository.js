const FORMULA_TYPES = [
  "PERCENT_OF_CTC",
  "PERCENT_OF_BASIC",
  "FIXED",
  "BALANCING",
  "RULE_BASED"
];

function mapStructureRow(row) {
  return {
    structureId: row.structure_id,
    structureCode: row.structure_code,
    structureName: row.structure_name,
    description: row.description,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    status: row.status,
    isDefault: Boolean(row.is_default),
    createdOn: row.created_on?.toISOString?.() || row.created_on,
    modifiedOn: row.modified_on?.toISOString?.() || row.modified_on
  };
}

function mapStructureComponentRow(row) {
  return {
    structureComponentId: row.structure_component_id,
    structureId: row.structure_id,
    componentId: row.component_id,
    componentCode: row.component_code,
    componentName: row.component_name,
    componentCategory: row.component_category,
    displayOrder: Number(row.display_order || 0),
    formulaType: row.formula_type,
    formulaValue:
      row.formula_value != null && row.formula_value !== ""
        ? Number(row.formula_value)
        : null,
    fixedAmount:
      row.fixed_amount != null && row.fixed_amount !== ""
        ? Number(row.fixed_amount)
        : null,
    editable: Boolean(row.editable),
    mandatory: Boolean(row.mandatory),
    includeInCtc: Boolean(row.include_in_ctc),
    status: row.status
  };
}

async function findActiveStructures(pool) {
  const result = await pool.query(
    `SELECT *
     FROM cm_compensation_structures
     WHERE status = 'Active'
     ORDER BY is_default DESC, structure_name ASC`
  );

  return result.rows;
}

async function findDefaultStructure(pool) {
  const result = await pool.query(
    `SELECT *
     FROM cm_compensation_structures
     WHERE status = 'Active'
       AND is_default = TRUE
     ORDER BY structure_code ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function findStructureById(pool, structureId) {
  const result = await pool.query(
    `SELECT *
     FROM cm_compensation_structures
     WHERE structure_id = $1`,
    [structureId]
  );

  return result.rows[0] || null;
}

async function findStructureComponents(pool, structureId) {
  const result = await pool.query(
    `SELECT
       sc.*,
       cm.component_code,
       cm.component_name,
       cm.component_category
     FROM cm_compensation_structure_components sc
     INNER JOIN cm_compensation_component_master cm
       ON cm.component_id = sc.component_id
     WHERE sc.structure_id = $1
       AND sc.status = 'Active'
       AND cm.status = 'Active'
     ORDER BY sc.display_order ASC, sc.structure_component_id ASC`,
    [structureId]
  );

  return result.rows;
}

module.exports = {
  FORMULA_TYPES,
  mapStructureRow,
  mapStructureComponentRow,
  findActiveStructures,
  findDefaultStructure,
  findStructureById,
  findStructureComponents
};
