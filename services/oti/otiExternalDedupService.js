/**
 * External lead duplicate detection — no identity assumptions from name alone.
 */

const crypto = require("crypto");
const { normalizeProfileUrl } = require("./otiExternalProfileNormalizer");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function buildProviderFingerprint(profile) {
  return sha256(`${profile.provider_key}:${profile.source_record_id}`);
}

function buildProfileUrlFingerprint(profileUrl) {
  const normalized = normalizeProfileUrl(profileUrl);
  if (!normalized) {
    return null;
  }

  return sha256(`profile_url:${normalized}`);
}

function buildEmailFingerprint(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return null;
  }

  return sha256(`email:${normalized}`);
}

function choosePrimaryFingerprint(profile) {
  return (
    buildProviderFingerprint(profile) ||
    buildProfileUrlFingerprint(profile.profile_url) ||
    buildEmailFingerprint(profile.verified_email) ||
    sha256(JSON.stringify({ provider_key: profile.provider_key, source_record_id: profile.source_record_id }))
  );
}

async function findInternalCandidateByVerifiedEmail(pool, verifiedEmail) {
  const emailHash = buildEmailFingerprint(verifiedEmail);
  if (!emailHash) {
    return null;
  }

  const email = String(verifiedEmail).trim().toLowerCase();

  const result = await pool.query(
    `SELECT candidate_id, candidate_code, first_name, last_name, email_id
     FROM cand_mstr
     WHERE LOWER(TRIM(email_id)) = $1
        OR LOWER(TRIM(alternate_email)) = $1
     LIMIT 1`,
    [email]
  );

  return result.rows[0] || null;
}

async function findExistingLeadByFingerprint(pool, fingerprint) {
  const result = await pool.query(
    `SELECT external_lead_id, lead_uuid, dedup_fingerprint, import_status
     FROM oti_external_lead
     WHERE dedup_fingerprint = $1
     LIMIT 1`,
    [fingerprint]
  );

  return result.rows[0] || null;
}

async function findExistingLeadByProviderRecord(pool, providerKey, sourceRecordId) {
  const result = await pool.query(
    `SELECT l.external_lead_id, l.lead_uuid, l.dedup_fingerprint, l.import_status
     FROM oti_external_lead_source s
     INNER JOIN oti_external_lead l ON l.external_lead_id = s.external_lead_id
     WHERE s.provider_key = $1 AND s.source_record_id = $2
     LIMIT 1`,
    [providerKey, sourceRecordId]
  );

  return result.rows[0] || null;
}

async function findExistingLeadByNormalizedProfileUrl(pool, profileUrl) {
  const normalizedTarget = normalizeProfileUrl(profileUrl);

  if (!normalizedTarget) {
    return null;
  }

  const result = await pool.query(
    `SELECT s.external_lead_id, s.profile_url, l.lead_uuid, l.resume_index_status, l.latest_document_id
     FROM oti_external_lead_source s
     INNER JOIN oti_external_lead l ON l.external_lead_id = s.external_lead_id
     WHERE s.profile_url IS NOT NULL
     ORDER BY s.discovered_on DESC
     LIMIT 250`
  );

  for (const row of result.rows) {
    if (normalizeProfileUrl(row.profile_url) === normalizedTarget) {
      return row;
    }
  }

  return null;
}

async function classifyDuplicate(pool, profile) {
  const fingerprint = choosePrimaryFingerprint(profile);
  const byProvider = await findExistingLeadByProviderRecord(
    pool,
    profile.provider_key,
    profile.source_record_id
  );

  if (byProvider) {
    return {
      fingerprint,
      duplicate: true,
      duplicate_reason: "same_provider_record",
      existing_lead_id: byProvider.external_lead_id,
      existing_lead_uuid: byProvider.lead_uuid
    };
  }

  if (profile.profile_url) {
    const byUrl = await findExistingLeadByNormalizedProfileUrl(pool, profile.profile_url);

    if (byUrl) {
      return {
        fingerprint,
        duplicate: true,
        duplicate_reason: "same_public_resume_url",
        existing_lead_id: byUrl.external_lead_id,
        existing_lead_uuid: byUrl.lead_uuid,
        existing_resume_index_status: byUrl.resume_index_status,
        existing_latest_document_id: byUrl.latest_document_id
      };
    }
  }

  const byFingerprint = await findExistingLeadByFingerprint(pool, fingerprint);
  if (byFingerprint) {
    return {
      fingerprint,
      duplicate: true,
      duplicate_reason: "fingerprint_match",
      existing_lead_id: byFingerprint.external_lead_id,
      existing_lead_uuid: byFingerprint.lead_uuid
    };
  }

  let possibleInternalCandidateId = null;
  if (profile.verified_email) {
    const internal = await findInternalCandidateByVerifiedEmail(pool, profile.verified_email);
    if (internal) {
      possibleInternalCandidateId = internal.candidate_id;
    }
  }

  return {
    fingerprint,
    duplicate: false,
    duplicate_reason: null,
    existing_lead_id: null,
    existing_lead_uuid: null,
    possible_internal_candidate_id: possibleInternalCandidateId
  };
}

module.exports = {
  buildProviderFingerprint,
  buildProfileUrlFingerprint,
  buildEmailFingerprint,
  choosePrimaryFingerprint,
  classifyDuplicate,
  findInternalCandidateByVerifiedEmail,
  findExistingLeadByNormalizedProfileUrl,
  sha256
};
