/**
 * AI Candidate Review V1 verification.
 * Run: node scripts/verifyAiCandidateReviewV1.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const aiCandidateReviewService = require("../services/aiCandidateReviewService");
const resumeMatchService = require("../services/resumeMatchService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const RUN_ID = String(Date.now()).slice(-8);
const REQ_CODE = `REQ-AIR-${RUN_ID}`;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

let publishedSnapshot = null;
let createdCandidateId = null;

function pass(name, detail = "") {
  console.log(`PASS: ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function mockReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null,
      full_name: user.full_name || user.email_id
    }
  };
}

const SAMPLE_REVIEW = {
  candidate_summary: "Experienced engineer with Java focus per resume excerpt.",
  requirement_analysis: [
    {
      requirement: "Java",
      status: "Meets",
      supporting_evidence: "Resume excerpt lists Java projects (resume evidence)."
    }
  ],
  strengths: ["Java delivery"],
  areas_to_validate: ["Kubernetes depth"],
  suggested_recruiter_questions: ["Describe your most recent Java service ownership."]
};

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter(assignedCode) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND COALESCE(is_active, TRUE) = TRUE
       AND employee_code <> $1
     ORDER BY user_id ASC
     LIMIT 1`,
    [assignedCode]
  );
  return result.rows[0] || null;
}

async function resolvePublishedSkills(count = 2) {
  const result = await pool.query(
    `SELECT code, name
     FROM md_records
     WHERE entity_type = 'skills'
       AND is_deleted = FALSE
       AND LOWER(COALESCE(status, 'active')) = 'active'
       AND LOWER(COALESCE(version_status, 'published')) = 'published'
     ORDER BY code ASC
     LIMIT $1`,
    [count]
  );
  return result.rows;
}

async function backupPublishedConfig() {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );
  publishedSnapshot = result.rows[0]?.published_payload || null;
}

async function restorePublishedConfig() {
  if (!publishedSnapshot) {
    return;
  }

  await pool.query(
    "UPDATE pc_config_state SET published_payload = $1::jsonb WHERE id = 1",
    [JSON.stringify(publishedSnapshot)]
  );
}

function patchConfig(base, patchFn) {
  const next = JSON.parse(JSON.stringify(base || {}));
  patchFn(next);
  return next;
}

async function publishConfigPayload(payload) {
  await pool.query(
    "UPDATE pc_config_state SET published_payload = $1::jsonb WHERE id = 1",
    [JSON.stringify(payload)]
  );
}

async function allocateReqId() {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function insertRequisition(code, primarySkill) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      primary_skill, job_description, budget_approved, created_by, modified_by
    ) VALUES ($1,$2,$3,'AI Review QA',1,$4,$5,$6,0,'AI Review Verify','AI Review Verify')`,
    [
      code,
      reqId,
      `AI Review ${code}`,
      REQUISITION_STATUS.APPROVED,
      primarySkill,
      "Build enterprise services with Java and collaboration skills."
    ]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1,$2,'E2E','AI Review QA',$3,'AI review disposable requisition',1,$4,'AI Review Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `AI Review ${code}`, REQUISITION_STATUS.APPROVED]
    );
  }
}

async function assignRecruiter(code, recruiterCode) {
  await pool.query(
    `INSERT INTO rm_recruiter_assignments (
      requisition_code, recruiter_code, assigned_by, is_active, version, version_status, effective_from
    ) VALUES ($1,$2,'AI Review Verify',TRUE,1.0,'Published',NOW())`,
    [code, recruiterCode]
  );
}

async function seedRequisitionAndCandidate(recruiter) {
  const skills = await resolvePublishedSkills(2);
  if (skills.length < 1) {
    throw new Error("Need published skills for AI review verification.");
  }

  const primarySkill = skills.map((s) => s.code).join(",");

  await insertRequisition(REQ_CODE, primarySkill);
  await assignRecruiter(REQ_CODE, recruiter.employee_code);

  const email = `ai.review.${RUN_ID}@example.com`;
  const insert = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, candidate_container, created_by
    ) VALUES ('AI', 'Review', $1, '9876501234', $2, 2, 'Applied', 'TALENT_POOL', 'AI Review Verify')
    RETURNING candidate_id`,
    [email, skills[0].code]
  );

  createdCandidateId = insert.rows[0].candidate_id;
}

async function main() {
  const admin = await resolveAdmin();
  const recruiter = await resolveRecruiter();

  if (!admin || !recruiter) {
    fail("Resolve admin and recruiter users");
    return;
  }

  await backupPublishedConfig();
  let config = publishedSnapshot;
  if (!config) {
    config = await aiCandidateReviewService.loadPlatformConfig(pool);
  }
  if (!config) {
    config = require("../seed/platformConfig.seed.json");
  }

  try {
    if (aiCandidateReviewService.MAX_COMPLETION_TOKENS === 400) {
      pass("OpenAI max completion tokens capped at 400");
    } else {
      fail("OpenAI max completion tokens capped at 400");
    }

    const systemPrompt = aiCandidateReviewService.buildSystemPrompt();
    if (
      systemPrompt.includes(
        "Be highly concise. Preserve ALL requirement-level analysis and evidence."
      )
    ) {
      pass("System prompt includes concise-analysis guardrail");
    } else {
      fail("System prompt includes concise-analysis guardrail");
    }

    const requestPayload = aiCandidateReviewService.buildOpenAiRequestPayload({
      model: "gpt-4.1",
      systemPrompt,
      userPayload: { requisition: {}, candidate: {}, resume_excerpt: "" }
    });
    if (requestPayload.max_tokens === 400) {
      pass("OpenAI request payload sets max_tokens 400");
    } else {
      fail("OpenAI request payload sets max_tokens 400");
    }

    await seedRequisitionAndCandidate(recruiter);

    const disabledConfig = patchConfig(config, (payload) => {
      const aiModule = payload.modules?.find((m) => m.key === "ai");
      if (aiModule) {
        aiModule.enabled = false;
      }
      const feature = payload.ai_features?.find((f) => f.key === "ai_candidate_review");
      if (feature) {
        feature.enabled = false;
      }
    });

    await publishConfigPayload(disabledConfig);

    try {
      await aiCandidateReviewService.generateAiCandidateReview(
        pool,
        createdCandidateId,
        REQ_CODE,
        mockReq(admin)
      );
      fail("AI disabled blocks generation");
    } catch (error) {
      if (error.status === 403) {
        pass("AI disabled → generation denied (403)");
      } else {
        fail("AI disabled → generation denied", `status=${error.status}`);
      }
    }

    const availabilityDisabled =
      await aiCandidateReviewService.getAiReviewAvailability(pool);
    if (!availabilityDisabled.feature_enabled) {
      pass("AI disabled → availability feature_enabled false");
    } else {
      fail("AI disabled → availability feature_enabled false");
    }

    const enabledConfig = patchConfig(config, (payload) => {
      const aiModule = payload.modules?.find((m) => m.key === "ai");
      if (aiModule) {
        aiModule.enabled = true;
      }
      if (!payload.ai_features?.find((f) => f.key === "ai_candidate_review")) {
        payload.ai_features = payload.ai_features || [];
        payload.ai_features.push({
          key: "ai_candidate_review",
          title: "AI Candidate Review",
          enabled: true,
          confidence_min: 0.7,
          max_tokens: 2500
        });
      } else {
        const feature = payload.ai_features.find((f) => f.key === "ai_candidate_review");
        feature.enabled = true;
      }
    });

    await publishConfigPayload(enabledConfig);

    const mockOpenAi = async () => ({
      parsed: SAMPLE_REVIEW,
      metadata: { model: "mock-model", prompt_tokens: 10, completion_tokens: 20 }
    });

    const before = await pool.query(
      `SELECT candidate_status, primary_skill, updated_on FROM cand_mstr WHERE candidate_id = $1`,
      [createdCandidateId]
    );
    const beforeReq = await pool.query(
      `SELECT job_description, primary_skill FROM rm_requisitions WHERE requisition_code = $1`,
      [REQ_CODE]
    );

    const result = await aiCandidateReviewService.generateAiCandidateReview(
      pool,
      createdCandidateId,
      REQ_CODE,
      mockReq(admin),
      { callOpenAi: mockOpenAi }
    );

    if (result?.review?.candidate_summary && result.review.requirement_analysis?.length) {
      pass("AI enabled → authorized admin can generate review");
    } else {
      fail("AI enabled → authorized admin can generate review");
    }

    aiCandidateReviewService.validateReviewPayload(result.review);
    pass("Response schema validation");

    const after = await pool.query(
      `SELECT candidate_status, primary_skill, updated_on FROM cand_mstr WHERE candidate_id = $1`,
      [createdCandidateId]
    );
    const afterReq = await pool.query(
      `SELECT job_description, primary_skill FROM rm_requisitions WHERE requisition_code = $1`,
      [REQ_CODE]
    );

    if (
      before.rows[0].candidate_status === after.rows[0].candidate_status &&
      before.rows[0].primary_skill === after.rows[0].primary_skill &&
      beforeReq.rows[0].job_description === afterReq.rows[0].job_description
    ) {
      pass("No candidate/requisition state mutation");
    } else {
      fail("No candidate/requisition state mutation");
    }

    const unauthorized = await resolveUnauthorizedRecruiter(recruiter.employee_code);
    if (unauthorized) {
      try {
        await aiCandidateReviewService.generateAiCandidateReview(
          pool,
          createdCandidateId,
          REQ_CODE,
          mockReq(unauthorized),
          { callOpenAi: mockOpenAi }
        );
        fail("Unauthorized recruiter denied");
      } catch (error) {
        if (error.status === 403) {
          pass("Unauthorized recruiter → denied (403)");
        } else {
          fail("Unauthorized recruiter → denied", `status=${error.status}`);
        }
      }
    } else {
      pass("Unauthorized recruiter check skipped (no second recruiter)");
    }

    try {
      await aiCandidateReviewService.generateAiCandidateReview(
        pool,
        createdCandidateId,
        "",
        mockReq(admin),
        { callOpenAi: mockOpenAi }
      );
      fail("Missing requisition code fails safely");
    } catch (error) {
      if (error.status === 400) {
        pass("Missing requisition context → 400");
      } else {
        fail("Missing requisition context", `status=${error.status}`);
      }
    }

    const failingOpenAi = async () => {
      throw Object.assign(new Error("provider down"), { status: 503 });
    };

    try {
      await aiCandidateReviewService.generateAiCandidateReview(
        pool,
        createdCandidateId,
        REQ_CODE,
        mockReq(admin),
        { callOpenAi: failingOpenAi }
      );
      fail("OpenAI failure surfaces safe error");
    } catch (error) {
      if (error.status === 503 && !/openai/i.test(error.message)) {
        pass("OpenAI failure → safe application message");
      } else {
        fail("OpenAI failure → safe application message", error.message);
      }
    }

    const resumeMatchBefore = resumeMatchService.getResumeMatches;
    if (typeof resumeMatchBefore === "function") {
      pass("Resume Match service export unchanged");
    } else {
      fail("Resume Match service export unchanged");
    }
  } finally {
    if (createdCandidateId) {
      await pool.query("DELETE FROM cand_mstr WHERE candidate_id = $1", [createdCandidateId]);
    }
    await pool.query("DELETE FROM rm_recruiter_assignments WHERE requisition_code = $1", [
      REQ_CODE
    ]);
    await pool.query("DELETE FROM rm_requisitions WHERE requisition_code = $1", [REQ_CODE]);
    await restorePublishedConfig();
    await pool.end();
  }

  if (process.exitCode) {
    console.log("\nAI Candidate Review V1 verification completed with failures.");
  } else {
    console.log("\nAll AI Candidate Review V1 checks passed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
