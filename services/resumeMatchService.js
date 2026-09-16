/**
 * Resume Match V1 — skill normalization and scoring for requisition ↔ talent pool.
 */

const masterDataService = require("./masterDataService");
const { REQUISITION_STATUS, isClosedRequisitionStatus } = require("../constants/requisitionStatus");
const { assertRequisitionOpenForRecruiting } = require("./requisitionFulfillmentService");
const { assertCanAssignRecruiters } = require("./requisitionCapabilityAuth");

const ALLOWED_RESPONSE_FIELDS = new Set([
  "candidate_id",
  "candidate_code",
  "candidate_name",
  "match_pct",
  "matched_skills",
  "missing_skills",
  "total_experience",
  "created_on"
]);

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeMasterLookupKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSkillTokens(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(/[,;/|]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isPublishedSkill(record) {
  return (
    String(record?.status || "").trim() === "Active" &&
    String(record?.versionStatus || record?.version_status || "").trim() ===
      "Published"
  );
}

function tokenMatchesRecord(tokenKey, record) {
  const nameKey = normalizeMasterLookupKey(record.name);
  const codeKey = normalizeMasterLookupKey(record.code);

  if (tokenKey === nameKey || tokenKey === codeKey) {
    return true;
  }

  return (
    nameKey.includes(tokenKey) ||
    tokenKey.includes(nameKey) ||
    codeKey.includes(tokenKey) ||
    tokenKey.includes(codeKey)
  );
}

function buildSkillResolver(publishedSkills) {
  const byCode = new Map();

  for (const record of publishedSkills) {
    byCode.set(normalizeMasterLookupKey(record.code), record);
  }

  function resolveToken(token) {
    const raw = String(token || "").trim();
    if (!raw) {
      return null;
    }

    const direct = byCode.get(normalizeMasterLookupKey(raw));
    if (direct) {
      return { code: direct.code, name: direct.name, unmapped: false };
    }

    const tokenKey = normalizeMasterLookupKey(raw);
    for (const record of publishedSkills) {
      if (tokenMatchesRecord(tokenKey, record)) {
        return { code: record.code, name: record.name, unmapped: false };
      }
    }

    return { code: null, name: raw, unmapped: true, raw };
  }

  return { resolveToken };
}

function toSkillRef(skill) {
  return {
    code: skill.code,
    name: skill.name,
    ...(skill.unmapped ? { unmapped: true } : {})
  };
}

function buildCandidateName(row) {
  const parts = [row.first_name, row.middle_name, row.last_name].filter(Boolean);
  if (parts.length) {
    return parts.join(" ");
  }

  return row.preferred_name || row.candidate_code || "Unnamed Candidate";
}

function computeMatchScore(requiredSkills, candidateCodes) {
  const matched = [];
  const missing = [];

  for (const required of requiredSkills) {
    if (!required.code) {
      missing.push(toSkillRef(required));
      continue;
    }

    if (candidateCodes.has(required.code)) {
      matched.push(toSkillRef(required));
    } else {
      missing.push(toSkillRef(required));
    }
  }

  const totalRequired = requiredSkills.length;
  const matchPct =
    totalRequired === 0
      ? 0
      : Math.round((matched.length / totalRequired) * 100);

  return { matchPct, matched, missing };
}

function collectCandidateSkillCodes(row, resolver) {
  const codes = new Set();

  for (const field of [row.primary_skill, row.secondary_skill]) {
    for (const token of splitSkillTokens(field)) {
      const resolved = resolver.resolveToken(token);
      if (resolved?.code) {
        codes.add(resolved.code);
      }
    }
  }

  return codes;
}

function assertNoSensitiveCandidateFields(candidateRow) {
  const forbidden = [
    "email_id",
    "mobile_number",
    "pan_number",
    "resume_path",
    "remarks"
  ];

  for (const field of forbidden) {
    if (Object.prototype.hasOwnProperty.call(candidateRow, field)) {
      throw new Error(`Resume match response must not include ${field}.`);
    }
  }

  for (const key of Object.keys(candidateRow)) {
    if (!ALLOWED_RESPONSE_FIELDS.has(key)) {
      throw new Error(`Unexpected resume match field: ${key}`);
    }
  }
}

async function loadPublishedSkills(pool) {
  const records = await masterDataService.listByEntityType(pool, "skills");
  return records.filter(isPublishedSkill);
}

async function assertRecruiterAssignedToRequisition(pool, req, requisition) {
  const employeeCode = String(req.user?.employee_code || "").trim();
  if (!employeeCode) {
    throw httpError("Authenticated employee_code is required.", 401);
  }

  const assignment = await pool.query(
    `SELECT assignment_id
     FROM rm_recruiter_assignments
     WHERE recruiter_code = $1
       AND is_active = true
       AND (
         requisition_code = $2
         OR ($3::int IS NOT NULL AND req_id = $3)
       )
     LIMIT 1`,
    [
      employeeCode,
      requisition.requisition_code,
      requisition.req_id || null
    ]
  );

  if (!assignment.rows.length) {
    throw httpError(
      "Enterprise Access Denied. You are not assigned to this requisition.",
      403
    );
  }
}

function isAdminUser(req) {
  return String(req.user?.role_name || "").trim() === "Admin";
}

async function assertResumeMatchAccess(pool, req, requisition) {
  if (isAdminUser(req)) {
    return;
  }

  try {
    await assertCanAssignRecruiters(pool, req);
    return;
  } catch (_error) {
    // Fall through to assigned-recruiter gate.
  }

  await assertRecruiterAssignedToRequisition(pool, req, requisition);
}

function assertApprovedOpenRequisition(requisition) {
  if (!requisition) {
    throw httpError("Requisition not found.", 404);
  }

  if (requisition.req_status !== REQUISITION_STATUS.APPROVED) {
    throw httpError(
      "Resume matches are available only for Approved requisitions.",
      400
    );
  }

  assertRequisitionOpenForRecruiting(requisition);
}

function resolveRequiredSkills(requisition, resolver) {
  const required = [];
  const seen = new Set();

  for (const token of splitSkillTokens(requisition.primary_skill)) {
    const resolved = resolver.resolveToken(token);
    const key = resolved.code || `unmapped:${resolved.name}`.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    required.push(resolved);
  }

  return required;
}

async function listTalentPoolCandidatesForMatch(pool, requisitionCode) {
  const result = await pool.query(
    `SELECT
        cm.candidate_id,
        cm.candidate_code,
        cm.first_name,
        cm.middle_name,
        cm.last_name,
        cm.preferred_name,
        cm.primary_skill,
        cm.secondary_skill,
        cm.total_experience,
        cm.created_on
     FROM cand_mstr cm
     WHERE cm.candidate_container = 'TALENT_POOL'
       AND NOT EXISTS (
         SELECT 1
         FROM rm_candidate_mappings m
         WHERE m.candidate_id = cm.candidate_id
           AND m.requisition_code = $1
           AND m.is_active = TRUE
       )
     ORDER BY cm.created_on DESC`,
    [requisitionCode]
  );

  return result.rows;
}

async function getResumeMatches(pool, requisitionCode, req) {
  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const requisitionResult = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
    [code]
  );
  const requisition = requisitionResult.rows[0] || null;

  assertApprovedOpenRequisition(requisition);
  await assertResumeMatchAccess(pool, req, requisition);

  const publishedSkills = await loadPublishedSkills(pool);
  const resolver = buildSkillResolver(publishedSkills);
  const requiredSkills = resolveRequiredSkills(requisition, resolver);
  const requiredSkillRefs = requiredSkills.map(toSkillRef);
  const candidates = await listTalentPoolCandidatesForMatch(pool, code);

  const ranked = candidates
    .map((row) => {
      const candidateCodes = collectCandidateSkillCodes(row, resolver);
      const { matchPct, matched, missing } = computeMatchScore(
        requiredSkills,
        candidateCodes
      );

      const candidateRow = {
        candidate_id: row.candidate_id,
        candidate_code: row.candidate_code,
        candidate_name: buildCandidateName(row),
        match_pct: matchPct,
        matched_skills: matched,
        missing_skills: missing,
        total_experience: row.total_experience,
        created_on: row.created_on
      };

      assertNoSensitiveCandidateFields(candidateRow);
      return candidateRow;
    })
    .sort((left, right) => {
      if (right.match_pct !== left.match_pct) {
        return right.match_pct - left.match_pct;
      }

      const leftExp = Number(left.total_experience);
      const rightExp = Number(right.total_experience);
      const leftHasExp = Number.isFinite(leftExp);
      const rightHasExp = Number.isFinite(rightExp);

      if (leftHasExp && rightHasExp && rightExp !== leftExp) {
        return rightExp - leftExp;
      }
      if (rightHasExp && !leftHasExp) {
        return 1;
      }
      if (leftHasExp && !rightHasExp) {
        return -1;
      }

      return new Date(right.created_on).getTime() - new Date(left.created_on).getTime();
    });

  return {
    requisition_code: code,
    required_skills: requiredSkillRefs,
    candidates: ranked
  };
}

module.exports = {
  getResumeMatches,
  assertResumeMatchAccess,
  assertApprovedOpenRequisition,
  buildSkillResolver,
  computeMatchScore,
  splitSkillTokens,
  collectCandidateSkillCodes,
  ALLOWED_RESPONSE_FIELDS
};
