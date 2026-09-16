/**
 * Canonical draft candidate creation and resume-to-profile updates for cand_mstr.
 * Shared by Candidate Portal registration/profile and recruiter intake parse.
 */

const { allocateNextCandidateCode } = require("../utils/candidateCodeGenerator");

const PORTAL_SOURCE_CODE = "PORTAL";
const PORTAL_SOURCE_REFERENCE_PREFIX = "portal-candidate:";

function parsePortalSourceReference(sourceReference) {
  if (
    typeof sourceReference !== "string" ||
    !sourceReference.startsWith(PORTAL_SOURCE_REFERENCE_PREFIX)
  ) {
    return null;
  }

  const candidateId = Number(
    sourceReference.slice(PORTAL_SOURCE_REFERENCE_PREFIX.length)
  );

  return Number.isFinite(candidateId) ? candidateId : null;
}

async function findCandidateByEmail(client, emailId, { forUpdate = false } = {}) {
  const normalized = String(emailId || "").trim();

  if (!normalized) {
    return null;
  }

  const lockClause = forUpdate ? "FOR UPDATE" : "";

  const result = await client.query(
    `
    SELECT
      candidate_id,
      candidate_code,
      first_name,
      last_name,
      email_id,
      mobile_number,
      candidate_status,
      profile_completion,
      resume_path,
      candidate_source_code
    FROM cand_mstr
    WHERE LOWER(email_id) = LOWER($1)
    LIMIT 1
    ${lockClause}
    `,
    [normalized]
  );

  return result.rows[0] || null;
}

async function createPortalDraftCandidate(
  client,
  { fullName, emailId, mobileNumber, sourceId = null, splitFullName }
) {
  const { first_name, last_name } = splitFullName(fullName);
  const candidateCode = await allocateNextCandidateCode(client);

  const result = await client.query(
    `
    INSERT INTO cand_mstr (
      candidate_code,
      first_name,
      last_name,
      email_id,
      mobile_number,
      source_channel,
      candidate_source_code,
      candidate_status,
      remarks,
      created_by
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10
    )
    RETURNING candidate_id, candidate_code, candidate_status, profile_completion
    `,
    [
      candidateCode,
      first_name,
      last_name,
      emailId,
      mobileNumber,
      sourceId,
      PORTAL_SOURCE_CODE,
      "DRAFT",
      "Created via Candidate Portal registration",
      "CANDIDATE_PORTAL"
    ]
  );

  return result.rows[0];
}

async function insertRecruiterDraftFromParsed(
  client,
  {
    intake,
    parsedCandidate,
    createdBy,
    splitCandidateName,
    normalizeExperience
  }
) {
  const { first_name, last_name } = splitCandidateName(parsedCandidate.candidate_name);

  const skillsList = Array.isArray(parsedCandidate.skills)
    ? parsedCandidate.skills
    : [];
  const primary_skill = skillsList.length > 0 ? skillsList.join(", ") : null;

  const remarksParts = [];

  if (parsedCandidate.education) {
    remarksParts.push(`Education: ${parsedCandidate.education}`);
  }

  remarksParts.push(`Intake ID: ${intake.intake_id}`);

  if (intake.original_file_name) {
    remarksParts.push(`Original File: ${intake.original_file_name}`);
  }

  const emailId = parsedCandidate.email
    ? String(parsedCandidate.email).trim()
    : null;
  const candidateCode = await allocateNextCandidateCode(client);

  const result = await client.query(
    `
    INSERT INTO cand_mstr (
      candidate_code,
      first_name,
      last_name,
      email_id,
      mobile_number,
      total_experience,
      primary_skill,
      resume_path,
      source_channel,
      candidate_status,
      recruiter_id,
      remarks,
      created_by
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13
    )
    RETURNING candidate_id
    `,
    [
      candidateCode,
      first_name,
      last_name,
      emailId || null,
      parsedCandidate.mobile || null,
      normalizeExperience(parsedCandidate.experience),
      primary_skill,
      intake.resume_path || null,
      intake.source_id || null,
      "DRAFT",
      createdBy || null,
      remarksParts.join(" | "),
      createdBy || null
    ]
  );

  return result.rows[0].candidate_id;
}

async function applyParsedResumeToDraftCandidate(
  client,
  candidateId,
  parsedCandidate,
  resumePath,
  { splitCandidateName, normalizeExperience }
) {
  const { first_name, last_name } = splitCandidateName(
    parsedCandidate.candidate_name
  );

  const skillsList = Array.isArray(parsedCandidate.skills)
    ? parsedCandidate.skills
    : [];
  const primarySkill = skillsList.length > 0 ? skillsList.join(", ") : null;

  const result = await client.query(
    `
    UPDATE cand_mstr
    SET
      first_name = COALESCE(NULLIF($1, ''), first_name),
      last_name = COALESCE(NULLIF($2, ''), last_name),
      mobile_number = COALESCE(NULLIF($3, ''), mobile_number),
      total_experience = COALESCE($4, total_experience),
      primary_skill = COALESCE(NULLIF($5, ''), primary_skill),
      resume_path = COALESCE($6, resume_path),
      resume_uploaded_on = CASE
        WHEN $6 IS NOT NULL THEN NOW()
        ELSE resume_uploaded_on
      END,
      updated_on = NOW()
    WHERE candidate_id = $7
      AND UPPER(candidate_status) = 'DRAFT'
    RETURNING *
    `,
    [
      first_name,
      last_name,
      parsedCandidate.mobile || null,
      normalizeExperience(parsedCandidate.experience),
      primarySkill,
      resumePath || null,
      candidateId
    ]
  );

  if (result.rows.length === 0) {
    throw new Error("Candidate profile cannot be updated in the current status.");
  }

  return result.rows[0];
}

async function createDraftCandidateFromParsedIntake({
  pool,
  intake,
  parsedCandidate,
  createdBy,
  splitCandidateName,
  normalizeExperience
}) {
  const portalCandidateId = parsePortalSourceReference(intake.source_reference);

  if (portalCandidateId) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await applyParsedResumeToDraftCandidate(
        client,
        portalCandidateId,
        parsedCandidate,
        intake.resume_path,
        { splitCandidateName, normalizeExperience }
      );
      await client.query("COMMIT");

      return {
        outcome: "CREATED",
        candidate_id: portalCandidateId
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const emailId = parsedCandidate.email
    ? String(parsedCandidate.email).trim()
    : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (emailId) {
      const existing = await findCandidateByEmail(client, emailId, {
        forUpdate: true
      });

      if (existing) {
        await client.query("COMMIT");

        return {
          outcome: "DUPLICATE",
          duplicate_candidate: {
            candidate_id: existing.candidate_id,
            candidate_code: existing.candidate_code,
            first_name: existing.first_name,
            last_name: existing.last_name,
            candidate_status: existing.candidate_status,
            email_id: existing.email_id
          }
        };
      }
    }

    const candidateId = await insertRecruiterDraftFromParsed(client, {
      intake,
      parsedCandidate,
      createdBy,
      splitCandidateName,
      normalizeExperience
    });

    await client.query("COMMIT");

    return {
      outcome: "CREATED",
      candidate_id: candidateId
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PORTAL_SOURCE_CODE,
  PORTAL_SOURCE_REFERENCE_PREFIX,
  parsePortalSourceReference,
  findCandidateByEmail,
  createPortalDraftCandidate,
  applyParsedResumeToDraftCandidate,
  createDraftCandidateFromParsedIntake
};
