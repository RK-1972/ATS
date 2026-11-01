/**
 * Retrieves publicly accessible resume documents (HTTPS), stores in R2, indexes and scores content.
 */

const { URL } = require("url");
const { connectorFetchBuffer } = require("./connectors/createHttpConnector");
const { validateResumeDocument } = require("./otiResumeDocumentValidation");
const otiResumeStorageService = require("./otiResumeStorageService");
const otiExternalResumeIndexService = require("./otiExternalResumeIndexService");
const otiExternalLeadService = require("./otiExternalLeadService");
const { classifyDuplicate } = require("./otiExternalDedupService");
const { buildExternalMatchExplanation } = require("./otiExternalExplainService");
const { isQualifyingExternalLead } = require("./otiRecommendationQualification");
const { normalizeResumeText } = require("./otiResumeTextUtils");
const { parseBasicCandidateInfo } = require("../../utils/parseBasicCandidateInfo");
const otiCapabilityAuth = require("./otiCapabilityAuth");

const INGEST_FAILURE_CATEGORY = "ingest";
const REUSE_QUALIFICATION_FAILURE_CATEGORY = "reuse_qualification";

const BLOCKED_HOSTS =
  /(^|\.)((linkedin|facebook|instagram|twitter|x)\.com|localhost|127\.0\.0\.1)$/i;

function assertPublicResumeUrl(profileUrl) {
  let parsed;

  try {
    parsed = new URL(String(profileUrl || "").trim());
  } catch {
    throw new Error("Resume URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS resume URLs are permitted.");
  }

  if (BLOCKED_HOSTS.test(parsed.hostname)) {
    throw new Error("Resume host is not permitted for direct public retrieval.");
  }

  return parsed;
}

function filenameHintFromUrl(parsedUrl) {
  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1] || "resume.pdf");
}

async function downloadPublicResumeBuffer(profileUrl) {
  const parsed = assertPublicResumeUrl(profileUrl);
  const response = await connectorFetchBuffer(parsed.toString(), { method: "GET" });

  if (!response.ok) {
    throw new Error(`Public resume download failed (${response.status}).`);
  }

  return {
    buffer: response.buffer,
    filename_hint: filenameHintFromUrl(parsed)
  };
}

function inferCandidateNameFromResumeText(text) {
  return parseBasicCandidateInfo(text).candidate_name;
}

