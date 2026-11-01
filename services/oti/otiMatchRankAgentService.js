/**
 * OTI Agent 4 — deterministic match/rank using Resume Match V1 primitives.
 */

const masterDataService = require("../masterDataService");
const {
  buildSkillResolver,
  computeMatchScore,
  splitSkillTokens,
  collectCandidateSkillCodes
} = require("../resumeMatchService");

function normalizeMasterLookupKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isPublishedSkill(record) {
  return (
    String(record?.status || "").trim() === "Active" &&
    String(record?.versionStatus || record?.version_status || "").trim() ===
      "Published"
  );
}

async function loadPublishedSkills(pool) {
  const records = await masterDataService.listByEntityType(pool, "skills");
  return records.filter(isPublishedSkill);
}

function toSkillRef(skill) {
  return {
    code: skill.code,
    name: skill.name,
    ...(skill.unmapped ? { unmapped: true } : {})
  };
}

function findOracleDatabaseSkill(publishedSkills) {
  for (const record of publishedSkills) {
    const nameKey = normalizeMasterLookupKey(record.name);
    if (!nameKey.includes("oracle")) {
      continue;
    }
    if (nameKey.includes("cloud") || nameKey.includes("oci")) {
      continue;
    }
    return record;
  }

  return null;
}

function resolveOtiSkillToken(token, resolver, publishedSkills) {
  const raw = String(token || "").trim();
  if (!raw) {
    return null;
  }

  const tokenKey = normalizeMasterLookupKey(raw);
  if (tokenKey === "oracle") {
    const oracleDb = findOracleDatabaseSkill(publishedSkills);
    if (oracleDb) {
      return { code: oracleDb.code, name: oracleDb.name, unmapped: false };
    }
  }

  return resolver.resolveToken(raw);
}

function resolveRequiredSkills(requisition, resolver, publishedSkills, structuredSkillTokens = []) {
  const required = [];
  const seen = new Set();

  const tokens = [
    ...splitSkillTokens(requisition?.primary_skill),
    ...(Array.isArray(structuredSkillTokens) ? structuredSkillTokens : [])
  ];

  for (const token of tokens) {
    const resolved = resolveOtiSkillToken(token, resolver, publishedSkills);
    if (!resolved) {
      continue;
    }

    const key = resolved.code || `unmapped:${resolved.name}`.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    required.push(resolved);
  }

  return required;
}

function buildCandidateName(row) {
  const parts = [row.first_name, row.middle_name, row.last_name].filter(Boolean);
  if (parts.length) {
    return parts.join(" ");
  }

  return row.preferred_name || row.candidate_code || "Unnamed Candidate";
}

async function loadSkillMapCodes(pool, candidateId) {
  const result = await pool.query(
    `SELECT skill_code
     FROM can_skill_map
     WHERE candidate_id = $1
       AND COALESCE(active_flag, TRUE) = TRUE`,
    [candidateId]
  );

  return result.rows
    .map((row) => String(row.skill_code || "").trim())
    .filter(Boolean);
}

async function collectExtendedCandidateSkillCodes(pool, row, resolver) {
  const codes = collectCandidateSkillCodes(row, resolver);
  const mappedCodes = await loadSkillMapCodes(pool, row.candidate_id);

  for (const code of mappedCodes) {
    const resolved = resolver.resolveToken(code);
    if (resolved?.code) {
      codes.add(resolved.code);
    }
  }

  return codes;
}

function assertSafeResultFields(candidateRow) {
  const forbidden = [
    "email_id",
    "mobile_number",
    "pan_number",
    "resume_path",
    "remarks"
  ];

  for (const field of forbidden) {
    if (Object.prototype.hasOwnProperty.call(candidateRow, field)) {
      throw new Error(`OTI result must not include ${field}.`);
    }
  }
}

async function rankInternalCandidates(pool, requisition, discoveredCandidates, options = {}) {
  if (!requisition) {
    throw httpError("Requisition not found.", 404);
  }

  const publishedSkills = await loadPublishedSkills(pool);
  const resolver = buildSkillResolver(publishedSkills);
  const requiredSkills = resolveRequiredSkills(
    requisition,
    resolver,
    publishedSkills,
    options.structuredSkillTokens
  );
  const requiredSkillRefs = requiredSkills.map(toSkillRef);

  const ranked = [];

  for (const discovered of discoveredCandidates) {
    const candidateResult = await pool.query(
      `SELECT
          candidate_id,
          candidate_code,
          first_name,
          middle_name,
          last_name,
          preferred_name,
          primary_skill,
          secondary_skill,
          total_experience,
          created_on
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [discovered.candidate_id]
    );

    const row = candidateResult.rows[0];
    if (!row) {
      continue;
    }

    const candidateCodes = await collectExtendedCandidateSkillCodes(
      pool,
      row,
      resolver
    );
    const { matchPct, matched, missing } = computeMatchScore(
      requiredSkills,
      candidateCodes
    );

    const rankScore = Number((matchPct / 100).toFixed(4));

    const resultRow = {
      candidate_id: row.candidate_id,
      candidate_code: row.candidate_code,
      candidate_name: buildCandidateName(row),
      match_pct: matchPct,
      rank_score: rankScore,
      matched_skills: matched,
      missing_skills: missing,
      total_experience: row.total_experience,
      source_type: discovered.source_type,
      explanation: {
        scoring: "resume_match_v1_skill_overlap",
        includes_can_skill_map: true,
        required_skills: requiredSkillRefs
      }
    };

    assertSafeResultFields(resultRow);
    ranked.push(resultRow);
  }

  ranked.sort((left, right) => {
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

    return String(left.candidate_name || "").localeCompare(
      String(right.candidate_name || "")
    );
  });

  ranked.forEach((row, index) => {
    row.rank_order = index + 1;
  });

  return {
    required_skills: requiredSkillRefs,
    ranked_results: ranked
  };
}

module.exports = {
  rankInternalCandidates,
  collectExtendedCandidateSkillCodes
};
