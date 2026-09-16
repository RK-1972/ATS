/**
 * Verification for interview management security fixes S1–S4 + S6.
 * Run: node scripts/verifyInterviewManagementSecurityFixes.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { spawnSync } = require("child_process");
const path = require("path");
const interviewService = require("../services/interviewService");
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

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
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
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function findPanelScheduleFixture() {
  const result = await pool.query(
    `SELECT s.schedule_id, ipm.employee_code AS panel_employee_code
     FROM interview_schedule_trn s
     INNER JOIN interview_panel_mstr ipm
       ON ipm.panel_id = s.interviewer_id
      AND ipm.is_active = true
     ORDER BY s.schedule_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function findAuthorizedMappingFixture(recruiterCode) {
  const result = await pool.query(
    `SELECT rcm.map_id, rcm.candidate_id, rcm.requisition_code
     FROM rm_candidate_mappings rcm
     INNER JOIN rm_recruiter_assignments a
       ON a.requisition_code = rcm.requisition_code
      AND a.is_active = true
      AND a.recruiter_code = $1
     WHERE rcm.is_active = true
       AND rcm.map_id IS NOT NULL
     ORDER BY rcm.modified_on DESC NULLS LAST
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
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

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
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
    ) VALUES ($1, $2, $3, 'Interview Security QA', 1, $4, 1000000, 'IVW Security Verify', 'IVW Security Verify')`,
    [code, reqId, `Interview Security ${code}`, REQUISITION_STATUS.APPROVED]
  );

  if (await tableExists("req_mstr")) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'IVW Security', 'Interview Security QA', $3, 'Disposable requisition', 1, $4, 'IVW Security Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, code.replace(/^REQ-/, "REQ"), `Interview Security ${code}`, REQUISITION_STATUS.APPROVED]
    );
  }

  return reqId;
}

async function createDisposableCandidate() {
  const email = `e2e.ivw.security.${RUN_ID}@example.com`;
  const result = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ('IVW', 'Security', $1, '9876500099', 'Java', 3, 'Applied', 'IVW Security Verify')
    RETURNING candidate_id`,
    [email]
  );
  return result.rows[0].candidate_id;
}

async function createDisposableAuthorizedFixture(recruiterA, admin) {
  const requisitionCode = `REQ-SEC-IVW-${RUN_ID}`;
  const reqId = await insertApprovedRequisition(requisitionCode);
  const adminReq = mockReq(admin);
  const recruiterReq = mockReq(recruiterA);

  await recruitmentService.assignRecruiter(
    pool,
    requisitionCode,
    recruiterA.employee_code,
    adminReq
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
    recruiterReq
  );

  const mapping = mapped.mapping || mapped;
  const mapId = mapping.map_id || mapping.mapping_id;

  return {
    disposable: true,
    requisitionCode,
    reqId,
    candidateId,
    map_id: mapId,
    mapping_id: mapping.mapping_id
  };
}

async function cleanupInterviewArtifacts(interviewId) {
  if (!interviewId) {
    return;
  }

  await pool.query(`DELETE FROM im_panel_assignments WHERE interview_id = $1`, [
    interviewId
  ]);
  await pool.query(`DELETE FROM im_interview_history WHERE interview_id = $1`, [
    interviewId
  ]).catch(() => undefined);
  await pool.query(`DELETE FROM et_tasks WHERE business_object_id = $1`, [
    interviewId
  ]).catch(() => undefined);

  const interviewRow = await pool.query(
    `SELECT schedule_id, workflow_instance_id
     FROM im_interviews
     WHERE interview_id = $1`,
    [interviewId]
  );
  const scheduleId = interviewRow.rows[0]?.schedule_id;
  const workflowInstanceId = interviewRow.rows[0]?.workflow_instance_id;

  if (scheduleId && (await tableExists("interview_schedule_trn"))) {
    await pool.query(`DELETE FROM interview_schedule_trn WHERE schedule_id = $1`, [
      scheduleId
    ]);
  }

  await pool.query(`DELETE FROM im_interviews WHERE interview_id = $1`, [
    interviewId
  ]);

  if (workflowInstanceId) {
    await pool.query(`DELETE FROM wf_stage_history WHERE instance_id = $1`, [
      workflowInstanceId
    ]).catch(() => undefined);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [
      workflowInstanceId
    ]).catch(() => undefined);
  }
}

async function cleanupInterviewsForMapId(mapId) {
  if (!mapId) {
    return;
  }

  const enterpriseInterviews = await pool.query(
    `SELECT interview_id FROM im_interviews WHERE map_id = $1`,
    [mapId]
  );
  for (const row of enterpriseInterviews.rows) {
    await cleanupInterviewArtifacts(row.interview_id);
  }

  if (await tableExists("interview_schedule_trn")) {
    await pool.query(`DELETE FROM interview_schedule_trn WHERE map_id = $1`, [mapId]);
  }
}

async function cleanupDisposableFixture(fixture) {
  if (!fixture?.disposable) {
    return;
  }

  if (fixture.scheduledInterviewId) {
    await cleanupInterviewArtifacts(fixture.scheduledInterviewId);
  }
  if (fixture.httpScheduledInterviewId) {
    await cleanupInterviewArtifacts(fixture.httpScheduledInterviewId);
  }
  await cleanupInterviewsForMapId(fixture.map_id);

  const codes = [fixture.requisitionCode];
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
    await pool.query(`DELETE FROM req_mstr WHERE req_id = $1`, [fixture.reqId]);
  }
}

async function resolvePanelMember() {
  const result = await pool.query(
    `SELECT panel_id, interviewer_name, email_id, interviewer_type
     FROM interview_panel_mstr
     WHERE COALESCE(is_active, TRUE) = TRUE
     ORDER BY panel_id
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveInterviewRoundType() {
  const fromMaster = await pool.query(
    `SELECT name
     FROM md_records
     WHERE entity_type = 'interview_types'
       AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC
     LIMIT 1`
  );

  if (fromMaster.rows[0]?.name) {
    return fromMaster.rows[0].name;
  }

  const fromExisting = await pool.query(
    `SELECT round_type
     FROM im_interviews
     WHERE round_type IS NOT NULL
     ORDER BY interview_id DESC
     LIMIT 1`
  );

  return fromExisting.rows[0]?.round_type || null;
}

async function findForeignMappingFixture(recruiterCode) {
  const result = await pool.query(
    `SELECT rcm.map_id
     FROM rm_candidate_mappings rcm
     WHERE rcm.is_active = true
       AND rcm.map_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.recruiter_code = $1
           AND a.is_active = true
           AND a.requisition_code = rcm.requisition_code
       )
       AND NOT EXISTS (
         SELECT 1
         FROM cand_mstr c
         WHERE c.candidate_id = rcm.candidate_id
           AND c.owner_employee_code = $1
       )
     ORDER BY rcm.modified_on DESC NULLS LAST
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
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
  console.log("=== Interview Management Security Fixes Verification ===\n");
  console.log(`Run ID: ${RUN_ID}\n`);

  let disposableFixture = null;

  try {
  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");
  const otherRecruiter = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Recruiter'
       AND COALESCE(is_active, TRUE) = TRUE
       AND employee_code <> $1
     ORDER BY user_id ASC
     LIMIT 1`,
    [recruiter?.employee_code || ""]
  ).then((r) => r.rows[0] || null);

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter required");
    return;
  }

  const panelFixture = await findPanelScheduleFixture();
  const panelUser = panelFixture
    ? (
      await pool.query(
        `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
         FROM user_mstr WHERE employee_code = $1 LIMIT 1`,
        [panelFixture.panel_employee_code]
      )
    ).rows[0]
    : null;

  let authorizedMapping = await findAuthorizedMappingFixture(recruiter.employee_code);

  if (!authorizedMapping?.map_id) {
    try {
      disposableFixture = await createDisposableAuthorizedFixture(recruiter, admin);
      authorizedMapping = {
        map_id: disposableFixture.map_id,
        candidate_id: disposableFixture.candidateId,
        requisition_code: disposableFixture.requisitionCode
      };
      console.log(
        `Fixture: created disposable mapping map_id=${authorizedMapping.map_id}, `
        + `requisition=${disposableFixture.requisitionCode}, recruiter=${recruiter.employee_code}`
      );
    } catch (error) {
      fail("fixtures", `disposable authorized mapping — ${error.message}`);
    }
  } else {
    console.log(
      `Fixture: existing mapping map_id=${authorizedMapping.map_id}, recruiter=${recruiter.employee_code}`
    );
  }

  let foreignMapping = null;
  if (otherRecruiter) {
    if (disposableFixture?.map_id) {
      foreignMapping = { map_id: disposableFixture.map_id };
    } else {
      foreignMapping = await findForeignMappingFixture(otherRecruiter.employee_code);
    }
  }

  const schedulePanel = await resolvePanelMember();
  const scheduleRoundType = await resolveInterviewRoundType();

  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);
  const otherRecruiterToken = otherRecruiter ? signToken(otherRecruiter) : null;
  const panelToken = panelUser ? signToken(panelUser) : null;

  console.log("--- S1 feedback-details ---");
  if (panelFixture && panelToken) {
    try {
      await interviewService.getFeedbackDetailsBySchedule(
        pool,
        panelFixture.schedule_id,
        { user: panelUser }
      );
      pass("S1 service: authorized panel member can load feedback-details");
    } catch (error) {
      fail("S1 service: authorized panel feedback-details", error.message);
    }

    const httpPanel = await fetchJson(
      `/feedback-details/${panelFixture.schedule_id}`,
      panelToken
    );
    if (httpPanel.status === 200 && httpPanel.body?.success) {
      pass("S1 HTTP: authorized panel feedback-details (200)");
    } else {
      fail("S1 HTTP: authorized panel feedback-details", `status=${httpPanel.status}`);
    }

    const httpRecruiter = await fetchJson(
      `/feedback-details/${panelFixture.schedule_id}`,
      recruiterToken
    );
    if (httpRecruiter.status === 403) {
      pass("S1 HTTP: unauthorized recruiter feedback-details blocked (403)");
    } else {
      fail("S1 HTTP: recruiter feedback-details IDOR", `status=${httpRecruiter.status}`);
    }
  } else {
    skip("S1 feedback-details", "no panel schedule fixture");
  }

  console.log("\n--- S2 interview bundle ---");
  const adminBundle = await interviewService.getInterviewBundle(pool, { user: admin });
  const recruiterBundle = await interviewService.getInterviewBundle(pool, { user: recruiter });
  const adminCount = adminBundle.interviews.length;
  const recruiterCount = recruiterBundle.interviews.length;

  if (recruiterCount <= adminCount) {
    pass(`S2 service: recruiter bundle scoped (${recruiterCount} <= ${adminCount})`);
  } else {
    fail("S2 service: recruiter bundle scope", `recruiter=${recruiterCount}, admin=${adminCount}`);
  }

  const httpAdminBundle = await fetchJson("/api/v1/interviews", adminToken);
  const httpRecruiterBundle = await fetchJson("/api/v1/interviews", recruiterToken);
  if (httpAdminBundle.status === 200 && Array.isArray(httpAdminBundle.body?.interviews)) {
    pass(`S2 HTTP: admin interview bundle (count=${httpAdminBundle.body.interviews.length})`);
  } else {
    fail("S2 HTTP: admin interview bundle", `status=${httpAdminBundle.status}`);
  }
  if (
    httpRecruiterBundle.status === 200
    && httpRecruiterBundle.body.interviews.length <= httpAdminBundle.body.interviews.length
  ) {
    pass(
      `S2 HTTP: recruiter bundle scoped (${httpRecruiterBundle.body.interviews.length} <= ${httpAdminBundle.body.interviews.length})`
    );
  } else {
    fail("S2 HTTP: recruiter bundle scope", `status=${httpRecruiterBundle.status}`);
  }

  console.log("\n--- S3 interview progress ---");
  if (authorizedMapping?.map_id) {
    try {
      await interviewService.getInterviewProgressByMapId(
        pool,
        authorizedMapping.map_id,
        { user: recruiter }
      );
      pass("S3 service: authorized recruiter can read progress");
    } catch (error) {
      fail("S3 service: authorized recruiter progress", error.message);
    }

    const httpAuthorized = await fetchJson(
      `/api/v1/interviews/progress/${authorizedMapping.map_id}`,
      recruiterToken
    );
    if (httpAuthorized.status === 200 && httpAuthorized.body?.success) {
      pass("S3 HTTP: authorized recruiter progress (200)");
    } else {
      fail("S3 HTTP: authorized recruiter progress", `status=${httpAuthorized.status}`);
    }
  } else {
    skip("S3 authorized progress", "no assigned mapping fixture");
  }

  if (foreignMapping?.map_id && otherRecruiterToken) {
    try {
      await interviewService.getInterviewProgressByMapId(
        pool,
        foreignMapping.map_id,
        { user: otherRecruiter }
      );
      fail("S3 service: unrelated recruiter progress", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("S3 service: unrelated recruiter progress blocked (403)");
      } else {
        fail("S3 service: unrelated recruiter progress", `status=${error.status}`);
      }
    }

    const httpDenied = await fetchJson(
      `/api/v1/interviews/progress/${foreignMapping.map_id}`,
      otherRecruiterToken
    );
    if (httpDenied.status === 403) {
      pass("S3 HTTP: unrelated recruiter progress blocked (403)");
    } else {
      fail("S3 HTTP: unrelated recruiter progress", `status=${httpDenied.status}`);
    }
  } else {
    skip("S3 unrelated progress", "no foreign mapping fixture");
  }

  console.log("\n--- S4 schedule authorization ---");
  if (authorizedMapping?.map_id && schedulePanel && scheduleRoundType) {
    const scheduleDate = new Date();
    scheduleDate.setDate(scheduleDate.getDate() + 5);
    const interviewDate = scheduleDate.toISOString().slice(0, 10);
    const schedulePayload = {
      map_id: authorizedMapping.map_id,
      req_id: disposableFixture?.reqId || undefined,
      interviewer_id: schedulePanel.panel_id,
      round_type: scheduleRoundType,
      interview_date: interviewDate,
      interview_time: "11:30",
      interviewer_name: schedulePanel.interviewer_name,
      interviewer_email: schedulePanel.email_id,
      remarks: `IVW security verify ${RUN_ID}`
    };

    try {
      const scheduled = await interviewService.scheduleInterview(
        pool,
        schedulePayload,
        mockReq(recruiter)
      );
      if (scheduled?.interviewId) {
        if (disposableFixture) {
          disposableFixture.scheduledInterviewId = scheduled.interviewId;
        } else {
          await cleanupInterviewArtifacts(scheduled.interviewId);
        }
        pass(`S4 service: authorized recruiter schedule succeeded (interviewId=${scheduled.interviewId})`);
      } else {
        fail("S4 service: authorized recruiter schedule", "missing interviewId");
      }
    } catch (error) {
      fail("S4 service: authorized recruiter schedule", error.message);
    }

    const httpAuthorizedSchedule = await fetchJson("/schedule-interview", recruiterToken, {
      method: "POST",
      body: JSON.stringify({
        map_id: authorizedMapping.map_id,
        interviewer_id: schedulePanel.panel_id,
        round_type: scheduleRoundType,
        interview_date: interviewDate,
        interview_time: "12:00"
      })
    });
    if (
      (httpAuthorizedSchedule.status === 200 || httpAuthorizedSchedule.status === 201)
      && httpAuthorizedSchedule.body?.success
    ) {
      const httpInterviewId =
        httpAuthorizedSchedule.body?.data?.interviewId
        || httpAuthorizedSchedule.body?.data?.interview_id
        || httpAuthorizedSchedule.body?.interviewId
        || httpAuthorizedSchedule.body?.data?.enterprise?.interviewId;
      if (httpInterviewId) {
        if (disposableFixture) {
          disposableFixture.httpScheduledInterviewId = httpInterviewId;
        } else {
          await cleanupInterviewArtifacts(httpInterviewId);
        }
      }
      pass("S4 HTTP: authorized recruiter schedule (200)");
    } else {
      fail(
        "S4 HTTP: authorized recruiter schedule",
        `status=${httpAuthorizedSchedule.status} message=${httpAuthorizedSchedule.body?.message || ""}`
      );
    }
  } else if (!authorizedMapping?.map_id) {
    skip("S4 authorized schedule", "no assigned mapping fixture");
  } else {
    skip("S4 authorized schedule", "no interview panel or round_type fixture");
  }

  if (foreignMapping?.map_id && otherRecruiter) {
    try {
      await interviewService.scheduleInterview(
        pool,
        {
          map_id: foreignMapping.map_id,
          interviewer_id: 1,
          round_type: "L1 Technical",
          interview_date: "2099-12-31",
          interview_time: "10:00"
        },
        { user: otherRecruiter }
      );
      fail("S4 service: unrelated recruiter schedule", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("S4 service: unrelated recruiter schedule blocked (403)");
      } else {
        fail("S4 service: unrelated recruiter schedule", `status=${error.status}`);
      }
    }

    if (otherRecruiterToken) {
      const httpDeniedSchedule = await fetchJson("/schedule-interview", otherRecruiterToken, {
        method: "POST",
        body: JSON.stringify({
          map_id: foreignMapping.map_id,
          interviewer_id: 1,
          round_type: "L1 Technical",
          interview_date: "2099-12-31",
          interview_time: "10:00"
        })
      });
      if (httpDeniedSchedule.status === 403) {
        pass("S4 HTTP: unrelated recruiter schedule blocked (403)");
      } else {
        fail("S4 HTTP: unrelated recruiter schedule", `status=${httpDeniedSchedule.status}`);
      }
    }
  } else {
    skip("S4 unrelated schedule", "no foreign mapping fixture");
  }

  console.log("\n--- S6 interview panel mutations ---");
  const panelPostRecruiter = await fetchJson("/interview-panel", recruiterToken, {
    method: "POST",
    body: JSON.stringify({ user_id: admin.user_id, interviewer_type: "Technical" })
  });
  if (panelPostRecruiter.status === 403) {
    pass("S6 HTTP: non-admin panel POST blocked (403)");
  } else {
    fail("S6 HTTP: non-admin panel POST", `status=${panelPostRecruiter.status}`);
  }

  const panelGetRecruiter = await fetchJson("/interview-panel", recruiterToken);
  if (panelGetRecruiter.status === 200) {
    pass("S6 HTTP: panel GET still available to recruiter (200)");
  } else {
    fail("S6 HTTP: panel GET", `status=${panelGetRecruiter.status}`);
  }

  const panelList = await pool.query(
    `SELECT panel_id FROM interview_panel_mstr ORDER BY panel_id ASC LIMIT 1`
  );
  if (panelList.rows[0]?.panel_id) {
    const panelPutRecruiter = await fetchJson(
      `/interview-panel/${panelList.rows[0].panel_id}`,
      recruiterToken,
      {
        method: "PUT",
        body: JSON.stringify({
          employee_code: "TEST",
          interviewer_name: "Test",
          interviewer_type: "Technical"
        })
      }
    );
    if (panelPutRecruiter.status === 403) {
      pass("S6 HTTP: non-admin panel PUT blocked (403)");
    } else {
      fail("S6 HTTP: non-admin panel PUT", `status=${panelPutRecruiter.status}`);
    }
  }

  console.log("\n--- Regression suites ---");
  for (const script of [
    "verifyInterviewFeedbackAccessHardening.js",
    "verifyInterviewSchedulesRecruiterScope.js",
    "verifyPhase6c5InterviewScheduleNotification.js"
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
    console.log("\nAll interview management security checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
