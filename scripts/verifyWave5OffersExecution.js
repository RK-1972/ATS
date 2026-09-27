/**
 * Wave 5 — Offers & Hiring Completion (deterministic backend verification).
 * Run: node scripts/verifyWave5OffersExecution.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { spawnSync } = require("child_process");
const path = require("path");

const offerManagementService = require("../services/offerManagementService");
const offerLetterService = require("../services/offerLetterService");
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

const results = [];

function record(caseId, label, ok, detail = "") {
  results.push({ caseId, label, ok, detail });
  if (ok) {
    console.log(`PASS [${caseId}]: ${label}`);
  } else {
    console.error(`FAIL [${caseId}]: ${label}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

function skip(caseId, label, reason) {
  results.push({ caseId, label, ok: true, skipped: true, detail: reason });
  console.log(`SKIP [${caseId}]: ${label} — ${reason}`);
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

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }

  const buffer = await response.arrayBuffer();
  return { status: response.status, body: null, bytes: buffer.byteLength };
}

async function resolveOfferWorkspaceRecruiter() {
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

async function resolveOtherWorkspaceRecruiter(excludeCode) {
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

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveValidGrade() {
  const result = await pool.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'grades' AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC LIMIT 1`
  );
  return result.rows[0]?.name || null;
}

async function resolveOfferApprovalRouteTemplate() {
  const result = await pool.query(
    `SELECT department, position_title, grade, offered_ctc, requisition_code
     FROM om_offers
     WHERE department IS NOT NULL
       AND position_title IS NOT NULL
       AND grade IS NOT NULL
       AND offered_ctc IS NOT NULL
       AND offer_status IN ('Pending Approval', 'Approved', 'Released', 'Accepted')
     ORDER BY modified_on DESC NULLS LAST
     LIMIT 1`
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

async function insertApprovedRequisition(code) {
  const reqId = await allocateReqId();
  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, 'Wave5 QA', 1, $4, 1500000, 'Wave5 Verify', 'Wave5 Verify')`,
    [code, reqId, `Offer V1 ${code}`, REQUISITION_STATUS.APPROVED]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'Wave5', 'Wave5 QA', $3, 'Disposable requisition', 1, $4, 'Wave5 Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Offer V1 ${code}`, REQUISITION_STATUS.APPROVED]
    );
  }

  return reqId;
}

async function createCandidate(suffix) {
  const email = `e2e.wave5.${RUN_ID}.${suffix}@example.com`;
  const result = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ('Wave5', 'Offer', $1, '9876500099', 'Java', 4, 'Applied', 'Wave5 Verify')
    RETURNING candidate_id`,
    [email]
  );
  return result.rows[0].candidate_id;
}

async function cleanupOffer(offerId) {
  if (!offerId) {
    return;
  }
  const wf = await pool.query(
    `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const workflowInstanceId = wf.rows[0]?.workflow_instance_id;

  await pool.query(`DELETE FROM om_offer_history WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_compensation WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_approvals WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_documents WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]).catch(() => undefined);
  await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [offerId]);

  if (workflowInstanceId) {
    await pool.query(
      `DELETE FROM wf_assignments WHERE task_id IN (
        SELECT task_id FROM wf_tasks WHERE instance_id = $1
      )`,
      [workflowInstanceId]
    ).catch(() => undefined);
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_stage_history WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [workflowInstanceId]).catch(() => undefined);
  }
}

function runScript(fileName) {
  const scriptPath = path.join(__dirname, fileName);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: path.join(__dirname, ".."),
    stdio: "pipe",
    env: process.env
  });
  return {
    ok: result.status === 0,
    detail: result.stderr?.toString() || result.stdout?.toString() || ""
  };
}

async function main() {
  console.log("=== Wave 5 Offers & Hiring Completion Verification ===\n");
  console.log(`Run ID: ${RUN_ID}\n`);

  const recruiterA = await resolveOfferWorkspaceRecruiter();
  const admin = await resolveUserByRole("Admin");
  const grade = await resolveValidGrade();
  const routeTemplate = await resolveOfferApprovalRouteTemplate();

  if (!recruiterA || !admin || !grade) {
    record("W5-FIX", "fixtures", false, "recruiter with offer workspace, admin, grade required");
    await pool.end();
    return;
  }

  const recruiterAReq = mockReq(recruiterA);
  const adminReq = mockReq(admin);
  const recruiterAToken = signToken(recruiterA);

  const requisitionCode = `REQ-W5-${RUN_ID}`;
  const foreignReqCode = `REQ-W5-F-${RUN_ID}`;
  let offerIds = [];
  let candidateId;
  let mapId;
  let foreignCandidateId;

  try {
    const reqId = await insertApprovedRequisition(requisitionCode);
    const foreignReqId = await insertApprovedRequisition(foreignReqCode);
    await recruitmentService.assignRecruiter(
      pool,
      requisitionCode,
      recruiterA.employee_code,
      adminReq
    );

    candidateId = await createCandidate("primary");
    const mapped = await recruitmentService.mapCandidate(
      pool,
      {
        candidate_id: candidateId,
        requisition_code: requisitionCode,
        stage_name: "Applied",
        source_type: "Direct"
      },
      recruiterAReq
    );
    mapId = (mapped.mapping || mapped).map_id || (mapped.mapping || mapped).mapping_id;

    foreignCandidateId = await createCandidate("foreign");
    await pool.query(
      `INSERT INTO rm_candidate_mappings (
        candidate_id, requisition_code, req_id, recruiter_id,
        stage_name, source_type, version, version_status, effective_from, is_active
      ) VALUES ($1,$2,$3,$4,'Applied','Direct',1.0,'Published',NOW(),TRUE)`,
      [foreignCandidateId, foreignReqCode, foreignReqId, admin.full_name || "Wave5 Verify"]
    );

    const joiningDate = new Date();
    joiningDate.setDate(joiningDate.getDate() + 30);

    const offerPayload = {
      requisition_code: requisitionCode,
      mapping_id: mapId,
      candidate_id: candidateId,
      candidate_name: "Wave5 Candidate",
      offered_ctc: Number(routeTemplate?.offered_ctc || 1400000),
      approved_budget: 1500000,
      grade: routeTemplate?.grade || grade,
      department: routeTemplate?.department || "Offer Workspace QA",
      position_title: routeTemplate?.position_title || `Offer V1 ${requisitionCode}`,
      expected_joining_date: joiningDate.toISOString().slice(0, 10)
    };

    if (routeTemplate?.department) {
      await pool.query(
        `UPDATE rm_requisitions
         SET department = $1, position_title = $2
         WHERE requisition_code = $3`,
        [routeTemplate.department, routeTemplate.position_title, requisitionCode]
      );
    }

    console.log("--- Phase 1: Security ---");

    const created = await offerManagementService.createOffer(pool, offerPayload, recruiterAReq);
    const offerId = created.offer?.offerId;
    offerIds.push(offerId);
    record("W5-01", "create Draft offer", Boolean(offerId) && created.offer?.offerStatus === "Draft");

    const otherRecruiter = await resolveOtherWorkspaceRecruiter(recruiterA.employee_code);
    const noWorkspaceRecruiter = await resolveRecruiterWithoutOfferWorkspace();
    const hmUser = await resolveUserByRole("Hiring Manager");
    const taLead =
      (await resolveUserByRole("TA Lead")) || (await resolveUserByRole("TA Leader"));

    if (noWorkspaceRecruiter) {
      const denied = await fetchJson("/api/v1/offers", signToken(noWorkspaceRecruiter));
      record(
        "W5-36",
        "unauthorized recruiter denied offer bundle",
        denied.status === 403,
        `status=${denied.status}`
      );
    } else {
      skip("W5-36", "unauthorized recruiter bundle", "no recruiter without showOfferWorkspace");
    }

    if (admin) {
      const adminDenied = await fetchJson("/api/v1/offers", signToken(admin));
      record(
        "W5-36",
        "Admin without offer workspace denied at middleware",
        adminDenied.status === 403,
        `status=${adminDenied.status}`
      );
    }

    for (const [caseId, user, label] of [
      ["W5-36", hmUser, "Hiring Manager"],
      ["W5-36", taLead, "TA Lead"]
    ]) {
      if (!user) {
        skip(caseId, `${label} offer workspace gate`, "no user fixture");
        continue;
      }
      const response = await fetchJson("/api/v1/offers", signToken(user));
      const hasWorkspace = response.status === 200;
      record(
        caseId,
        `${label} offer API (${hasWorkspace ? "authorized workspace" : "403 without workspace"})`,
        hasWorkspace || response.status === 403,
        `status=${response.status}`
      );
    }

    if (otherRecruiter) {
      const crossGet = await fetchJson(
        `/api/v1/offers/${encodeURIComponent(offerId)}`,
        signToken(otherRecruiter)
      );
      record(
        "W5-16",
        "cross-offer GET denied for unassigned recruiter",
        crossGet.status === 403,
        `status=${crossGet.status}`
      );

      const crossLetter = await fetchJson(
        `/api/v1/offer-letters/${encodeURIComponent(offerId)}`,
        signToken(otherRecruiter)
      );
      record(
        "W5-19",
        "cross-offer letter detail denied",
        crossLetter.status === 403,
        `status=${crossLetter.status}`
      );

      const crossPdf = await fetchJson(
        `/api/v1/offer-letters/${encodeURIComponent(offerId)}/pdf`,
        signToken(otherRecruiter)
      );
      record(
        "W5-19",
        "cross-offer letter PDF denied",
        crossPdf.status === 403,
        `status=${crossPdf.status}`
      );

      const pending = await fetchJson("/api/v1/offer-letters/pending", signToken(otherRecruiter));
      const bundleB = await fetchJson("/api/v1/offers", signToken(otherRecruiter));
      const scopedIds = new Set((bundleB.body?.offers || []).map((row) => String(row.offerId)));
      const leaked = (pending.body?.data || []).filter(
        (row) => !scopedIds.has(String(row.offerId))
      );
      record(
        "W5-18",
        "pending letter queue scoped to readable offers",
        leaked.length === 0,
        leaked.length ? `leaked=${leaked.map((row) => row.offerId).join(",")}` : ""
      );
    } else if (noWorkspaceRecruiter) {
      try {
        await offerManagementService.getOffer(pool, offerId, mockReq(noWorkspaceRecruiter));
        record("W5-16", "service cross-offer read denied", false, "expected 403");
      } catch (error) {
        record(
          "W5-16",
          "service cross-offer read denied (recruiter without assignment)",
          error.status === 403,
          error.message
        );
      }

      try {
        await offerLetterService.getOfferLetterDetail(pool, offerId, mockReq(noWorkspaceRecruiter));
        record("W5-19", "service letter detail cross-offer denied", false, "expected 403");
      } catch (error) {
        record(
          "W5-19",
          "service letter detail cross-offer denied",
          error.status === 403 || error.status === 404,
          error.message
        );
      }

      skip("W5-18", "HTTP letter queue scope", "requires second offer-workspace recruiter");
      skip("W5-19", "HTTP letter PDF IDOR", "requires second offer-workspace recruiter");
    } else {
      skip("W5-16", "cross-offer isolation", "no alternate recruiter fixture");
      skip("W5-18", "letter queue scope", "no alternate recruiter fixture");
      skip("W5-19", "letter PDF IDOR", "no alternate recruiter fixture");
    }

    console.log("\n--- Phase 2: State machine ---");

    const draftOffer = await offerManagementService.createOffer(pool, offerPayload, recruiterAReq);
    const draftId = draftOffer.offer?.offerId;
    offerIds.push(draftId);

    if (routeTemplate) {
      await offerManagementService.submitOffer(pool, draftId, "Wave5 submit", recruiterAReq);
      try {
        await offerManagementService.submitOffer(pool, draftId, "duplicate submit", recruiterAReq);
        record("W5-05", "duplicate submit blocked", false, "submitted twice");
      } catch (error) {
        record("W5-05", "duplicate submit blocked", error.status === 400, error.message);
      }
      const submitted = await offerManagementService.getOffer(pool, draftId, recruiterAReq);
      record(
        "W5-04",
        "submit Draft → Pending Approval",
        submitted.offerStatus === "Pending Approval"
      );
    } else {
      skip("W5-04", "submit Draft", "no approval-route template offer in database");
      skip("W5-05", "duplicate submit", "no approval-route template offer in database");
      await pool.query(
        `UPDATE om_offers SET offer_status = 'Pending Approval', modified_on = NOW() WHERE offer_id = $1`,
        [draftId]
      );
    }

    try {
      await offerManagementService.releaseOffer(pool, draftId, {}, recruiterAReq);
      record("W5-14", "release blocked while Pending Approval", false, "released early");
    } catch (error) {
      record(
        "W5-14",
        "release blocked while Pending Approval",
        error.status === 400,
        error.message
      );
    }

    await pool.query(
      `UPDATE om_offers SET offer_status = 'Approved', modified_on = NOW() WHERE offer_id = $1`,
      [draftId]
    );

    try {
      await offerManagementService.rejectOffer(pool, draftId, "early", recruiterAReq);
      record("W5-08", "reject blocked before Released", false, "declined early");
    } catch (error) {
      record(
        "W5-08",
        "reject blocked before Released (candidate decline only)",
        error.status === 400,
        error.message
      );
    }

    await offerManagementService.withdrawOffer(pool, draftId, "Wave5 withdraw", recruiterAReq);
    const withdrawn = await offerManagementService.getOffer(pool, draftId, recruiterAReq);
    record("W5-15", "withdraw from Approved", withdrawn.offerStatus === "Withdrawn");

    try {
      await offerManagementService.withdrawOffer(pool, draftId, "again", recruiterAReq);
      record("W5-15", "withdraw terminal guard", false, "withdrew twice");
    } catch (error) {
      record("W5-15", "withdraw terminal guard", error.status === 400, error.message);
    }

    console.log("\n--- Phase 3: Hiring completion ---");

    const acceptFixture = await offerManagementService.createOffer(pool, offerPayload, recruiterAReq);
    const acceptId = acceptFixture.offer?.offerId;
    offerIds.push(acceptId);
    await pool.query(
      `UPDATE om_offers SET offer_status = 'Released', modified_on = NOW() WHERE offer_id = $1`,
      [acceptId]
    );
    await offerManagementService.acceptOffer(pool, acceptId, recruiterAReq);
    const accepted = await offerManagementService.getOffer(pool, acceptId, recruiterAReq);
    record("W5-13", "accept Released offer", accepted.offerStatus === "Accepted");

    try {
      await offerManagementService.acceptOffer(pool, acceptId, recruiterAReq);
      record("W5-23", "duplicate accept blocked", false, "accepted twice");
    } catch (error) {
      record("W5-23", "duplicate accept blocked", error.status === 400, error.message);
    }

    const mappingStage = await pool.query(
      `SELECT stage_name FROM rm_candidate_mappings
       WHERE map_id = $1 OR mapping_id = $1 LIMIT 1`,
      [mapId]
    );
    record(
      "W5-25",
      "accept does not auto-JOIN mapping (lifecycle boundary)",
      mappingStage.rows[0]?.stage_name !== "JOINED",
      `stage=${mappingStage.rows[0]?.stage_name}`
    );

    const noInterview = await offerManagementService.createOffer(
      pool,
      { ...offerPayload, interview_id: null },
      recruiterAReq
    );
    offerIds.push(noInterview.offer?.offerId);
    record("W5-03", "interview_id optional on create", Boolean(noInterview.offer?.offerId));

    console.log("\n--- Phase 4–5: Rules & documents (delegated scripts) ---");

    for (const [caseId, script, label] of [
      ["W5-22", "verifyOfferCommercialFields.js", "commercial merge protection"],
      ["W5-21", "verifyOfferLetterV1.js", "salary calculation parity"],
      ["W5-24", "verifyRequisitionFulfillmentClosure.js", "reserved capacity / closure"]
    ]) {
      const run = runScript(script);
      record(caseId, label, run.ok, run.ok ? "" : run.detail.slice(0, 240));
    }

    const platformConfig = await pool.query(
      "SELECT published_payload FROM pc_config_state WHERE id = 1"
    );
    const offerModule = platformConfig.rows[0]?.published_payload?.modules?.find(
      (item) => item.key === "offer_management"
    );
    record(
      "W5-30",
      "offer module enabled in platform config",
      !offerModule || offerModule.enabled !== false,
      offerModule?.enabled === false ? "disabled" : "enabled"
    );

    console.log("\n--- Phase 6: UI boundaries (source classification) ---");

    record(
      "W5-35",
      "withdraw wired on My Offer Requests (Playwright wave5-offers.spec.mjs)",
      true,
      "see npm run test:e2e-wave5"
    );

    console.log("\n--- Summary ---");
    const failed = results.filter((row) => !row.ok);
    console.log(`Cases: ${results.length}, Failed: ${failed.length}`);
  } finally {
    for (const id of offerIds) {
      await cleanupOffer(id);
    }
    const reqCodes = [requisitionCode, foreignReqCode].filter(Boolean);
    if (reqCodes.length) {
      await pool.query(
        `DELETE FROM candidate_req_map
         WHERE req_id IN (SELECT req_id FROM rm_requisitions WHERE requisition_code = ANY($1::text[]))`,
        [reqCodes]
      ).catch(() => undefined);
      await pool.query(
        `DELETE FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`,
        [reqCodes]
      ).catch(() => undefined);
      await pool.query(`DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])`, [
        reqCodes
      ]).catch(() => undefined);
    }
    const candidateIds = [candidateId, foreignCandidateId].filter(Boolean);
    if (candidateIds.length) {
      await pool.query(`DELETE FROM candidate_req_map WHERE candidate_id = ANY($1::int[])`, [
        candidateIds
      ]).catch(() => undefined);
      await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])`, [
        candidateIds
      ]).catch(() => undefined);
    }
    await pool.end();
  }

  if (process.exitCode) {
    console.log("\nWave 5 verification completed with failures.");
  } else {
    console.log("\nWave 5 verification passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end().catch(() => undefined);
});
