/**
 * AI Candidate Review V1 — advisory OpenAI analysis for one candidate vs one requisition.
 * Does not mutate candidate, requisition, or pipeline state.
 */

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { PDFParse } = require("pdf-parse");
const candidateAccessService = require("./candidateAccessService");
const masterDataService = require("./masterDataService");
const {
  assertResumeMatchAccess,
  assertApprovedOpenRequisition,
  buildSkillResolver,
  splitSkillTokens
} = require("./resumeMatchService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const FEATURE_KEY = "ai_candidate_review";
const MAX_RESUME_CHARS = 14000;
const OPENAI_TIMEOUT_MS = 45000;
/** Completion cap for cost guardrail (model unchanged). */
const MAX_COMPLETION_TOKENS = 400;

const REQUIREMENT_STATUSES = new Set([
  "Meets",
  "Partial",
  "Unclear",
  "Not Evidenced"
]);

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loadPlatformConfig(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );
  return result.rows[0]?.published_payload || null;
}

function isAiModuleEnabled(platformConfig) {
  const aiModule = platformConfig?.modules?.find((item) => item.key === "ai");
  return Boolean(aiModule?.enabled);
}

function isAiCandidateReviewFeatureEnabled(platformConfig) {
  if (!isAiModuleEnabled(platformConfig)) {
    return false;
  }

  const features = platformConfig?.ai_features || [];
  const feature = features.find((item) => item.key === FEATURE_KEY);

  if (!feature) {
    return false;
  }

  return feature.enabled === true;
}

async function getAiReviewAvailability(pool) {
  const platformConfig = await loadPlatformConfig(pool);

  return {
    ai_module_enabled: isAiModuleEnabled(platformConfig),
    feature_enabled: isAiCandidateReviewFeatureEnabled(platformConfig),
    available:
      isAiCandidateReviewFeatureEnabled(platformConfig) &&
      Boolean(String(process.env.OPENAI_API_KEY || "").trim())
  };
}

function resolveStorageObjectKey(resumePath) {
  const value = String(resumePath || "").trim();

  if (!value) {
    return value;
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length === 0) {
        return value;
      }
      return decodeURIComponent(segments[segments.length - 1]);
    }
  } catch {
    // bare key
  }

  return value;
}

function createR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function parsePdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText();
    return { text: textResult.text };
  } finally {
    await parser.destroy();
  }
}

async function downloadResumeBuffer(resumePath) {
  const objectKey = resolveStorageObjectKey(resumePath);
  const bucket = process.env.R2_BUCKET;

  if (!objectKey || !bucket) {
    throw httpError("Resume storage is not configured.", 503);
  }

  try {
    const response = await createR2Client().send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey
      })
    );

    return streamToBuffer(response.Body);
  } catch (error) {
    const notFound = new Error("Resume not available.");
    notFound.status = 404;
    throw notFound;
  }
}

