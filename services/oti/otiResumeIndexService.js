/**
 * OTI Phase 2 — resume indexing, job queue foundation, status API backing.
 */

const candidateAccessService = require("../candidateAccessService");
const masterDataService = require("../masterDataService");
const { splitSkillTokens } = require("../resumeMatchService");
const otiCapabilityAuth = require("./otiCapabilityAuth");
const otiResumeStorageService = require("./otiResumeStorageService");
const otiResumeExtractionService = require("./otiResumeExtractionService");
const {
  hashResumeContent,
  truncateForIndex,
  normalizeResumeText
} = require("./otiResumeTextUtils");

const RETRY_BACKOFF_MINUTES = [5, 15, 60];

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function recordIndexEvent(pool, candidateId, eventType, status, message, contentHash) {
  await pool.query(
    `INSERT INTO oti_resume_index_event (
       candidate_id, event_type, status, message, content_hash
     ) VALUES ($1,$2,$3,$4,$5)`,
    [candidateId, eventType, status, message || null, contentHash || null]
  );
}

async function ensureIndexRow(pool, candidateId) {
  const existing = await pool.query(
    "SELECT * FROM oti_resume_index WHERE candidate_id = $1 LIMIT 1",
    [candidateId]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const inserted = await pool.query(
    `INSERT INTO oti_resume_index (candidate_id, extraction_status)
     VALUES ($1, 'pending')
     RETURNING *`,
    [candidateId]
  );

  return inserted.rows[0];
}

function extractSkillsFromText(text, publishedSkills) {
  const normalized = normalizeResumeText(text).toLowerCase();
  const found = [];
  const seen = new Set();

  for (const record of publishedSkills || []) {
    const name = String(record.name || "").trim();
    const code = String(record.code || "").trim();

    if (!name) {
      continue;
    }

    const nameKey = name.toLowerCase();
    if (seen.has(nameKey)) {
      continue;
    }

    if (normalized.includes(nameKey)) {
      seen.add(nameKey);
      found.push({ code, name });
    }
  }

  return found;
}

async function loadExperienceHighlights(pool, candidateId) {
  const result = await pool.query(
    `SELECT designation, company_name, joining_date, relieving_date
     FROM can_experience
     WHERE candidate_id = $1
       AND COALESCE(active_flag, TRUE) = TRUE
     ORDER BY joining_date DESC NULLS LAST
     LIMIT 5`,
    [candidateId]
  );

  return result.rows.map((row) => ({
    designation: row.designation || null,
    company_name: row.company_name || null
  }));
}

async function loadPublishedSkills(pool) {
  const records = await masterDataService.listByEntityType(pool, "skills");
  return records.filter(
    (record) =>
      String(record?.status || "").trim() === "Active" &&
      String(record?.versionStatus || record?.version_status || "").trim() ===
        "Published"
  );
}

async function upsertIndexedDocument(pool, candidateId, payload) {
  const existing = await pool.query(
    "SELECT index_id FROM oti_resume_index WHERE candidate_id = $1 LIMIT 1",
    [candidateId]
  );

  const params = [
    payload.resume_path,
    payload.content_hash,
    payload.extraction_status,
    payload.failure_reason,
    payload.extracted_text,
    payload.search_text,
    JSON.stringify(payload.extracted_skills || []),
    JSON.stringify(payload.experience_highlights || []),
    JSON.stringify(payload.role_highlights || []),
    payload.text_length,
    payload.byte_length,
    candidateId
  ];

  if (existing.rows[0]) {
    await pool.query(
      `UPDATE oti_resume_index
       SET resume_path = $1,
           content_hash = $2,
           extraction_status = $3,
           failure_reason = $4,
           extracted_text = $5,
           search_text = $6,
           search_vector = to_tsvector('english', COALESCE($6, '')),
           extracted_skills = $7,
           experience_highlights = $8,
           role_highlights = $9,
           text_length = $10,
           byte_length = $11,
           version_num = version_num + 1,
           indexed_on = CASE WHEN $3 = 'indexed' THEN NOW() ELSE indexed_on END,
           last_attempt_on = NOW(),
           attempt_count = attempt_count + 1,
           updated_on = NOW()
       WHERE candidate_id = $12`,
      params
    );
    return;
  }

  await pool.query(
    `INSERT INTO oti_resume_index (
       candidate_id, entity_type, resume_path, content_hash, extraction_status,
       failure_reason, extracted_text, search_text, search_vector,
       extracted_skills, experience_highlights, role_highlights,
       text_length, byte_length, version_num, indexed_on, last_attempt_on, attempt_count
     ) VALUES (
       $12, 'internal', $1, $2, $3, $4, $5, $6,
       to_tsvector('english', COALESCE($6, '')),
       $7, $8, $9, $10, $11, 1,
       CASE WHEN $3 = 'indexed' THEN NOW() ELSE NULL END,
       NOW(), 1
     )`,
    params
  );
}

async function markIndexFailure(pool, candidateId, status, reason, resumePath, contentHash) {
  await upsertIndexedDocument(pool, candidateId, {
    resume_path: resumePath || null,
    content_hash: contentHash || null,
    extraction_status: status,
    failure_reason: reason,
    extracted_text: null,
    search_text: null,
    extracted_skills: [],
    experience_highlights: [],
    role_highlights: [],
    text_length: 0,
    byte_length: 0
  });

  await recordIndexEvent(pool, candidateId, "index_failed", status, reason, contentHash);
}

async function performIndexForCandidate(pool, candidateId, deps = {}) {
  const downloadResume = deps.downloadResumeBuffer || otiResumeStorageService.downloadResumeBuffer;
  const extractResume = deps.extractResumeText || otiResumeExtractionService.extractResumeText;

  const candidateResult = await pool.query(
    `SELECT candidate_id, resume_path, primary_skill, secondary_skill, current_designation
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );

  const candidate = candidateResult.rows[0];
  if (!candidate) {
    throw httpError("Candidate not found.", 404);
  }

  await ensureIndexRow(pool, candidateId);

  const resumePath = String(candidate.resume_path || "").trim();
  if (!resumePath) {
    await markIndexFailure(pool, candidateId, "skipped", "No resume_path on candidate record.", null, null);
    return getPublicIndexStatus(pool, candidateId);
  }

  await pool.query(
    `UPDATE oti_resume_index
     SET extraction_status = 'processing', updated_on = NOW()
     WHERE candidate_id = $1`,
    [candidateId]
  );

  let buffer;

  try {
    buffer = await downloadResume(resumePath);
  } catch (error) {
    await markIndexFailure(
      pool,
      candidateId,
      "failed",
      error.message || "Resume download failed.",
      resumePath,
      null
    );
    return getPublicIndexStatus(pool, candidateId);
  }

  const contentHash = hashResumeContent(buffer);
  const existing = await pool.query(
    "SELECT content_hash, extraction_status FROM oti_resume_index WHERE candidate_id = $1",
    [candidateId]
  );

  if (
    existing.rows[0]?.content_hash === contentHash &&
    existing.rows[0]?.extraction_status === "indexed"
  ) {
    await recordIndexEvent(pool, candidateId, "index_skipped", "indexed", "Content hash unchanged.", contentHash);
    return getPublicIndexStatus(pool, candidateId);
  }

  const extraction = await extractResume({ resumePath, buffer });

  if (!extraction.ok) {
    await markIndexFailure(
      pool,
      candidateId,
      extraction.status,
      extraction.reason,
      resumePath,
      contentHash
    );
    return getPublicIndexStatus(pool, candidateId);
  }

  const searchText = truncateForIndex(extraction.text);
  const publishedSkills = await loadPublishedSkills(pool);
  const extractedSkills = extractSkillsFromText(searchText, publishedSkills);
  const experienceHighlights = await loadExperienceHighlights(pool, candidateId);

  const roleHighlights = [];
  if (candidate.current_designation) {
    roleHighlights.push({ designation: candidate.current_designation, source: "cand_mstr" });
  }

  for (const token of splitSkillTokens(candidate.primary_skill)) {
    if (token) {
      roleHighlights.push({ skill: token, source: "primary_skill" });
    }
  }

  await upsertIndexedDocument(pool, candidateId, {
    resume_path: resumePath,
    content_hash: contentHash,
    extraction_status: "indexed",
    failure_reason: null,
    extracted_text: searchText,
    search_text: searchText,
    extracted_skills: extractedSkills,
    experience_highlights: experienceHighlights,
    role_highlights: roleHighlights,
    text_length: searchText.length,
    byte_length: buffer.length
  });

  await recordIndexEvent(pool, candidateId, "index_success", "indexed", null, contentHash);

  return getPublicIndexStatus(pool, candidateId);
}

function mapPublicStatus(row) {
  if (!row) {
    return {
      candidate_id: null,
      extraction_status: "not_indexed",
      indexed_on: null,
      failure_reason: null,
      content_hash: null,
      version_num: 0,
      attempt_count: 0,
      text_length: 0
    };
  }

  return {
    candidate_id: row.candidate_id,
    extraction_status: row.extraction_status,
    indexed_on: row.indexed_on,
    failure_reason: row.failure_reason,
    content_hash: row.content_hash,
    version_num: row.version_num,
    attempt_count: row.attempt_count,
    text_length: row.text_length,
    extracted_skill_count: Array.isArray(row.extracted_skills)
      ? row.extracted_skills.length
      : JSON.parse(row.extracted_skills || "[]").length
  };
}

async function getPublicIndexStatus(pool, candidateId) {
  const result = await pool.query(
    `SELECT candidate_id, extraction_status, indexed_on, failure_reason, content_hash,
            version_num, attempt_count, text_length, extracted_skills
     FROM oti_resume_index
     WHERE candidate_id = $1`,
    [candidateId]
  );

  return mapPublicStatus(result.rows[0] || null);
}

async function assertCanManageCandidateIndex(pool, req, candidateId) {
  await otiCapabilityAuth.assertOtiFeatureEnabled(pool);
  await candidateAccessService.assertCandidateReadAccess(pool, req, candidateId);
}

async function enqueueIndexJob(pool, candidateId) {
  await pool.query(
    `INSERT INTO oti_index_job (candidate_id, job_type, status, next_run_at)
     VALUES ($1, 'index_resume', 'queued', NOW())`,
    [candidateId]
  );
}

async function queueAndProcessIndex(pool, candidateId, req, deps = {}) {
  await assertCanManageCandidateIndex(pool, req, candidateId);
  await ensureIndexRow(pool, candidateId);
  await enqueueIndexJob(pool, candidateId);
  return performIndexForCandidate(pool, candidateId, deps);
}

async function retryIndex(pool, candidateId, req, deps = {}) {
  await assertCanManageCandidateIndex(pool, req, candidateId);
  await ensureIndexRow(pool, candidateId);
  await enqueueIndexJob(pool, candidateId);
  return performIndexForCandidate(pool, candidateId, deps);
}

async function processPendingIndexJobs(pool, { limit = 10 } = {}, deps = {}) {
  const result = await pool.query(
    `SELECT job_id, candidate_id, attempts, max_attempts
     FROM oti_index_job
     WHERE status IN ('queued', 'retry')
       AND next_run_at <= NOW()
       AND (locked_until IS NULL OR locked_until <= NOW())
     ORDER BY next_run_at ASC, job_id ASC
     LIMIT $1`,
    [limit]
  );

  const processed = [];

  for (const job of result.rows) {
    await pool.query(
      `UPDATE oti_index_job
       SET status = 'processing', locked_until = NOW() + INTERVAL '5 minutes', updated_on = NOW()
       WHERE job_id = $1`,
      [job.job_id]
    );

    try {
      await ensureIndexRow(pool, job.candidate_id);
      await performIndexForCandidate(pool, job.candidate_id, deps);
      await pool.query(
        `UPDATE oti_index_job SET status = 'completed', updated_on = NOW() WHERE job_id = $1`,
        [job.job_id]
      );
      processed.push({ job_id: job.job_id, status: "completed" });
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const maxAttempts = Number(job.max_attempts || 3);
      const backoff = RETRY_BACKOFF_MINUTES[Math.min(attempts - 1, RETRY_BACKOFF_MINUTES.length - 1)];

      const nextStatus = attempts >= maxAttempts ? "failed" : "retry";

      await pool.query(
        `UPDATE oti_index_job
         SET status = $2,
             attempts = $3,
             last_error = $4,
             next_run_at = NOW() + ($5 || ' minutes')::interval,
             locked_until = NULL,
             updated_on = NOW()
         WHERE job_id = $1`,
        [job.job_id, nextStatus, attempts, error.message, String(backoff)]
      );

      processed.push({ job_id: job.job_id, status: nextStatus });
    }
  }

  return processed;
}

module.exports = {
  performIndexForCandidate,
  queueAndProcessIndex,
  retryIndex,
  getPublicIndexStatus,
  assertCanManageCandidateIndex,
  processPendingIndexJobs,
  extractSkillsFromText
};
