/**
 * OTI Agent 1 — deterministic query structuring (no LLM).
 */

const { splitSkillTokens } = require("../resumeMatchService");

function buildStructuredQuery({ queryText, requisition }) {
  const fromQuery = splitSkillTokens(queryText);
  const fromReq = splitSkillTokens(requisition?.primary_skill);

  const skillTokens = [];
  const seen = new Set();

  for (const token of [...fromQuery, ...fromReq]) {
    const key = String(token || "").trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    skillTokens.push(String(token).trim());
  }

  return {
    structured_query: {
      skill_tokens: skillTokens,
      query_text: String(queryText || "").trim() || null,
      requisition_code: requisition?.requisition_code || null
    },
    used_llm: false
  };
}

module.exports = {
  buildStructuredQuery
};