async function extractResumeText(resumePath) {
  if (!resumePath) {
    return "";
  }

  const buffer = await downloadResumeBuffer(resumePath);
  const parsed = await parsePdfBuffer(buffer);
  const text = String(parsed?.text || "").trim();

  if (text.length <= MAX_RESUME_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_RESUME_CHARS)}\n[truncated]`;
}

function isPublishedSkill(record) {
  return (
    String(record?.status || "").trim() === "Active" &&
    String(record?.versionStatus || record?.version_status || "").trim() ===
      "Published"
  );
}

function resolveSkillLabels(tokens, resolver) {
  const labels = [];

  for (const token of tokens) {
    const resolved = resolver.resolveToken(token);
    if (resolved?.name) {
      labels.push(resolved.name);
    } else if (resolved?.raw) {
      labels.push(resolved.raw);
    }
  }

  return labels;
}

function buildReviewJsonSchema() {
  return {
    name: "ai_candidate_review_v1",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidate_summary: { type: "string" },
        requirement_analysis: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              requirement: { type: "string" },
              status: {
                type: "string",
                enum: ["Meets", "Partial", "Unclear", "Not Evidenced"]
              },
              supporting_evidence: { type: "string" }
            },
            required: ["requirement", "status", "supporting_evidence"]
          }
        },
        strengths: {
          type: "array",
          items: { type: "string" }
        },
        areas_to_validate: {
          type: "array",
          items: { type: "string" }
        },
        suggested_recruiter_questions: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: [
        "candidate_summary",
        "requirement_analysis",
        "strengths",
        "areas_to_validate",
        "suggested_recruiter_questions"
      ]
    }
  };
}

function validateReviewPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw httpError("AI review response was invalid.", 502);
  }

  const requiredRoot = [
    "candidate_summary",
    "requirement_analysis",
    "strengths",
    "areas_to_validate",
    "suggested_recruiter_questions"
  ];

  for (const key of requiredRoot) {
    if (!(key in payload)) {
      throw httpError("AI review response was incomplete.", 502);
    }
  }

  if (!Array.isArray(payload.requirement_analysis)) {
    throw httpError("AI review requirement analysis was invalid.", 502);
  }

  for (const row of payload.requirement_analysis) {
    if (!REQUIREMENT_STATUSES.has(row?.status)) {
      throw httpError("AI review contained an invalid requirement status.", 502);
    }
  }

  for (const listKey of [
    "strengths",
    "areas_to_validate",
    "suggested_recruiter_questions"
  ]) {
    if (!Array.isArray(payload[listKey])) {
      throw httpError(`AI review field ${listKey} was invalid.`, 502);
    }
  }

  const forbidden = /\b(hire|reject|do not hire|not recommended)\b/i;
  const serialized = JSON.stringify(payload);
  if (forbidden.test(serialized)) {
    throw httpError("AI review contained disallowed hiring recommendations.", 502);
  }
}

function resolveOpenAiConfig(platformConfig) {
  const governance = platformConfig?.ai_governance || {};
  const model =
    String(process.env.OPENAI_MODEL || "").trim() ||
    String(governance.model || "").trim() ||
    "gpt-4o-mini";

  return { model };
}

function buildPromptInput({
  requisition,
  requiredSkillLabels,
  secondarySkillLabels,
  candidateSkills,
  totalExperience,
  resumeText
}) {
  return {
    requisition: {
      code: requisition.requisition_code,
      job_title:
        requisition.job_title || requisition.position_title || null,
      job_description: requisition.job_description || "",
      required_skills: requiredSkillLabels,
      secondary_skills: secondarySkillLabels
    },
    candidate: {
      primary_skills: candidateSkills.primary,
      secondary_skills: candidateSkills.secondary,
      total_experience_years: totalExperience
    },
    resume_excerpt: resumeText || "(No resume text available — rely on structured skills only.)"
  };
}

function buildSystemPrompt() {
  return [
    "You are an advisory recruiting assistant for OPTALYNX ATS.",
    "Analyze the candidate only using the provided resume excerpt and structured fields.",
    "Never invent employers, skills, degrees, or dates not supported by the inputs.",
    "Distinguish resume evidence from inference in supporting_evidence.",
    "If evidence is missing, use status Unclear or Not Evidenced.",
    "Do NOT output hire/reject decisions, overall scores, or rankings.",
    "Be highly concise. Preserve ALL requirement-level analysis and evidence. Do not omit a requirement. Keep strengths, validation areas and recruiter questions concise.",
    "Return JSON matching the provided schema exactly."
  ].join(" ");
}

function buildOpenAiRequestPayload({ model, systemPrompt, userPayload }) {
  return {
    model,
    temperature: 0.2,
    max_tokens: MAX_COMPLETION_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: buildReviewJsonSchema()
    },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: JSON.stringify(userPayload)
      }
    ]
  };
}

function mapUsageFromOpenAiResponse(body, model) {
  const usage = body?.usage || {};
  const cachedDetail = usage.prompt_tokens_details || {};

  return {
    model: body.model || model,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    cached_tokens:
      cachedDetail.cached_tokens ??
      cachedDetail.cached_input_tokens ??
      null
  };
}

async function defaultCallOpenAi({ model, systemPrompt, userPayload }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    throw httpError("AI review is not configured.", 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        buildOpenAiRequestPayload({ model, systemPrompt, userPayload })
      ),
      signal: controller.signal
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(
        "AI Candidate Review OpenAI error:",
        response.status,
        body?.error?.type || "unknown"
      );
      throw httpError(
        "AI review is temporarily unavailable. Please try again later.",
        503
      );
    }

    const choice = body?.choices?.[0];

    if (choice?.finish_reason === "length") {
      throw httpError(
        "AI review is temporarily unavailable. Please try again later.",
        503
      );
    }

    const content = choice?.message?.content;

    if (!content) {
      throw httpError("AI review returned an empty response.", 503);
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (_parseError) {
      throw httpError(
        "AI review is temporarily unavailable. Please try again later.",
        503
      );
    }

    return {
      parsed,
      metadata: mapUsageFromOpenAiResponse(body, model)
    };
  } catch (error) {
    if (error.status) {
      throw error;
    }

    if (error.name === "AbortError") {
      throw httpError(
        "AI review timed out. Please try again later.",
        503
      );
    }

    console.error("AI Candidate Review failure:", error.message);
    throw httpError(
      "AI review is temporarily unavailable. Please try again later.",
      503
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function writeReviewAudit(pool, req, audit) {
  const actor = userContext(req);

  try {
    await writeEnterpriseAudit(pool, {
      eventType: "AiCandidateReviewRequested",
      module: "recruitment",
      entity: "candidate",
      entityId: String(audit.candidateId),
      action: audit.success ? "generate_success" : "generate_failure",
      userName: actor.name,
      userRole: actor.role,
      metadata: {
        requisition_code: audit.requisitionCode,
        success: audit.success,
        model: audit.model || null,
        prompt_tokens: audit.prompt_tokens ?? null,
        completion_tokens: audit.completion_tokens ?? null,
        total_tokens: audit.total_tokens ?? null,
        cached_tokens: audit.cached_tokens ?? null,
        error_code: audit.error_code || null
      }
    });
  } catch (auditError) {
    console.error("AI Candidate Review audit write failed:", auditError.message);
  }
}

async function generateAiCandidateReview(pool, candidateId, requisitionCode, req, deps = {}) {
  const callOpenAi = deps.callOpenAi || defaultCallOpenAi;
  const numericCandidateId = Number(candidateId);

  if (!Number.isFinite(numericCandidateId) || numericCandidateId <= 0) {
    throw httpError("Valid candidateId is required.", 400);
  }

  const code = String(requisitionCode || "").trim();
  if (!code) {
    throw httpError("requisition_code is required.", 400);
  }

  const platformConfig = await loadPlatformConfig(pool);

  if (!isAiCandidateReviewFeatureEnabled(platformConfig)) {
    throw httpError("AI Candidate Review is disabled.", 403);
  }

  await candidateAccessService.assertCandidateReadAccess(pool, req, numericCandidateId);

  const requisitionResult = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
    [code]
  );
  const requisition = requisitionResult.rows[0] || null;

  assertApprovedOpenRequisition(requisition);
  await assertResumeMatchAccess(pool, req, requisition);

  const candidateResult = await pool.query(
    `SELECT candidate_id, candidate_code, first_name, middle_name, last_name,
            preferred_name, primary_skill, secondary_skill, total_experience, resume_path
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [numericCandidateId]
  );
  const candidate = candidateResult.rows[0];

  if (!candidate) {
    throw httpError("Candidate not found.", 404);
  }

  const publishedSkills = (await masterDataService.listByEntityType(pool, "skills")).filter(
    isPublishedSkill
  );
  const resolver = buildSkillResolver(publishedSkills);

  const requiredSkillLabels = resolveSkillLabels(
    splitSkillTokens(requisition.primary_skill),
    resolver
  );
  const secondarySkillLabels = resolveSkillLabels(
    splitSkillTokens(requisition.secondary_skill),
    resolver
  );

  const candidateSkills = {
    primary: resolveSkillLabels(splitSkillTokens(candidate.primary_skill), resolver),
    secondary: resolveSkillLabels(splitSkillTokens(candidate.secondary_skill), resolver)
  };

  let resumeText = "";

  try {
    resumeText = await extractResumeText(candidate.resume_path);
  } catch (resumeError) {
    if (resumeError.status === 404) {
      resumeText = "";
    } else {
      throw resumeError;
    }
  }

  const { model } = resolveOpenAiConfig(platformConfig);
  const userPayload = buildPromptInput({
    requisition,
    requiredSkillLabels,
    secondarySkillLabels,
    candidateSkills,
    totalExperience: candidate.total_experience,
    resumeText
  });

  let parsed;
  let metadata = { model };

  try {
    const result = await callOpenAi({
      model,
      systemPrompt: buildSystemPrompt(),
      userPayload
    });
    parsed = result.parsed;
    metadata = result.metadata;
    validateReviewPayload(parsed);
  } catch (error) {
    await writeReviewAudit(pool, req, {
      candidateId: numericCandidateId,
      requisitionCode: code,
      success: false,
      model: metadata.model,
      error_code: error.status || 500
    });
    throw error;
  }

  await writeReviewAudit(pool, req, {
    candidateId: numericCandidateId,
    requisitionCode: code,
    success: true,
    model: metadata.model,
    prompt_tokens: metadata.prompt_tokens,
    completion_tokens: metadata.completion_tokens,
    total_tokens: metadata.total_tokens,
    cached_tokens: metadata.cached_tokens
  });

  return {
    candidate_id: numericCandidateId,
    requisition_code: code,
    generated_at: new Date().toISOString(),
    advisory_notice:
      "Advisory only. This review does not make hiring decisions or change candidate status.",
    review: {
      candidate_summary: parsed.candidate_summary,
      requirement_analysis: parsed.requirement_analysis,
      strengths: parsed.strengths,
      areas_to_validate: parsed.areas_to_validate,
      suggested_recruiter_questions: parsed.suggested_recruiter_questions
    },
    model: metadata.model
  };
}

module.exports = {
  FEATURE_KEY,
  MAX_COMPLETION_TOKENS,
  generateAiCandidateReview,
  getAiReviewAvailability,
  isAiCandidateReviewFeatureEnabled,
  isAiModuleEnabled,
  loadPlatformConfig,
  validateReviewPayload,
  buildReviewJsonSchema,
  buildSystemPrompt,
  buildOpenAiRequestPayload,
  REQUIREMENT_STATUSES,
  defaultCallOpenAi
};
