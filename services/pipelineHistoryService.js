/**
 * Shared rm_pipeline_history writer for Enterprise ATS stage transitions.
 */

async function loadActiveEnterpriseMapping(queryable, mapId) {
  const result = await queryable.query(
    `SELECT mapping_id, map_id, candidate_id, req_id, requisition_code, stage_name
     FROM rm_candidate_mappings
     WHERE map_id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [mapId]
  );

  return result.rows[0] || null;
}

async function recordPipelineStageTransition(queryable, {
  requisitionCode = null,
  mappingId = null,
  candidateId = null,
  eventType,
  fromStage = null,
  toStage,
  actor,
  actorRole = null,
  comments = null,
  metadata = null
}) {
  if (!toStage || !String(toStage).trim()) {
    return null;
  }

  await queryable.query(
    `INSERT INTO rm_pipeline_history (
      requisition_code, mapping_id, candidate_id, event_type,
      from_stage, to_stage, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      requisitionCode,
      mappingId,
      candidateId,
      eventType,
      fromStage,
      toStage,
      actor,
      actorRole,
      comments,
      metadata ? JSON.stringify(metadata) : null
    ]
  );

  return {
    eventType,
    fromStage,
    toStage
  };
}

async function applyEnterpriseInterviewStageTransition(pool, {
  mapId,
  newStage,
  eventType,
  user,
  comments = null,
  metadata = null
}) {
  const mapping = await loadActiveEnterpriseMapping(pool, mapId);
  if (!mapping) {
    return null;
  }

  const previousStage = mapping.stage_name || null;
  const normalizedPrevious = String(previousStage || "").trim();
  const normalizedNext = String(newStage || "").trim();

  if (normalizedPrevious === normalizedNext) {
    return {
      mapping,
      previousStage,
      toStage: newStage,
      historyRecorded: false
    };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE rm_candidate_mappings
       SET stage_name = $1, modified_on = NOW()
       WHERE map_id = $2`,
      [newStage, mapId]
    );

    await module.exports.recordPipelineStageTransition(client, {
      requisitionCode: mapping.requisition_code,
      mappingId: mapping.mapping_id,
      candidateId: mapping.candidate_id,
      eventType,
      fromStage: previousStage,
      toStage: newStage,
      actor: user.name,
      actorRole: user.role,
      comments,
      metadata
    });

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }

  return {
    mapping,
    previousStage,
    toStage: newStage,
    historyRecorded: true
  };
}

module.exports = {
  loadActiveEnterpriseMapping,
  recordPipelineStageTransition,
  applyEnterpriseInterviewStageTransition
};
