/**
 * Resume Match V1 verification.
 * Run: node scripts/verifyResumeMatchV1.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");
const resumeMatchService = require("../services/resumeMatchService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const { ALLOWED_RESPONSE_FIELDS } = require("../services/resumeMatchService");

const RUN_ID = String(Date.now()).slice(-8);
const REQ_APPROVED = `REQ-RM-${RUN_ID}`;
const REQ_OPEN = `REQ-RMO-${RUN_ID}`;
const REQ_CLOSED = `REQ-RMC-${RUN_ID}`;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const results = [];
const createdCandidateIds = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!passed) {
    process.exitCode = 1;
  }
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

async function resolvePublishedSkills(count = 4) {
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

async function insertRequisition(code, status, primarySkill) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      primary_skill, budget_approved, created_by, modified_by
    ) VALUES ($1,$2,$3,'Resume Match QA',1,$4,$5,0,'Resume Match Verify','Resume Match Verify')`,
    [code, reqId, `Resume Match ${code}`, status, primarySkill]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1,$2,'E2E','Resume Match QA',$3,'Resume Match disposable requisition',1,$4,'Resume Match Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Resume Match ${code}`, status]
    );
  }

  return reqId;
}

async function assignRecruiter(code, recruiterCode) {
  await pool.query(
    `INSERT INTO rm_recruiter_assignments (
      requisition_code, recruiter_code, assigned_by, is_active, version, version_status, effective_from
    ) VALUES ($1,$2,'Resume Match Verify',TRUE,1.0,'Published',NOW())`,
    [code, recruiterCode]
  );
}

async function createTalentPoolCandidate({
  label,
  primarySkill,
  secondarySkill = null,
  experience = 1
}) {
  const email = `resume.match.${label}.${RUN_ID}@example.com`;
  const result = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill, secondary_skill,
      total_experience, candidate_status, candidate_container, created_by
    ) VALUES ($1, 'Match', $2, '9876501234', $3, $4, $5, 'Applied', 'TALENT_POOL', 'Resume Match Verify')
    RETURNING candidate_id`,
    [label, email, primarySkill, secondarySkill, experience]
  );
  const candidateId = result.rows[0].candidate_id;
  createdCandidateIds.push(candidateId);
  return candidateId;
}

async function cleanup() {
  await pool.query(
    "DELETE FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])",
    [[REQ_APPROVED, REQ_OPEN, REQ_CLOSED]]
  );
  if (await tableExists("candidate_req_map")) {
    await pool.query(
      `DELETE FROM candidate_req_map
       WHERE req_id IN (
         SELECT req_id FROM rm_requisitions
         WHERE requisition_code = ANY($1::text[])
       )`,
      [[REQ_APPROVED, REQ_OPEN, REQ_CLOSED]]
    );
  }
  if (createdCandidateIds.length) {
    await pool.query(
      "DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])",
      [createdCandidateIds]
    );
  }
  await pool.query(
    "DELETE FROM rm_recruiter_assignments WHERE requisition_code = ANY($1::text[])",
    [[REQ_APPROVED, REQ_OPEN, REQ_CLOSED]]
  );
  await pool.query(
    "DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])",
    [[REQ_APPROVED, REQ_OPEN, REQ_CLOSED]]
  );
}

function findCandidateByLabel(matches, label) {
  return matches.candidates.find((row) =>
    String(row.candidate_name || "").includes(label)
  );
}

async function main() {
  console.log("=== Resume Match V1 Verification ===\n");

  const skills = await resolvePublishedSkills(4);
  const recruiter = await resolveRecruiter();
  const admin = await resolveAdmin();

  record("Published skill fixtures", skills.length >= 4, `count=${skills.length}`);
  record("Recruiter fixture", Boolean(recruiter), recruiter?.employee_code || "missing");
  record("Admin fixture", Boolean(admin), admin?.employee_code || "missing");

  if (skills.length < 4 || !recruiter || !admin) {
    await pool.end();
    return;
  }

  const [s1, s2, s3, s4] = skills;
  const requiredCodes = `${s1.code},${s2.code},${s3.code},${s4.code}`;

  const recruiterReq = mockReq(recruiter);
  const adminReq = mockReq(admin);
  const unauthorizedRecruiter = await resolveUnauthorizedRecruiter(recruiter.employee_code);
  const unauthorizedReq = unauthorizedRecruiter
    ? mockReq(unauthorizedRecruiter)
    : null;

  try {
    await insertRequisition(REQ_APPROVED, REQUISITION_STATUS.APPROVED, requiredCodes);
    await insertRequisition(REQ_OPEN, REQUISITION_STATUS.OPEN, requiredCodes);
    await insertRequisition(
      REQ_CLOSED,
      REQUISITION_STATUS.CLOSED_FILLED,
      requiredCodes
    );
    await assignRecruiter(REQ_APPROVED, recruiter.employee_code);

    const cand100 = await createTalentPoolCandidate({
      label: "RM100",
      primarySkill: `${s1.code},${s2.code}`,
      secondarySkill: `${s3.code},${s4.code}`,
      experience: 8
    });
    const cand75 = await createTalentPoolCandidate({
      label: "RM75",
      primarySkill: `${s1.name},${s2.code},${s3.code}`,
      experience: 6
    });
    const cand50 = await createTalentPoolCandidate({
      label: "RM50",
      primarySkill: `${s1.code},${s2.name}`,
      experience: 4
    });
    const cand0 = await createTalentPoolCandidate({
      label: "RM0",
      primarySkill: "Totally Unknown Skill XYZ",
      experience: 2
    });
    const candMapped = await createTalentPoolCandidate({
      label: "RMMAP",
      primarySkill: requiredCodes,
      experience: 10
    });

    await recruitmentService.mapCandidate(
      pool,
      {
        candidate_id: candMapped,
        requisition_code: REQ_APPROVED,
        stage_name: "Applied",
        source_type: "Direct"
      },
      recruiterReq
    );

    let openBlocked = false;
    try {
      await resumeMatchService.getResumeMatches(pool, REQ_OPEN, recruiterReq);
    } catch (error) {
      openBlocked = error.status === 400;
    }
    record("Non-approved requisition blocked", openBlocked);

    let closedBlocked = false;
    try {
      await resumeMatchService.getResumeMatches(pool, REQ_CLOSED, recruiterReq);
    } catch (error) {
      closedBlocked = error.status === 400;
    }
    record("Closed requisition blocked", closedBlocked);

    if (unauthorizedReq) {
      let unauthorizedBlocked = false;
      try {
        await resumeMatchService.getResumeMatches(pool, REQ_APPROVED, unauthorizedReq);
      } catch (error) {
        unauthorizedBlocked = error.status === 403;
      }
      record("Unauthorized recruiter blocked", unauthorizedBlocked);
    } else {
      record("Unauthorized recruiter blocked", true, "skipped — no alternate recruiter");
    }

    const assignedMatches = await resumeMatchService.getResumeMatches(
      pool,
      REQ_APPROVED,
      recruiterReq
    );
    record("Assigned recruiter authorized", Array.isArray(assignedMatches.candidates));

    const adminMatches = await resumeMatchService.getResumeMatches(
      pool,
      REQ_APPROVED,
      adminReq
    );
    record("Admin authorized", Array.isArray(adminMatches.candidates));

    const row100 = findCandidateByLabel(assignedMatches, "RM100");
    const row75 = findCandidateByLabel(assignedMatches, "RM75");
    const row50 = findCandidateByLabel(assignedMatches, "RM50");
    const row0 = findCandidateByLabel(assignedMatches, "RM0");
    const rowMapped = findCandidateByLabel(assignedMatches, "RMMAP");

    record("Score math 100%", row100?.match_pct === 100, `actual=${row100?.match_pct}`);
    record("Score math 75%", row75?.match_pct === 75, `actual=${row75?.match_pct}`);
    record("Score math 50%", row50?.match_pct === 50, `actual=${row50?.match_pct}`);
    record("Score math 0%", row0?.match_pct === 0, `actual=${row0?.match_pct}`);
    record(
      "Legacy candidate skill normalization",
      row75?.match_pct === 75 && row50?.match_pct === 50
    );
    record(
      "Matched/missing skills present",
      row75?.matched_skills?.length === 3 && row75?.missing_skills?.length === 1
    );
    record("Already-mapped candidate excluded", !rowMapped);

    const forbiddenFields = [
      "email_id",
      "mobile_number",
      "pan_number",
      "resume_path",
      "remarks"
    ];
    let piiLeak = false;
    for (const row of assignedMatches.candidates) {
      for (const field of forbiddenFields) {
        if (Object.prototype.hasOwnProperty.call(row, field)) {
          piiLeak = true;
        }
      }
      for (const key of Object.keys(row)) {
        if (!ALLOWED_RESPONSE_FIELDS.has(key)) {
          piiLeak = true;
        }
      }
    }
    record("No candidate PII/resume leak", !piiLeak);

    const mapTarget = await createTalentPoolCandidate({
      label: "RMACTION",
      primarySkill: requiredCodes,
      experience: 5
    });
    const beforeMap = await resumeMatchService.getResumeMatches(
      pool,
      REQ_APPROVED,
      recruiterReq
    );
    const visibleBefore = findCandidateByLabel(beforeMap, "RMACTION");
    record("Map target visible before map", Boolean(visibleBefore));

    await recruitmentService.mapCandidate(
      pool,
      {
        candidate_id: mapTarget,
        requisition_code: REQ_APPROVED,
        stage_name: "Applied",
        source_type: "Direct"
      },
      recruiterReq
    );

    const afterMap = await resumeMatchService.getResumeMatches(
      pool,
      REQ_APPROVED,
      recruiterReq
    );
    const visibleAfter = findCandidateByLabel(afterMap, "RMACTION");
    record(
      "Map action uses existing flow and excludes mapped candidate",
      Boolean(visibleBefore) && !visibleAfter
    );

    const ranking = assignedMatches.candidates.map((row) => row.match_pct);
    const sorted = [...ranking].sort((a, b) => b - a);
    record("Ranking by match_pct DESC", JSON.stringify(ranking) === JSON.stringify(sorted));
  } finally {
    await cleanup();
  }

  const failed = results.filter((row) => !row.passed).length;
  console.log(`\n=== Summary: ${results.length - failed}/${results.length} passed ===`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