async function persistPublicDocument(pool, externalLeadId, providerKey, validation, storageKey, provenance) {
  const duplicate = await pool.query(
    `SELECT document_id, storage_key, content_hash, detected_format, byte_length
     FROM oti_external_resume_document
     WHERE external_lead_id = $1 AND content_hash = $2 LIMIT 1`,
    [externalLeadId, validation.content_hash]
  );

  if (duplicate.rows[0]) {
    return duplicate.rows[0];
  }

  const insert = await pool.query(
    `INSERT INTO oti_external_resume_document (
       external_lead_id, grant_id, provider_key, storage_key, content_hash,
       mime_type, detected_format, byte_length, provenance
     ) VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      externalLeadId,
      providerKey,
      storageKey,
      validation.content_hash,
      validation.mime,
      validation.format,
      validation.byte_length,
      JSON.stringify(provenance || {})
    ]
  );

  return insert.rows[0];
}

async function loadExtractedSkills(pool, externalLeadId) {
  const result = await pool.query(
    `SELECT extracted_skills, extraction_status
     FROM oti_external_resume_index
     WHERE external_lead_id = $1`,
    [externalLeadId]
  );

  const row = result.rows[0];
  if (!row || row.extraction_status !== "indexed") {
    return [];
  }

  const raw = row.extracted_skills;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;

  return (parsed || []).map((skill) => String(skill?.name || skill?.code || skill || "").trim()).filter(Boolean);
}

async function reuseIndexedExternalLead(
  pool,
  runId,
  profile,
  dedupInfo,
  { structuredQuery, requisition }
) {
  if (!dedupInfo.duplicate || !dedupInfo.existing_lead_id) {
    return null;
  }

  const indexState =
    dedupInfo.existing_resume_index_status && dedupInfo.existing_latest_document_id
      ? {
          resume_index_status: dedupInfo.existing_resume_index_status,
          latest_document_id: dedupInfo.existing_latest_document_id
        }
      : (
          await pool.query(
            `SELECT resume_index_status, latest_document_id
             FROM oti_external_lead WHERE external_lead_id = $1 LIMIT 1`,
            [dedupInfo.existing_lead_id]
          )
        ).rows[0] || {};

  if (indexState.resume_index_status !== "indexed" || !indexState.latest_document_id) {
    return null;
  }

  dedupInfo.existing_latest_document_id = indexState.latest_document_id;

  const externalLeadId = dedupInfo.existing_lead_id;
  profile.possible_internal_candidate_id = dedupInfo.possible_internal_candidate_id || null;

  const extractedSkills = await loadExtractedSkills(pool, externalLeadId);
  if (extractedSkills.length) {
    profile.skills = extractedSkills;
  }

  profile.resume_index_status = indexState.resume_index_status || "indexed";
  profile.resume_qualified = true;
  profile.source_surface_type = profile.source_surface_type || "public_resume";
  profile.resume_availability = profile.resume_availability || "resume_available";
  profile.candidate_evidence = profile.candidate_evidence?.length
    ? profile.candidate_evidence
    : ["public_resume_document_url"];

  await otiExternalLeadService.upsertExternalLead(pool, profile, dedupInfo);
  await otiExternalLeadService.upsertExternalLeadSource(pool, externalLeadId, profile);
  await otiExternalLeadService.insertSnapshot(pool, externalLeadId, runId, profile);

  const leadRow = await pool.query(
    `SELECT lead_uuid, display_name, headline, skills, resume_index_status
     FROM oti_external_lead WHERE external_lead_id = $1 LIMIT 1`,
    [externalLeadId]
  );
  const lead = leadRow.rows[0] || {};

  profile.skills =
    typeof lead.skills === "string"
      ? JSON.parse(lead.skills)
      : lead.skills || profile.skills || extractedSkills || [];
  profile.display_name = lead.display_name || profile.display_name;
  profile.headline = lead.headline || profile.headline;
  profile.resume_index_status = lead.resume_index_status || "indexed";

  const explanation = buildExternalMatchExplanation({
    profile,
    structuredQuery,
    requisition
  });

  const qualifying = isQualifyingExternalLead({
    match_score: explanation.match_score,
    match_explanation: explanation,
    resume_index_status: "indexed"
  });

  if (!qualifying) {
    return {
      skipped: true,
      failure_category: REUSE_QUALIFICATION_FAILURE_CATEGORY,
      reason: "Merged lead did not meet minimum qualification threshold.",
      external_lead_id: externalLeadId,
      profile_url: profile.profile_url,
      provider_key: profile.provider_key,
      match_score: explanation.match_score
    };
  }

  return {
    external_lead_id: externalLeadId,
    lead_uuid: lead.lead_uuid || null,
    profile,
    explanation,
    dedup: dedupInfo,
    document_id: dedupInfo.existing_latest_document_id,
    merged_from_existing_lead: true
  };
}

async function processDiscoveredResumeDocument(
  pool,
  runId,
  profile,
  { structuredQuery, requisition } = {},
  deps = {}
) {
  const downloadFn = deps.downloadPublicResumeBuffer || downloadPublicResumeBuffer;
  const indexFn = deps.indexExternalLeadDocument || otiExternalResumeIndexService.indexExternalLeadDocument;
  const uploadFn = deps.uploadResumeBuffer || otiResumeStorageService.uploadResumeBuffer.bind(otiResumeStorageService);
  const profileUrl = profile.profile_url;
  if (!profileUrl) {
    return null;
  }

  const dedupInfo = await classifyDuplicate(pool, profile);
  const reused = await reuseIndexedExternalLead(pool, runId, profile, dedupInfo, {
    structuredQuery,
    requisition
  });

  if (reused) {
    return reused;
  }

  let download;

  try {
    download = await downloadFn(profileUrl);
  } catch (error) {
    return {
      skipped: true,
      failure_category: INGEST_FAILURE_CATEGORY,
      reason: error.message,
      profile_url: profileUrl,
      provider_key: profile.provider_key
    };
  }

  const validation = validateResumeDocument(download.buffer, {
    filenameHint: download.filename_hint,
    allowedFormats: ["pdf", "doc", "docx"]
  });

  if (!validation.ok) {
    return {
      skipped: true,
      failure_category: INGEST_FAILURE_CATEGORY,
      reason: validation.reason,
      profile_url: profileUrl,
      provider_key: profile.provider_key
    };
  }

  profile.possible_internal_candidate_id = dedupInfo.possible_internal_candidate_id || null;
  profile.discovery_kind = "resume_candidate";
  profile.resume_retrieval_permitted = false;
  profile.source_surface_type = "public_resume";
  profile.resume_availability = "resume_available";

  const externalLeadId = await otiExternalLeadService.upsertExternalLead(pool, profile, dedupInfo);
  await otiExternalLeadService.upsertExternalLeadSource(pool, externalLeadId, profile);
  await otiExternalLeadService.insertSnapshot(pool, externalLeadId, runId, profile);

  const storageKey = otiResumeStorageService.buildExternalResumeObjectKey(
    externalLeadId,
    validation.content_hash,
    validation.format
  );

  try {
    await uploadFn(storageKey, download.buffer, validation.mime);
  } catch (error) {
    return {
      skipped: true,
      failure_category: INGEST_FAILURE_CATEGORY,
      reason: error.message || "Resume storage failed.",
      profile_url: profileUrl
    };
  }

  const documentRow = await persistPublicDocument(pool, externalLeadId, profile.provider_key, validation, storageKey, {
    retrieval_method: "public_https",
    source_url: profileUrl,
    filename_hint: download.filename_hint
  });

  await pool.query(
    `UPDATE oti_external_lead
     SET resume_retrieval_status = 'completed',
         latest_document_id = $2,
         updated_on = NOW()
     WHERE external_lead_id = $1`,
    [externalLeadId, documentRow.document_id]
  );

  await indexFn(pool, externalLeadId, documentRow, deps);

  const extractedSkills = await loadExtractedSkills(pool, externalLeadId);
  const indexTextRow = await pool.query(
    "SELECT extracted_text FROM oti_external_resume_index WHERE external_lead_id = $1",
    [externalLeadId]
  );
  const extractedText = indexTextRow.rows[0]?.extracted_text || "";
  const parsedIdentity = parseBasicCandidateInfo(extractedText);
  const inferredName = parsedIdentity.candidate_name;

  profile.skills = extractedSkills;
  profile.resume_index_status = "indexed";
  profile.resume_qualified = true;
  profile.display_name = inferredName;

  await pool.query(
    `UPDATE oti_external_lead
     SET display_name = $2,
         headline = COALESCE($3, headline),
         skills = $4,
         resume_index_status = 'indexed',
         updated_on = NOW()
     WHERE external_lead_id = $1`,
    [externalLeadId, profile.display_name, profile.headline, JSON.stringify(extractedSkills)]
  );

  const explanation = buildExternalMatchExplanation({
    profile,
    structuredQuery,
    requisition
  });

  const leadRow = await pool.query(
    "SELECT lead_uuid FROM oti_external_lead WHERE external_lead_id = $1 LIMIT 1",
    [externalLeadId]
  );

  const entry = {
    external_lead_id: externalLeadId,
    lead_uuid: leadRow.rows[0]?.lead_uuid || null,
    profile,
    explanation,
    dedup: dedupInfo,
    document_id: documentRow.document_id,
    storage_key: storageKey
  };

  const qualifying = isQualifyingExternalLead({
    match_score: explanation.match_score,
    match_explanation: explanation,
    resume_index_status: "indexed"
  });

  if (!qualifying) {
    return {
      skipped: true,
      failure_category: INGEST_FAILURE_CATEGORY,
      reason: "Resume indexed but did not meet minimum qualification threshold.",
      external_lead_id: externalLeadId,
      profile_url: profileUrl,
      match_score: explanation.match_score
    };
  }

  return entry;
}

async function getExternalLeadResumeDocument(pool, externalLeadId, req, body = {}) {
  await otiCapabilityAuth.assertExternalLeadAccessible(pool, req, externalLeadId, body);
  await otiExternalLeadService.assertExternalLeadExists(pool, externalLeadId);

  const result = await pool.query(
    `SELECT d.document_id, d.storage_key, d.detected_format, d.mime_type, d.byte_length
     FROM oti_external_lead l
     INNER JOIN oti_external_resume_document d ON d.document_id = l.latest_document_id
     WHERE l.external_lead_id = $1`,
    [externalLeadId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("No retrieved resume document is available for this external lead.");
  }

  const buffer = await otiResumeStorageService.downloadResumeBuffer(row.storage_key);

  return {
    document_id: row.document_id,
    detected_format: row.detected_format,
    mime_type: row.mime_type,
    byte_length: row.byte_length,
    buffer
  };
}

async function restoreExternalLeadSkillsFromIndex(pool, externalLeadId) {
  const skills = await loadExtractedSkills(pool, externalLeadId);

  if (!skills.length) {
    return {
      external_lead_id: externalLeadId,
      restored: false,
      reason: "no_indexed_skills"
    };
  }

  await pool.query(
    `UPDATE oti_external_lead
     SET skills = $2, updated_on = NOW()
     WHERE external_lead_id = $1`,
    [externalLeadId, JSON.stringify(skills)]
  );

  return {
    external_lead_id: externalLeadId,
    restored: true,
    skill_count: skills.length,
    skills
  };
}

module.exports = {
  assertPublicResumeUrl,
  downloadPublicResumeBuffer,
  inferCandidateNameFromResumeText,
  processDiscoveredResumeDocument,
  restoreExternalLeadSkillsFromIndex,
  getExternalLeadResumeDocument,
  INGEST_FAILURE_CATEGORY,
  REUSE_QUALIFICATION_FAILURE_CATEGORY
};
