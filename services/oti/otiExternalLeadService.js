/**
 * External lead staging persistence (separate from cand_mstr).
 */

const crypto = require("crypto");
const { classifyDuplicate, sha256 } = require("./otiExternalDedupService");
const { buildExternalMatchExplanation } = require("./otiExternalExplainService");
const { prepareQualifyingExternalLeads } = require("./otiRecommendationQualification");
const { providerDisplayName } = require("./otiExternalMultiSourceConsolidation");
const { sanitizeCandidateDisplayName } = require("../../utils/parseBasicCandidateInfo");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildLeadUuid() {
  return `oti-ext-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function upsertExternalLead(pool, profile, dedupInfo) {
  const skillsJson =
    Array.isArray(profile.skills) && profile.skills.length
      ? JSON.stringify(profile.skills)
      : null;

  if (dedupInfo.duplicate && dedupInfo.existing_lead_id) {
    await pool.query(
      `UPDATE oti_external_lead
       SET display_name = COALESCE($2, display_name),
           headline = COALESCE($3, headline),
           "current_role" = COALESCE($4, "current_role"),
           organization = COALESCE($5, organization),
           location = COALESCE($6, location),
           skills = COALESCE($7, skills),
           experience_indicators = COALESCE($8, experience_indicators),
           profile_completeness = COALESCE($9, profile_completeness),
           verified_email_hash = COALESCE($10, verified_email_hash),
           possible_internal_candidate_id = COALESCE($11, possible_internal_candidate_id),
           duplicate_reason = $12,
           updated_on = NOW()
       WHERE external_lead_id = $1`,
      [
        dedupInfo.existing_lead_id,
        profile.display_name,
        profile.headline,
        profile.current_role,
        profile.organization,
        profile.location,
        skillsJson,
        profile.experience_indicators?.length
          ? JSON.stringify(profile.experience_indicators)
          : null,
        profile.profile_completeness,
        profile.verified_email ? sha256(profile.verified_email) : null,
        dedupInfo.possible_internal_candidate_id || null,
        dedupInfo.duplicate_reason
      ]
    );

    return dedupInfo.existing_lead_id;
  }

  const leadUuid = buildLeadUuid();

  const inserted = await pool.query(
    `INSERT INTO oti_external_lead (
       lead_uuid, display_name, headline, "current_role", organization, location,
       skills, experience_indicators, profile_completeness, import_status,
       dedup_fingerprint, verified_email_hash, possible_internal_candidate_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'staged',$10,$11,$12)
     RETURNING external_lead_id`,
    [
      leadUuid,
      profile.display_name,
      profile.headline,
      profile.current_role,
      profile.organization,
      profile.location,
      JSON.stringify(profile.skills || []),
      JSON.stringify(profile.experience_indicators || []),
      profile.profile_completeness,
      dedupInfo.fingerprint,
      profile.verified_email ? sha256(profile.verified_email) : null,
      dedupInfo.possible_internal_candidate_id || null
    ]
  );

  return inserted.rows[0].external_lead_id;
}

async function upsertExternalLeadSource(pool, externalLeadId, profile) {
  const existingCount = await pool.query(
    "SELECT COUNT(*)::int AS total FROM oti_external_lead_source WHERE external_lead_id = $1",
    [externalLeadId]
  );
  const isPrimary = (existingCount.rows[0]?.total || 0) === 0;

  await pool.query(
    `INSERT INTO oti_external_lead_source (
       external_lead_id, provider_key, source_record_id, profile_url,
       source_attribution, data_access_permissions, resume_retrieval_permitted,
       licensing_notes, discovered_on, retrieved_on, is_primary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (provider_key, source_record_id)
     DO UPDATE SET
       external_lead_id = EXCLUDED.external_lead_id,
       profile_url = EXCLUDED.profile_url,
       source_attribution = EXCLUDED.source_attribution,
       data_access_permissions = EXCLUDED.data_access_permissions,
       resume_retrieval_permitted = EXCLUDED.resume_retrieval_permitted,
       licensing_notes = EXCLUDED.licensing_notes,
       retrieved_on = EXCLUDED.retrieved_on`,
    [
      externalLeadId,
      profile.provider_key,
      profile.source_record_id,
      profile.profile_url,
      JSON.stringify(profile.source_attribution || {}),
      JSON.stringify(profile.data_access_permissions || {}),
      profile.resume_retrieval_permitted,
      profile.licensing_notes,
      profile.discovered_on,
      profile.retrieved_on,
      isPrimary
    ]
  );
}

async function insertSnapshot(pool, externalLeadId, runId, profile) {
  await pool.query(
    `INSERT INTO oti_external_lead_snapshot (
       external_lead_id, run_id, provider_key, normalized_profile, raw_source_reference
     ) VALUES ($1,$2,$3,$4,$5)`,
    [
      externalLeadId,
      runId,
      profile.provider_key,
      JSON.stringify(profile),
      JSON.stringify(profile.raw_source_reference || {})
    ]
  );
}

async function linkLeadToRun(pool, runId, externalLeadId, profile, explanation, rankOrder) {
  await pool.query(
    `INSERT INTO oti_external_run_lead (
       run_id, external_lead_id, provider_key, rank_order, match_score, match_explanation
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id, external_lead_id)
     DO UPDATE SET
       rank_order = EXCLUDED.rank_order,
       match_score = EXCLUDED.match_score,
       match_explanation = EXCLUDED.match_explanation`,
    [
      runId,
      externalLeadId,
      profile.provider_key,
      rankOrder,
      explanation.match_score,
      JSON.stringify(explanation)
    ]
  );
}

async function stageExternalProfiles(pool, runId, profiles, { structuredQuery, requisition } = {}) {
  const staged = [];

  for (const profile of profiles) {
    const dedupInfo = await classifyDuplicate(pool, profile);
    profile.possible_internal_candidate_id = dedupInfo.possible_internal_candidate_id || null;

    const externalLeadId = await upsertExternalLead(pool, profile, dedupInfo);
    await upsertExternalLeadSource(pool, externalLeadId, profile);
    await insertSnapshot(pool, externalLeadId, runId, profile);

    const explanation = buildExternalMatchExplanation({
      profile,
      structuredQuery,
      requisition
    });

    const leadRow = await pool.query(
      "SELECT lead_uuid FROM oti_external_lead WHERE external_lead_id = $1 LIMIT 1",
      [externalLeadId]
    );

    staged.push({
      external_lead_id: externalLeadId,
      lead_uuid: leadRow.rows[0]?.lead_uuid || null,
      profile,
      explanation,
      dedup: dedupInfo
    });
  }

  staged.sort((left, right) => right.explanation.match_score - left.explanation.match_score);

  staged.forEach((entry, index) => {
    entry.rank_order = index + 1;
  });

  for (const entry of staged) {
    await linkLeadToRun(
      pool,
      runId,
      entry.external_lead_id,
      entry.profile,
      entry.explanation,
      entry.rank_order
    );
  }

  return staged;
}

function mapPublicExternalLead(row, sources = [], actions = []) {
  return {
    external_lead_id: row.external_lead_id,
    lead_uuid: row.lead_uuid,
    display_name: sanitizeCandidateDisplayName(row.display_name),
    headline: row.headline,
    current_role: row.current_role,
    organization: row.organization,
    location: row.location,
    skills: row.skills,
    experience_indicators: row.experience_indicators,
    profile_completeness: Number(row.profile_completeness || 0),
    import_status: row.import_status,
    resume_retrieval_status: row.resume_retrieval_status || "not_requested",
    resume_index_status: row.resume_index_status || "not_indexed",
    possible_internal_candidate_id: row.possible_internal_candidate_id,
    duplicate_reason: row.duplicate_reason,
    sources: sources.map((source) => ({
      provider_key: source.provider_key,
      provider_display_name: providerDisplayName(source.provider_key),
      source_record_id: source.source_record_id,
      profile_url: source.profile_url,
      source_attribution: source.source_attribution,
      data_access_permissions: source.data_access_permissions,
      resume_retrieval_permitted: source.resume_retrieval_permitted,
      licensing_notes: source.licensing_notes,
      discovered_on: source.discovered_on,
      retrieved_on: source.retrieved_on,
      is_primary: source.is_primary
    })),
    recruiter_actions: actions
  };
}

async function listExternalLeadsForRun(pool, runId) {
  const result = await pool.query(
    `SELECT
        rl.run_lead_id,
        rl.rank_order,
        rl.match_score,
        rl.match_explanation,
        rl.provider_key,
        l.external_lead_id,
        l.lead_uuid,
        l.display_name,
        l.headline,
        l."current_role",
        l.organization,
        l.location,
        l.skills,
        l.experience_indicators,
        l.profile_completeness,
        l.import_status,
        l.possible_internal_candidate_id,
        l.duplicate_reason,
        l.resume_retrieval_status,
        l.resume_index_status,
        l.latest_document_id
     FROM oti_external_run_lead rl
     INNER JOIN oti_external_lead l ON l.external_lead_id = rl.external_lead_id
     WHERE rl.run_id = $1
     ORDER BY rl.rank_order ASC`,
    [runId]
  );

  const leads = [];

  for (const row of result.rows) {
    const sources = await pool.query(
      `SELECT provider_key, source_record_id, profile_url, source_attribution,
              data_access_permissions, resume_retrieval_permitted, licensing_notes,
              discovered_on, retrieved_on
       FROM oti_external_lead_source
       WHERE external_lead_id = $1
       ORDER BY is_primary DESC, discovered_on DESC`,
      [row.external_lead_id]
    );

    const actions = await pool.query(
      `SELECT action_type, note, actor_employee_code, created_on
       FROM oti_external_recruiter_action
       WHERE external_lead_id = $1
       ORDER BY created_on DESC`,
      [row.external_lead_id]
    );

    const mapped = mapPublicExternalLead(row, sources.rows, actions.rows);

    let resumeDocument = null;
    if (row.latest_document_id) {
      const docResult = await pool.query(
        `SELECT document_id, storage_key, detected_format, byte_length, provenance
         FROM oti_external_resume_document
         WHERE document_id = $1`,
        [row.latest_document_id]
      );
      const doc = docResult.rows[0];
      if (doc) {
        resumeDocument = {
          document_id: doc.document_id,
          detected_format: doc.detected_format,
          byte_length: doc.byte_length,
          download_path: `/api/v1/recruitment/talent-intelligence/external-leads/${row.external_lead_id}/resume-document`
        };
      }
    }

    leads.push({
      ...mapped,
      profile_url: mapped.sources?.[0]?.profile_url || null,
      provider_key: row.provider_key || mapped.sources?.[0]?.provider_key || null,
      rank_order: row.rank_order,
      match_score: Number(row.match_score || 0),
      match_explanation: row.match_explanation,
      resume_document: resumeDocument
    });
  }

  return prepareQualifyingExternalLeads(leads);
}

async function getExternalLeadById(pool, externalLeadId) {
  const result = await pool.query(
    "SELECT * FROM oti_external_lead WHERE external_lead_id = $1 LIMIT 1",
    [externalLeadId]
  );

  return result.rows[0] || null;
}

async function assertExternalLeadExists(pool, externalLeadId) {
  const lead = await getExternalLeadById(pool, externalLeadId);
  if (!lead) {
    throw httpError("External lead not found.", 404);
  }

  return lead;
}

module.exports = {
  stageExternalProfiles,
  upsertExternalLead,
  upsertExternalLeadSource,
  insertSnapshot,
  linkLeadToRun,
  listExternalLeadsForRun,
  getExternalLeadById,
  assertExternalLeadExists,
  mapPublicExternalLead
};
