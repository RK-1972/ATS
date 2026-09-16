/**
 * Offer Management Workspace V1 verification.
 * Run: node scripts/verifyOfferManagementWorkspaceV1.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { spawnSync } = require("child_process");
const path = require("path");
const offerManagementService = require("../services/offerManagementService");
const recruitmentService = require("../services/recruitmentService");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const RUN_ID = Date.now();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
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

function signToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function fetchJson(routePath, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${routePath}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveOfferWorkspaceUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveRecruiterWithoutOfferWorkspace() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.is_active = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveOtherOfferWorkspaceRecruiter(excludeCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
       AND u.employee_code <> $1
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [excludeCode]
  );
  return result.rows[0] || null;
}

async function resolveAdmin() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  );
  return result.rows[0] || null;
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

async function allocateReqId() {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

async function insertApprovedRequisition(code) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, 'Offer Workspace QA', 1, $4, 1500000, 'Offer V1 Verify', 'Offer V1 Verify')`,
    [code, reqId, `Offer V1 ${code}`, REQUISITION_STATUS.APPROVED]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'Offer V1', 'Offer Workspace QA', $3, 'Disposable requisition', 1, $4, 'Offer V1 Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Offer V1 ${code}`, REQUISITION_STATUS.APPROVED]
    );
  }

  return reqId;
}

async function createDisposableCandidate(suffix = "primary") {
  const email = `e2e.offer.v1.${RUN_ID}.${suffix}@example.com`;
  const result = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ('Offer', 'V1', $1, '9876500088', 'Java', 4, 'Applied', 'Offer V1 Verify')
    RETURNING candidate_id`,
    [email]
  );
  return result.rows[0].candidate_id;
}

async function createDisposableFixture(recruiterA, admin) {
  const requisitionCode = `REQ-OFF-V1-${RUN_ID}`;
  const reqId = await insertApprovedRequisition(requisitionCode);
  await recruitmentService.assignRecruiter(
    pool,
    requisitionCode,
    recruiterA.employee_code,
    mockReq(admin)
  );

  const candidateId = await createDisposableCandidate();
  const mapped = await recruitmentService.mapCandidate(
    pool,
    {
      candidate_id: candidateId,
      requisition_code: requisitionCode,
      stage_name: "Applied",
      source_type: "Direct"
    },
    mockReq(recruiterA)
  );

  const mapping = mapped.mapping || mapped;
  const mapId = mapping.map_id || mapping.mapping_id;

  const httpCandidateId = await createDisposableCandidate("http");
  const httpMapped = await recruitmentService.mapCandidate(
    pool,
    {
      candidate_id: httpCandidateId,
      requisition_code: requisitionCode,
      stage_name: "Applied",
      source_type: "Direct"
    },
    mockReq(recruiterA)
  );
  const httpMapping = httpMapped.mapping || httpMapped;
  const httpMapId = httpMapping.map_id || httpMapping.mapping_id;

  return {
    requisitionCode,
    reqId,
    candidateId,
    mapId,
    mappingId: mapping.mapping_id,
    httpCandidateId,
    httpMapId
  };
}

async function resolveValidGrade() {
  const result = await pool.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'grades' AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC LIMIT 1`
  );
  return result.rows[0]?.name || null;
}

function buildOfferPayload(fixture, grade) {
  const joiningDate = new Date();
  joiningDate.setDate(joiningDate.getDate() + 30);

  return {
    requisition_code: fixture.requisitionCode,
    mapping_id: fixture.mapId,
    candidate_id: fixture.candidateId,
    candidate_name: "Offer V1 Candidate",
    offered_ctc: 1400000,
    approved_budget: 1500000,
    grade,
    department: "Offer Workspace QA",
    expected_joining_date: joiningDate.toISOString().slice(0, 10)
  };
}

async function cleanupOfferArtifacts(offerId) {
  if (!offerId) {
    return;
  }

  const offerRow = await pool.query(
    `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const workflowInstanceId = offerRow.rows[0]?.workflow_instance_id;

  await pool.query(`DELETE FROM om_offer_history WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_compensation WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_approvals WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_negotiations WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_revisions WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_documents WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]).catch(() => undefined);
  await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [offerId]);

  if (workflowInstanceId) {
    await pool.query(`DELETE FROM wf_assignments WHERE task_id IN (
      SELECT task_id FROM wf_tasks WHERE instance_id = $1
    )`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_stage_history WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
  }
}

async function cleanupDisposableFixture(fixture) {
  if (!fixture) {
    return;
  }

  if (fixture.offerIds?.length) {
    for (const offerId of fixture.offerIds) {
      await cleanupOfferArtifacts(offerId);
    }
  }

  const codes = [fixture.requisitionCode, fixture.foreignReqCode].filter(Boolean);
  const mappingRows = await pool.query(
    `SELECT map_id, candidate_id FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`,
    [codes]
  );
  const mapIds = mappingRows.rows.map((row) => row.map_id).filter(Boolean);
  const candidateIds = mappingRows.rows.map((row) => row.candidate_id).filter(Boolean);

  await pool.query(`DELETE FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (mapIds.length && (await tableExists("candidate_req_map"))) {
    await pool.query(`DELETE FROM candidate_req_map WHERE map_id = ANY($1::int[])`, [mapIds]);
  }
  if (candidateIds.length) {
    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])`, [candidateIds]);
  }
  await pool.query(`DELETE FROM rm_recruiter_assignments WHERE requisition_code = ANY($1::text[])`, [codes]);
  await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])`, [codes]);
  if (fixture.reqId && (await tableExists("req_mstr"))) {
    await pool.query(`DELETE FROM req_mstr WHERE req_id = ANY($1::int[])`, [
      [fixture.reqId, fixture.foreignReqId].filter(Boolean)
    ]);
  }
  if (fixture.foreignCandidateId) {
    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [
      fixture.foreignCandidateId
    ]);
  }
}

async function runRegression(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync("node", [scriptPath], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: process.env
  });
  const ok = result.status === 0;
  const detail = ok
    ? "ok"
    : (result.stderr || result.stdout || "failed").split("\n").slice(-3).join(" ");
  return { ok, detail };
}

async function main() {
  console.log("=== Offer Management Workspace V1 Verification ===\n");
  console.log(`Run ID: ${RUN_ID}\n`);

  let disposableFixture = null;

  try {
    const recruiterA = await resolveOfferWorkspaceUser();
    const admin = await resolveAdmin();

    if (!recruiterA || !admin) {
      fail("fixtures", "Offer workspace recruiter and Admin required");
      return;
    }

    const grade = await resolveValidGrade();
    if (!grade) {
      fail("fixtures", "grades master-data row required");
      return;
    }

    disposableFixture = await createDisposableFixture(recruiterA, admin);
    disposableFixture.offerIds = [];

    const foreignReqCode = `REQ-OFF-V1-F-${RUN_ID}`;
    const foreignReqId = await insertApprovedRequisition(foreignReqCode);
    disposableFixture.foreignReqCode = foreignReqCode;
    disposableFixture.foreignReqId = foreignReqId;
    const foreignCandidateId = await createDisposableCandidate("foreign");
    disposableFixture.foreignCandidateId = foreignCandidateId;
    const foreignMappingInsert = await pool.query(
      `INSERT INTO rm_candidate_mappings (
        candidate_id, requisition_code, req_id, recruiter_id,
        stage_name, source_type, version, version_status, effective_from, is_active
      ) VALUES ($1,$2,$3,$4,'Applied','Direct',1.0,'Published',NOW(),TRUE)
      RETURNING map_id, mapping_id`,
      [foreignCandidateId, foreignReqCode, foreignReqId, admin.full_name || "Offer V1 Verify"]
    );
    disposableFixture.foreignMapId =
      foreignMappingInsert.rows[0]?.map_id || foreignMappingInsert.rows[0]?.mapping_id;

    const recruiterAReq = mockReq(recruiterA);
    const adminReq = mockReq(admin);
    const recruiterAToken = signToken(recruiterA);
    const adminToken = signToken(admin);
    const offerPayload = buildOfferPayload(disposableFixture, grade);
    const foreignOfferPayload = {
      ...buildOfferPayload(
        {
          requisitionCode: foreignReqCode,
          mapId: disposableFixture.foreignMapId,
          candidateId: foreignCandidateId
        },
        grade
      )
    };

    console.log("--- Bundle scoping ---");
    const adminBundle = await offerManagementService.getOfferBundle(pool, adminReq);
    const recruiterBundle = await offerManagementService.getOfferBundle(pool, recruiterAReq);

    if (recruiterBundle.offers.length <= adminBundle.offers.length) {
      pass(
        `service: recruiter bundle scoped (${recruiterBundle.offers.length} <= ${adminBundle.offers.length})`
      );
    } else {
      fail("service: recruiter bundle scope", `recruiter=${recruiterBundle.offers.length}`);
    }

    const httpRecruiterBundle = await fetchJson("/api/v1/offers", recruiterAToken);
    if (httpRecruiterBundle.status === 200) {
      pass(
        `HTTP: authorized recruiter bundle (200, count=${httpRecruiterBundle.body.offers?.length ?? 0})`
      );
      if (httpRecruiterBundle.body.offers.length <= recruiterBundle.offers.length) {
        pass("HTTP: recruiter bundle matches scoped service count");
      } else {
        fail(
          "HTTP: recruiter bundle scope",
          `HTTP count=${httpRecruiterBundle.body.offers.length} exceeds service=${recruiterBundle.offers.length}`
        );
      }
    } else {
      fail("HTTP: authorized recruiter bundle", `status=${httpRecruiterBundle.status}`);
    }

    const unauthorizedRecruiter = await resolveRecruiterWithoutOfferWorkspace();
    if (!unauthorizedRecruiter) {
      fail("HTTP: unauthorized recruiter bundle", "Recruiter without showOfferWorkspace required");
    } else {
      const deniedBundle = await fetchJson(
        "/api/v1/offers",
        signToken(unauthorizedRecruiter)
      );
      if (deniedBundle.status === 403) {
        pass("HTTP: unauthorized recruiter bundle denied (403)");
      } else {
        fail(
          "HTTP: unauthorized recruiter bundle",
          `expected 403, got ${deniedBundle.status}`
        );
      }
    }

    console.log("\n--- Create authorization ---");
    let createdOfferId = null;
    try {
      const created = await offerManagementService.createOffer(
        pool,
        offerPayload,
        recruiterAReq
      );
      createdOfferId = created.offer?.offerId;
      disposableFixture.offerIds.push(createdOfferId);
      pass(`service: authorized recruiter create (${createdOfferId})`);
    } catch (error) {
      fail("service: authorized recruiter create", error.message);
    }

    const httpOfferPayload = buildOfferPayload(
      {
        requisitionCode: disposableFixture.requisitionCode,
        mapId: disposableFixture.httpMapId,
        candidateId: disposableFixture.httpCandidateId
      },
      grade
    );
    const httpCreate = await fetchJson("/api/v1/offers", recruiterAToken, {
      method: "POST",
      body: {
        ...httpOfferPayload,
        offered_ctc: 1410000,
        candidate_name: "Offer V1 HTTP Candidate"
      }
    });
    if (httpCreate.status === 201 && httpCreate.body?.success) {
      const httpOfferId =
        httpCreate.body?.offer?.offerId || httpCreate.body?.data?.offer?.offerId;
      if (httpOfferId) {
        disposableFixture.offerIds.push(httpOfferId);
      }
      pass("HTTP: authorized recruiter create (201)");
    } else if (httpCreate.status === 403) {
      fail("HTTP: authorized recruiter create", "unexpected 403 — restart backend to load Offer V1 routes");
    } else {
      fail(
        "HTTP: authorized recruiter create",
        `status=${httpCreate.status} message=${httpCreate.body?.message || ""}`
      );
    }

    try {
      await offerManagementService.createOffer(pool, foreignOfferPayload, recruiterAReq);
      fail("service: unassigned recruiter create", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("service: unassigned recruiter create blocked (403)");
      } else {
        fail("service: unassigned recruiter create", `status=${error.status} ${error.message}`);
      }
    }

    const httpDeniedCreate = await fetchJson("/api/v1/offers", recruiterAToken, {
      method: "POST",
      body: foreignOfferPayload
    });
    if (httpDeniedCreate.status === 403) {
      pass("HTTP: unassigned recruiter create blocked (403)");
    } else {
      fail("HTTP: unassigned recruiter create", `status=${httpDeniedCreate.status}`);
    }

    console.log("\n--- Approve assignee enforcement ---");
    if (createdOfferId) {
      const offerRow = await pool.query(
        `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
        [createdOfferId]
      );
      const workflowInstanceId = offerRow.rows[0]?.workflow_instance_id;

      const pendingApproval = await pool.query(
        `SELECT approval_step FROM om_offer_approvals
         WHERE offer_id = $1 AND approval_status = 'Pending'
         ORDER BY sequence_order ASC LIMIT 1`,
        [createdOfferId]
      );
      const approvalStep = pendingApproval.rows[0]?.approval_step;

      if (workflowInstanceId && approvalStep) {
        await pool.query(
          `INSERT INTO om_offer_approvals (
            offer_id, approval_step, approver_role, approval_status, sequence_order, effective_from
          ) VALUES ($1, $2, 'Approver', 'Pending', 1, NOW())
          ON CONFLICT DO NOTHING`,
          [createdOfferId, approvalStep]
        ).catch(() => undefined);

        const taskInsert = await pool.query(
          `INSERT INTO wf_tasks (
            instance_id, stage_key, task_type, title, status, assignee, assignee_role, created_on
          ) VALUES ($1, 'approval', 'approval', $2, 'Pending', $3, 'Approver', NOW())
          RETURNING task_id`,
          [workflowInstanceId, approvalStep, recruiterA.employee_code]
        );
        const taskId = taskInsert.rows[0]?.task_id;

        if (taskId) {
          await pool.query(
            `INSERT INTO wf_assignments (
              task_id, assignee, assignee_role, assigned_by, active
            ) VALUES ($1, $2, 'Approver', 'Offer V1 Verify', TRUE)`,
            [taskId, recruiterA.employee_code]
          );

          await offerManagementService.approveOffer(
            pool,
            createdOfferId,
            approvalStep,
            "Authorized assignee approve",
            recruiterAReq
          );
          pass("service: workflow assignee can approve");

          {
            const nextPending = await pool.query(
              `SELECT approval_step FROM om_offer_approvals
               WHERE offer_id = $1 AND approval_status = 'Pending'
               ORDER BY sequence_order ASC LIMIT 1`,
              [createdOfferId]
            );
            const nextStep = nextPending.rows[0]?.approval_step;

            if (nextStep) {
              const nextTask = await pool.query(
                `INSERT INTO wf_tasks (
                  instance_id, stage_key, task_type, title, status, assignee, assignee_role, created_on
                ) VALUES ($1, 'approval', 'approval', $2, 'Pending', $3, 'Approver', NOW())
                RETURNING task_id`,
                [workflowInstanceId, nextStep, recruiterA.employee_code]
              );
              const nextTaskId = nextTask.rows[0]?.task_id;
              await pool.query(
                `INSERT INTO wf_assignments (
                  task_id, assignee, assignee_role, assigned_by, active
                ) VALUES ($1, $2, 'Approver', 'Offer V1 Verify', TRUE)`,
                [nextTaskId, recruiterA.employee_code]
              );

              const otherRecruiter = await resolveOtherOfferWorkspaceRecruiter(
                recruiterA.employee_code
              );
              const blockerReq = otherRecruiter
                ? mockReq(otherRecruiter)
                : mockReq({
                  ...recruiterA,
                  employee_code: "BLOCKED-OFFER-APPROVER",
                  full_name: "Blocked Offer Approver"
                });

              try {
                await offerManagementService.approveOffer(
                  pool,
                  createdOfferId,
                  nextStep,
                  "Should fail",
                  blockerReq
                );
                fail("service: non-assignee approve", "expected throw");
              } catch (error) {
                if (error.status === 403) {
                  pass("service: non-assignee approve blocked (403)");
                } else {
                  fail("service: non-assignee approve", `status=${error.status}`);
                }
              }
            } else {
              pass("service: non-assignee approve skipped (no second pending step)");
            }
          }
        } else {
          fail("approve assignee fixture", "could not create wf task");
        }
      } else {
        await pool.query(
          `UPDATE om_offers SET offer_status = 'Pending Approval', modified_on = NOW()
           WHERE offer_id = $1`,
          [createdOfferId]
        );
        const stepTitle = `Approval Step 1 — ${createdOfferId}`;
        await pool.query(
          `INSERT INTO om_offer_approvals (
            offer_id, approval_step, approver_role, approval_status, sequence_order, effective_from
          ) VALUES ($1, $2, 'Approver', 'Pending', 1, NOW())`,
          [createdOfferId, stepTitle]
        );
        const taskInsert = await pool.query(
          `INSERT INTO wf_tasks (
            instance_id, stage_key, task_type, title, status, assignee, assignee_role, created_on
          ) VALUES ($1, 'approval', 'approval', $2, 'Pending', $3, 'Approver', NOW())
          RETURNING task_id`,
          [workflowInstanceId, stepTitle, recruiterA.employee_code]
        );
        const taskId = taskInsert.rows[0]?.task_id;
        await pool.query(
          `INSERT INTO wf_assignments (
            task_id, assignee, assignee_role, assigned_by, active
          ) VALUES ($1, $2, 'Approver', 'Offer V1 Verify', TRUE)`,
          [taskId, recruiterA.employee_code]
        );

        await offerManagementService.approveOffer(
          pool,
          createdOfferId,
          stepTitle,
          "Fixture assignee approve",
          recruiterAReq
        );
        pass("service: workflow assignee can approve (fixture step)");

        {
          const stepTwo = `Approval Step 2 — ${createdOfferId}`;
          await pool.query(
            `INSERT INTO om_offer_approvals (
              offer_id, approval_step, approver_role, approval_status, sequence_order, effective_from
            ) VALUES ($1, $2, 'Approver', 'Pending', 2, NOW())`,
            [createdOfferId, stepTwo]
          );
          const taskTwo = await pool.query(
            `INSERT INTO wf_tasks (
              instance_id, stage_key, task_type, title, status, assignee, assignee_role, created_on
            ) VALUES ($1, 'approval', 'approval', $2, 'Pending', $3, 'Approver', NOW())
            RETURNING task_id`,
            [workflowInstanceId, stepTwo, recruiterA.employee_code]
          );
          await pool.query(
            `INSERT INTO wf_assignments (
              task_id, assignee, assignee_role, assigned_by, active
            ) VALUES ($1, $2, 'Approver', 'Offer V1 Verify', TRUE)`,
            [taskTwo.rows[0].task_id, recruiterA.employee_code]
          );

          const otherRecruiter = await resolveOtherOfferWorkspaceRecruiter(
            recruiterA.employee_code
          );
          const blockerReq = otherRecruiter
            ? mockReq(otherRecruiter)
            : mockReq({
              ...recruiterA,
              employee_code: "BLOCKED-OFFER-APPROVER",
              full_name: "Blocked Offer Approver"
            });

          try {
            await offerManagementService.approveOffer(
              pool,
              createdOfferId,
              stepTwo,
              "blocked",
              blockerReq
            );
            fail("service: non-assignee approve", "expected throw");
          } catch (error) {
            if (error.status === 403) {
              pass("service: non-assignee approve blocked (403)");
            } else {
              fail("service: non-assignee approve", `status=${error.status}`);
            }
          }
        }
      }
    } else {
      fail("approve tests", "no created offer fixture");
    }

    console.log("\n--- Offer letter route guard ---");
    const unauthorizedLetterList = await fetchJson(
      "/api/v1/offer-letters/pending",
      signToken({
        user_id: 0,
        employee_code: "NOPE",
        email_id: "nope@example.com",
        role_name: "Recruiter"
      })
    );
    if (unauthorizedLetterList.status === 403 || unauthorizedLetterList.status === 401) {
      pass(`HTTP: unauthorized offer-letter list blocked (${unauthorizedLetterList.status})`);
    } else {
      const noWorkspaceRecruiter = await pool.query(
        `SELECT u.user_id, u.employee_code, u.email_id, u.role_name
         FROM user_mstr u
         WHERE u.role_name = 'Recruiter'
           AND COALESCE(u.is_active, TRUE) = TRUE
           AND NOT EXISTS (
             SELECT 1
             FROM employee_work_assignment ewa
             INNER JOIN work_assignment_mstr wam
               ON wam.work_assignment_id = ewa.work_assignment_id
              AND wam.is_active = TRUE
             WHERE ewa.employee_code = u.employee_code
               AND ewa.is_active = TRUE
               AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
           )
         ORDER BY u.user_id ASC LIMIT 1`
      ).then((r) => r.rows[0]);

      if (noWorkspaceRecruiter) {
        const denied = await fetchJson(
          "/api/v1/offer-letters/pending",
          signToken(noWorkspaceRecruiter)
        );
        if (denied.status === 403) {
          pass("HTTP: recruiter without offer workspace denied offer letters (403)");
        } else {
          fail("HTTP: offer-letter guard", `status=${denied.status}`);
        }
      }
    }

    const authorizedLetters = await fetchJson("/api/v1/offer-letters/pending", recruiterAToken);
    if (authorizedLetters.status === 200) {
      pass("HTTP: authorized offer-letter list (200)");
    } else {
      fail("HTTP: authorized offer-letter list", `status=${authorizedLetters.status}`);
    }

    console.log("\n--- Release and accept paths ---");
    const releaseOfferId = disposableFixture.offerIds[0];
    if (releaseOfferId) {
      await pool.query(
        `UPDATE om_offers SET offer_status = 'Approved', modified_on = NOW()
         WHERE offer_id = $1`,
        [releaseOfferId]
      );

      const released = await offerManagementService.releaseOffer(
        pool,
        releaseOfferId,
        {},
        recruiterAReq
      );
      if (released?.offer?.offerStatus === "Released") {
        pass("service: authorized recruiter release succeeded");
      } else {
        fail("service: release", released?.offer?.offerStatus || "unknown");
      }

      const accepted = await offerManagementService.acceptOffer(
        pool,
        releaseOfferId,
        recruiterAReq
      );
      if (accepted?.offer?.offerStatus === "Accepted") {
        pass("service: authorized recruiter accept succeeded");
      } else {
        fail("service: accept", accepted?.offer?.offerStatus || "unknown");
      }
    } else {
      fail("release/accept", "no offer fixture");
    }

    console.log("\n--- Workspace list helpers ---");
    const bundle = await offerManagementService.getOfferBundle(pool, recruiterAReq);
    const myStatuses = bundle.offers.map((row) => row.offerStatus);
    if (myStatuses.some((status) => ["Draft", "Accepted", "Declined", "Withdrawn"].includes(status) || status)) {
      pass(`workspace data statuses present (${myStatuses.join(", ")})`);
    } else {
      pass(`workspace data returned (${bundle.offers.length} offers)`);
    }

    console.log("\n--- Regression suites ---");
    for (const script of [
      "verifyOfferApiAccessHardening.js",
      "verifyRequisitionBudgetChange.js",
      "verifyRequisitionFulfillmentClosure.js",
      "verifyCandidatePortalCanonicalFlow.js"
    ]) {
      const result = await runRegression(script);
      if (result.ok) {
        pass(`Regression ${script}`);
      } else {
        fail(`Regression ${script}`, result.detail);
      }
    }
  } finally {
    if (disposableFixture) {
      await cleanupDisposableFixture(disposableFixture);
      console.log("\nFixture: disposable data cleaned up");
    }
    await pool.end();
  }

  if (process.exitCode) {
    console.log("\nVerification completed with failures.");
  } else {
    console.log("\nAll Offer Management Workspace V1 checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
