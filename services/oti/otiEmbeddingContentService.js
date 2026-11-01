/**
 * Build embeddable text from authorized indexed sources only.
 */

const { hashResumeContent, normalizeResumeText } = require("./otiResumeTextUtils");
const { splitSkillTokens } = require("../resumeMatchService");

function buildCompositeEmbeddingText({
  resumeText,
  skills = [],
  experienceHighlights = [],
  requisition,
  queryText
}) {
  const parts = [];

  for (const token of splitSkillTokens(queryText)) {
    if (token) {
      parts.push(token);
    }
  }

  for (const token of splitSkillTokens(requisition?.primary_skill)) {
    if (token) {
      parts.push(token);
    }
  }

  if (requisition?.job_title) {
    parts.push(String(requisition.job_title).trim());
  }

  if (requisition?.position_title) {
    parts.push(String(requisition.position_title).trim());
  }

  for (const skill of skills || []) {
    const name = String(skill?.name || skill || "").trim();
    if (name) {
      parts.push(name);
    }
  }

  for (const highlight of experienceHighlights || []) {
    if (highlight?.designation) {
      parts.push(String(highlight.designation).trim());
    }
    if (highlight?.company_name) {
      parts.push(String(highlight.company_name).trim());
    }
  }

  const normalizedResume = normalizeResumeText(resumeText);
  if (normalizedResume) {
    parts.push(normalizedResume.slice(0, 8000));
  }

  return parts.join("\n").trim();
}

function buildContentHash(text) {
  return hashResumeContent(text);
}

module.exports = {
  buildCompositeEmbeddingText,
  buildContentHash
};
