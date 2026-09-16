/**
 * Read-only legacy ATS stage alias resolution.
 * Translation layer only — does not mutate candidate stage values.
 */

function mapAliasRow(row) {
  if (!row) {
    return null;
  }

  return {
    alias_id: row.alias_id,
    legacy_value: row.legacy_value,
    stage_id: row.stage_id,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    catalog: {
      stage_id: row.catalog_stage_id,
      stage_code: row.stage_code,
      display_name: row.display_name,
      sort_order: row.sort_order,
      is_terminal: row.is_terminal,
      is_active: row.catalog_is_active
    }
  };
}

async function listActiveAtsStageAliases(pool) {
  const result = await pool.query(
    `SELECT a.alias_id, a.legacy_value, a.stage_id, a.is_active,
            a.created_at, a.updated_at,
            c.stage_id AS catalog_stage_id,
            c.stage_code, c.display_name, c.sort_order,
            c.is_terminal, c.is_active AS catalog_is_active
     FROM rm_ats_stage_alias a
     INNER JOIN rm_ats_stage_catalog c ON c.stage_id = a.stage_id
     WHERE a.is_active = TRUE
       AND c.is_active = TRUE
     ORDER BY a.legacy_value ASC, a.alias_id ASC`
  );

  return result.rows.map(mapAliasRow);
}

async function resolveLegacyStageAlias(pool, legacyValue) {
  const normalized = String(legacyValue || "").trim();
  if (!normalized) {
    return null;
  }

  const result = await pool.query(
    `SELECT a.alias_id, a.legacy_value, a.stage_id, a.is_active,
            a.created_at, a.updated_at,
            c.stage_id AS catalog_stage_id,
            c.stage_code, c.display_name, c.sort_order,
            c.is_terminal, c.is_active AS catalog_is_active
     FROM rm_ats_stage_alias a
     INNER JOIN rm_ats_stage_catalog c ON c.stage_id = a.stage_id
     WHERE a.legacy_value = $1
       AND a.is_active = TRUE
       AND c.is_active = TRUE
     LIMIT 1`,
    [normalized]
  );

  return mapAliasRow(result.rows[0] || null);
}

module.exports = {
  listActiveAtsStageAliases,
  resolveLegacyStageAlias
};
