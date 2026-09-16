/**
 * Read-only Enterprise ATS pipeline stage catalog.
 * Separate from interview_stages / md_interview_stages.
 */

function mapStageRow(row) {
  return {
    stage_id: row.stage_id,
    stage_code: row.stage_code,
    display_name: row.display_name,
    sort_order: row.sort_order,
    is_terminal: row.is_terminal,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listActiveAtsStageCatalog(pool) {
  const result = await pool.query(
    `SELECT stage_id, stage_code, display_name, sort_order,
            is_terminal, is_active, created_at, updated_at
     FROM rm_ats_stage_catalog
     WHERE is_active = TRUE
     ORDER BY sort_order ASC, stage_id ASC`
  );

  return result.rows.map(mapStageRow);
}

module.exports = {
  listActiveAtsStageCatalog
};
