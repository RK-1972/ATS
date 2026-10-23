/**
 * HR interview feedback read authorization — HTTP/JWT + service parity.
 * Run: node scripts/verifyInterviewHrFeedbackReadAuth.js
 * Requires backend at API_BASE_URL (default http://localhost:5000) using current working-tree code.
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const interviewService = require("../services/interviewService");
const recruitmentService = require("../services/recruitmentService");
const {
  canReadHrInterviewFeedback,
  isHrInterviewRound
} = require("../services/interviewFeedbackConfidentialityService");
const { OFFER_WORKSPACE_FLAG } = require("../services/offerCapabilityAuth");

const API_BASE_URL = String(process.env.API_BASE_URL || "http://localhost:5000").replace(
  /\/$/,
  ""
);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const SYNTHETIC_TA_LEAD = {
  user_id: 999_999_001,
  employee_code: "VERIFY_TA_LEAD_HTTP",
  email_id: "verify-ta-lead-http@local.invalid",
  role_name: "TA Lead",
  secondary_role: null
};

const SYNTHETIC_TA_LEADER_NO_MAP = {
  user_id: 999_999_004,
  employee_code: "VERIFY_TA_LEADER_HTTP_NOMAP",
  email_id: "verify-ta-leader-nomap@local.invalid",
  role_name: "TA Leader",
  secondary_role: null
};

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

async function fetchJson(path, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function assertBackendReachable() {
  const health = await fetch(`${API_BASE_URL}/health-test`).catch(() => null);

  if (!health || !health.ok) {
    fail(
      "HTTP: backend reachable",
      `Could not reach ${API_BASE_URL}/health-test — start backend with current code (npm start)`
    );
    return false;
  }

  pass(`HTTP: backend reachable at ${API_BASE_URL}`);
  return true;
}

async function userHasMappingAccess(pool, user, mapId) {
  if (!user || mapId == null || mapId === "") {
    return false;
  }

  try {
    await recruitmentService.assertAuthorizedMappingAccess(pool, { user }, mapId);
    return true;
  } catch {
    return false;
  }
}

async function findForeignMapIdForUser(pool, user, excludeMapId) {
  const result = await pool.query(
    `SELECT map_id
     FROM rm_candidate_mappings
     WHERE COALESCE(is_active, TRUE) = TRUE
       AND map_id IS NOT NULL
       AND map_id::text <> $1::text
     ORDER BY mapping_id DESC
     LIMIT 50`,
    [String(excludeMapId)]
  );

  for (const row of result.rows) {
    if (!(await userHasMappingAccess(pool, user, row.map_id))) {
      return row.map_id;
    }
  }

  return null;
}

function bundleExposesHrOutcomeMetadata(interviews) {
  return (interviews || []).some((row) => {
    if (!isHrInterviewRound(row.roundType || row.round_type)) {
      return false;
    }

    if (row.finalOutcome != null && String(row.finalOutcome).trim() !== "") {
      return true;
    }

    if (row.final_outcome != null && String(row.final_outcome).trim() !== "") {
      return true;
    }

    return row.feedbackSubmitted === true || row.feedback_submitted === true;
  });
}

function interviewEntriesForMap(interviews, mapId) {
  return (interviews || []).filter(
    (row) => String(row.mapId || row.map_id) === String(mapId)
  );
}

async function listNonHrInterviewsWithOutcomeForMap(pool, mapId) {
  const result = await pool.query(
    `SELECT interview_id, schedule_id, round_type, final_outcome, feedback_submitted
     FROM im_interviews
     WHERE map_id = $1
       AND COALESCE(feedback_submitted, FALSE) = TRUE
       AND final_outcome IS NOT NULL
       AND TRIM(final_outcome::text) <> ''
       AND NOT (
         LOWER(TRIM(round_type)) LIKE '%hr%'
         OR round_type IN ('HR Round', 'HR Interview', 'HR')
       )`,
    [mapId]
  );

  return result.rows;
}

async function findHrInterviewRowWithOutcomeForMap(pool, mapId) {
  const result = await pool.query(
    `SELECT interview_id, schedule_id, round_type, final_outcome, feedback_submitted
     FROM im_interviews
     WHERE map_id = $1
       AND COALESCE(feedback_submitted, FALSE) = TRUE
       AND final_outcome IS NOT NULL
       AND TRIM(final_outcome::text) <> ''
       AND (
         LOWER(TRIM(round_type)) LIKE '%hr%'
         OR round_type IN ('HR Round', 'HR Interview', 'HR')
       )
     ORDER BY interview_id DESC
     LIMIT 1`,
    [mapId]
  );

  return result.rows[0] || null;
}

async function assertRecruiterBundleHrRedactionHttp(recruiterUser, mapId) {
  const http = await fetchJson("/api/v1/interviews", signToken(recruiterUser));

  if (http.status !== 200 || !Array.isArray(http.body?.interviews)) {
    fail("HTTP: recruiter interview bundle", `status=${http.status}`);
    return;
  }

  const serviceBundle = await interviewService.getInterviewBundle(pool, {
    user: recruiterUser
  });

  if (bundleExposesHrOutcomeMetadata(serviceBundle.interviews)) {
    fail(
      "Service: recruiter bundle HR outcome leak",
      `employee=${recruiterUser.employee_code}`
    );
    return;
  }

  if (bundleExposesHrOutcomeMetadata(http.body.interviews)) {
    fail(
      "HTTP: recruiter interview bundle HR outcome leak (raw response)",
      `employee=${recruiterUser.employee_code} — GET /api/v1/interviews must apply sanitizeInterviewBundleForCaller`
    );
    return;
  }

  pass(
    `HTTP: recruiter interview bundle omits HR outcome metadata (${recruiterUser.employee_code})`
  );

  const nonHrDb = await listNonHrInterviewsWithOutcomeForMap(pool, mapId);

  if (!nonHrDb.length) {
    skip(
      "HTTP: recruiter bundle preserves L1/L2 outcomes",
      "no non-HR submitted outcomes on fixture map_id"
    );
    return;
  }

  const bundleOnMap = interviewEntriesForMap(http.body.interviews, mapId);
  let checked = 0;

  for (const dbRow of nonHrDb) {
    const bundleRow = bundleOnMap.find(
      (row) =>
        String(row.scheduleId || row.schedule_id) === String(dbRow.schedule_id)
        || String(row.interviewId || row.interview_id) === String(dbRow.interview_id)
    );

    if (!bundleRow) {
      continue;
    }

    checked += 1;
    const outcome = bundleRow.finalOutcome ?? bundleRow.final_outcome;

    if (outcome == null || String(outcome).trim() === "") {
      fail(
        "HTTP: recruiter bundle L1/L2 outcome preserved",
        `schedule_id=${dbRow.schedule_id} round=${dbRow.round_type}`
      );
      return;
    }
  }

  if (checked === 0) {
    skip(
      "HTTP: recruiter bundle preserves L1/L2 outcomes",
      "recruiter bundle has no overlapping non-HR rows on fixture map"
    );
    return;
  }

  pass("HTTP: recruiter bundle preserves non-HR outcome metadata on fixture map");
}

async function assertAuthorizedBundleHrOutcomeHttp(readerUser, mapId) {
  const hrDb = await findHrInterviewRowWithOutcomeForMap(pool, mapId);

  if (!hrDb) {
    skip("HTTP: authorized reader bundle HR outcome", "no HR row with outcome on fixture map");
    return;
  }

  const http = await fetchJson("/api/v1/interviews", signToken(readerUser));

  if (http.status !== 200 || !Array.isArray(http.body?.interviews)) {
    fail("HTTP: authorized reader interview bundle", `status=${http.status}`);
    return;
  }

  const bundleRow = (http.body.interviews || []).find((row) => {
    if (!isHrInterviewRound(row.roundType || row.round_type)) {
      return false;
    }

    if (hrDb.schedule_id != null) {
      return String(row.scheduleId || row.schedule_id) === String(hrDb.schedule_id);
    }

    return String(row.interviewId || row.interview_id) === String(hrDb.interview_id);
  });

  if (!bundleRow) {
    skip(
      "HTTP: authorized reader bundle HR outcome",
      `HR schedule_id=${hrDb.schedule_id} not present in reader-scoped bundle (map_id=${mapId})`
    );
    return;
  }

  const outcome = bundleRow.finalOutcome ?? bundleRow.final_outcome;

  if (outcome == null || String(outcome).trim() === "") {
    fail(
      "HTTP: authorized reader bundle HR outcome visible",
      `employee=${readerUser.employee_code} schedule_id=${hrDb.schedule_id}`
    );
    return;
  }

  pass(
    `HTTP: authorized reader sees HR outcome in bundle (${readerUser.employee_code})`
  );
}

async function assertHttpMatchesServiceForTaLeader(hrScheduleId, mapId, taLeaderUser) {
  if (!taLeaderUser) {
    skip("HTTP: backend parity probe", "no TA Leader user in database");
    return true;
  }

  if (!(await userHasMappingAccess(pool, taLeaderUser, mapId))) {
    skip(
      "HTTP: backend parity probe",
      "TA Leader lacks mapping on HR fixture — use TA Leader mapping tests below"
    );
    return true;
  }

  try {
    await interviewService.getFeedbackBySchedule(pool, hrScheduleId, {
      user: taLeaderUser
    });
  } catch (error) {
    fail(
      "HTTP: backend parity probe",
      `service layer denied TA Leader with mapping (${error.status} ${error.message})`
    );
    return false;
  }

  const http = await fetchJson(`/feedback/${hrScheduleId}`, signToken(taLeaderUser));

  if (http.status === 200 && http.body?.success) {
    pass("HTTP: backend reflects current HR read policy (TA Leader + mapping parity probe)");
    return true;
  }

  fail(
    "HTTP: backend parity probe",
    `service allows TA Leader HR read but HTTP returned ${http.status}. Restart backend using current working-tree code at ${API_BASE_URL}.`
  );
  return false;
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function findHrFeedbackScheduleFixture() {
  const result = await pool.query(
    `SELECT
        COALESCE(i.schedule_id, f.schedule_id) AS schedule_id,
        i.map_id,
        i.round_type,
        f.feedback_id
     FROM im_interviews i
     INNER JOIN im_feedback f ON f.interview_id = i.interview_id
     WHERE COALESCE(i.schedule_id, f.schedule_id) IS NOT NULL
       AND (
         LOWER(TRIM(i.round_type)) LIKE '%hr%'
         OR i.round_type IN ('HR Round', 'HR Interview', 'HR')
       )
     ORDER BY f.feedback_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function findAssignedRecruiterForSchedule(scheduleId, options = {}) {
  const requireOfferWorkspace = options.requireOfferWorkspace === true;
  const excludeOfferWorkspace = options.excludeOfferWorkspace === true;

  const result = await pool.query(
    `SELECT DISTINCT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM rm_recruiter_assignments a
     INNER JOIN user_mstr u
       ON u.employee_code = a.recruiter_code
      AND COALESCE(u.is_active, TRUE) = TRUE
     WHERE a.is_active = true
       AND EXISTS (
         SELECT 1
         FROM im_interviews i
         WHERE i.schedule_id = $1
           AND (
             (i.requisition_code IS NOT NULL AND a.requisition_code = i.requisition_code)
             OR (i.req_id IS NOT NULL AND a.req_id = i.req_id)
           )
       )
       AND (
         $2::boolean = false
         OR EXISTS (
           SELECT 1
           FROM employee_work_assignment ewa
           INNER JOIN work_assignment_mstr wa
             ON wa.work_assignment_id = ewa.work_assignment_id
           WHERE ewa.employee_code = u.employee_code
             AND ewa.is_active = TRUE
             AND wa.is_active = TRUE
             AND wa.workspace_flag = $3
         )
       )
       AND (
         $4::boolean = false
         OR NOT EXISTS (
           SELECT 1
           FROM employee_work_assignment ewa
           INNER JOIN work_assignment_mstr wa
             ON wa.work_assignment_id = ewa.work_assignment_id
           WHERE ewa.employee_code = u.employee_code
             AND ewa.is_active = TRUE
             AND wa.is_active = TRUE
             AND wa.workspace_flag = $3
         )
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [scheduleId, requireOfferWorkspace, OFFER_WORKSPACE_FLAG, excludeOfferWorkspace]
  );
  return result.rows[0] || null;
}

async function findOfferWorkspaceRecruiterNotAssignedToSchedule(scheduleId) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wa
       ON wa.work_assignment_id = ewa.work_assignment_id
      AND wa.is_active = TRUE
      AND wa.workspace_flag = $2
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.recruiter_code = u.employee_code
           AND a.is_active = TRUE
           AND EXISTS (
             SELECT 1
             FROM im_interviews i
             WHERE i.schedule_id = $1
               AND (
                 (i.requisition_code IS NOT NULL AND a.requisition_code = i.requisition_code)
                 OR (i.req_id IS NOT NULL AND a.req_id = i.req_id)
               )
           )
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [scheduleId, OFFER_WORKSPACE_FLAG]
  );
  return result.rows[0] || null;
}

async function findHrPanelInterviewerUser(scheduleId) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM interview_schedule_trn s
     INNER JOIN interview_panel_mstr ipm ON ipm.panel_id = s.interviewer_id
     INNER JOIN user_mstr u ON u.employee_code = ipm.employee_code
     WHERE s.schedule_id = $1
       AND ipm.is_active = true
       AND COALESCE(u.is_active, TRUE) = TRUE
     LIMIT 1`,
    [scheduleId]
  );
  return result.rows[0] || null;
}

async function findOrdinaryRecruiterWithoutOfferWorkspace(scheduleId) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wa
           ON wa.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND wa.is_active = TRUE
           AND wa.workspace_flag = $2
       )
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         WHERE a.recruiter_code = u.employee_code
           AND a.is_active = TRUE
           AND EXISTS (
             SELECT 1
             FROM im_interviews i
             WHERE i.schedule_id = $1
               AND (
                 (i.requisition_code IS NOT NULL AND a.requisition_code = i.requisition_code)
                 OR (i.req_id IS NOT NULL AND a.req_id = i.req_id)
               )
           )
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [scheduleId, OFFER_WORKSPACE_FLAG]
  );
  return result.rows[0] || null;
}

async function withTemporaryOfferWorkspaceDeactivation(employeeCode, runner) {
  const deactivate = await pool.query(
    `UPDATE employee_work_assignment ewa
     SET is_active = FALSE, updated_on = NOW()
     FROM work_assignment_mstr wa
     WHERE ewa.work_assignment_id = wa.work_assignment_id
       AND ewa.employee_code = $1
       AND wa.workspace_flag = $2
       AND ewa.is_active = TRUE
     RETURNING ewa.employee_work_assignment_id`,
    [employeeCode, OFFER_WORKSPACE_FLAG]
  );

  if (!deactivate.rows.length) {
    return {
      ok: false,
      reason: `no active employee assignment with workspace_flag=${OFFER_WORKSPACE_FLAG}`
    };
  }

  const rowIds = deactivate.rows.map((row) => row.employee_work_assignment_id);

  try {
    await runner();
    return { ok: true };
  } finally {
    for (const rowId of rowIds) {
      await pool.query(
        `UPDATE employee_work_assignment
         SET is_active = TRUE, updated_on = NOW()
         WHERE employee_work_assignment_id = $1`,
        [rowId]
      );
    }
  }
}

function payloadHasHrFeedbackLeakage(data) {
  if (!data || typeof data !== "object") {
    return false;
  }

  const stageGroups = data.stageGroups || [];
  if (stageGroups.some((group) => group.stageKey === "HR")) {
    return true;
  }

  const summaries = data.feedbackSummaries || data.data || [];

  if (Array.isArray(summaries)) {
    if (
      summaries.some((row) => {
        const bucket = String(row.stageBucket || "").toUpperCase();
        const round = String(row.roundType || "");
        return bucket === "HR" || /\bhr\b/i.test(round);
      })
    ) {
      return true;
    }
  }

  const rounds = data.rounds || [];
  if (
    rounds.some((row) => {
      const round = String(row.roundType || "");
      return /\bhr\b/i.test(round);
    })
  ) {
    return true;
  }

  return false;
}

async function main() {
  console.log("=== HR Interview Feedback Read Authorization ===\n");
  console.log(`API_BASE_URL=${API_BASE_URL}\n`);

  const reachable = await assertBackendReachable();
  if (!reachable) {
    await pool.end();
    return;
  }

  const hrFixture = await findHrFeedbackScheduleFixture();

  if (!hrFixture?.schedule_id) {
    fail("fixtures", "HR interview with submitted feedback required");
    await pool.end();
    return;
  }

  const scheduleId = hrFixture.schedule_id;
  const mapId = hrFixture.map_id;

  console.log(
    `Fixture HR schedule_id=${scheduleId} map_id=${mapId} round=${hrFixture.round_type}`
  );

  const admin = await resolveUserByRole("Admin");
  const taLeader = await resolveUserByRole("TA Leader");
  const offerWorkspaceAssigned = await findAssignedRecruiterForSchedule(scheduleId, {
    requireOfferWorkspace: true
  });
  const hrPanelUser = await findHrPanelInterviewerUser(scheduleId);
  const offerWorkspaceUnassigned = await findOfferWorkspaceRecruiterNotAssignedToSchedule(
    scheduleId
  );
  const ordinaryRecruiter = await findOrdinaryRecruiterWithoutOfferWorkspace(scheduleId);

  const parityOk = await assertHttpMatchesServiceForTaLeader(scheduleId, mapId, taLeader);
  if (!parityOk) {
    await pool.end();
    return;
  }

  console.log("\n--- Service: policy helpers ---");

  if (admin) {
    (await canReadHrInterviewFeedback(pool, { user: admin }))
      ? pass("Service: Admin may read HR feedback")
      : fail("Service: Admin may read HR feedback");
  }

  if (taLeader) {
    (await canReadHrInterviewFeedback(pool, { user: taLeader }))
      ? pass("Service: TA Leader may read HR feedback")
      : fail("Service: TA Leader may read HR feedback");
  }

  (await canReadHrInterviewFeedback(pool, { user: SYNTHETIC_TA_LEAD }))
    ? fail("Service: TA Lead role alone must not grant HR read")
    : pass("Service: TA Lead role alone denied for HR read");

  const masterRow = await pool.query(
    `SELECT assignment_code, assignment_name, workspace_flag, is_active
     FROM work_assignment_mstr
     WHERE workspace_flag = $1
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY work_assignment_id ASC
     LIMIT 1`,
    [OFFER_WORKSPACE_FLAG]
  );

  if (masterRow.rows[0]) {
    pass(
      `Service: Offer Letter workspace master present (workspace_flag=${OFFER_WORKSPACE_FLAG}, assignment_code="${masterRow.rows[0].assignment_code}")`
    );
  } else {
    fail(`Service: work_assignment_mstr with workspace_flag=${OFFER_WORKSPACE_FLAG} missing`);
  }

  console.log("\n--- HTTP/JWT: GET /feedback/:scheduleId ---");

  if (admin) {
    const res = await fetchJson(`/feedback/${scheduleId}`, signToken(admin));
    res.status === 200 && res.body?.success
      ? pass("HTTP: Admin HR feedback read allowed")
      : fail("HTTP: Admin HR feedback read", `status=${res.status}`);
  } else {
    fail("HTTP: Admin HR feedback read", "no Admin user");
  }

  if (taLeader && mapId) {
    const taLeaderHasMapping = await userHasMappingAccess(pool, taLeader, mapId);

    {
      const res = await fetchJson(
        `/feedback/${scheduleId}`,
        signToken(SYNTHETIC_TA_LEADER_NO_MAP)
      );
      res.status === 403
        ? pass("HTTP: TA Leader denied HR feedback read without mapping (synthetic JWT)")
        : fail(
            "HTTP: TA Leader HR feedback without mapping",
            `expected 403, got ${res.status}`
          );
    }

    if (taLeaderHasMapping) {
      const res = await fetchJson(`/feedback/${scheduleId}`, signToken(taLeader));
      res.status === 200 && res.body?.success
        ? pass("HTTP: TA Leader HR feedback read allowed with mapping authorization")
        : fail("HTTP: TA Leader HR feedback read with mapping", `status=${res.status}`);
    } else {
      skip(
        "HTTP: TA Leader HR feedback read with mapping",
        "no TA Leader user with mapping authorization on HR fixture"
      );
    }

    const foreignMapId = await findForeignMapIdForUser(pool, taLeader, mapId);

    if (foreignMapId) {
      const progressDenied = await fetchJson(
        `/api/v1/interviews/progress/${foreignMapId}`,
        signToken(taLeader)
      );

      progressDenied.status === 403
        ? pass("HTTP: TA Leader denied progress on foreign mapping")
        : fail(
            "HTTP: TA Leader foreign mapping progress",
            `expected 403, got ${progressDenied.status}`
          );
    } else {
      skip("HTTP: TA Leader foreign mapping progress", "no foreign map fixture");
    }

    if (taLeaderHasMapping) {
      const progressAllowed = await fetchJson(
        `/api/v1/interviews/progress/${mapId}`,
        signToken(taLeader)
      );

      if (progressAllowed.status === 200) {
        const hasHrGroup = JSON.stringify(progressAllowed.body?.data || {}).includes(
          '"stageKey":"HR"'
        );
        hasHrGroup
          ? pass("HTTP: TA Leader progress includes HR stage when mapping authorized")
          : skip("HTTP: TA Leader progress HR visibility", "no HR group on fixture mapping");
      } else {
        fail(
          "HTTP: TA Leader progress with mapping",
          `expected 200, got ${progressAllowed.status}`
        );
      }
    }
  } else if (!taLeader) {
    fail("HTTP: TA Leader HR feedback read", "no TA Leader user");
  } else {
    skip("HTTP: TA Leader mapping boundary", "HR fixture missing map_id");
  }

  {
    const res = await fetchJson(`/feedback/${scheduleId}`, signToken(SYNTHETIC_TA_LEAD));
    res.status === 403
      ? pass("HTTP: TA Lead denied HR feedback read (synthetic JWT)")
      : fail("HTTP: TA Lead HR feedback read", `expected 403, got ${res.status}`);
  }

  if (offerWorkspaceAssigned) {
    const res = await fetchJson(
      `/feedback/${scheduleId}`,
      signToken(offerWorkspaceAssigned)
    );
    res.status === 200 && res.body?.success
      ? pass(
          `HTTP: Offer Letter workspace recruiter with mapping allowed (${offerWorkspaceAssigned.employee_code})`
        )
      : fail(
          "HTTP: Offer Letter workspace recruiter with mapping",
          `status=${res.status} body=${JSON.stringify(res.body?.message || "")}`
        );
  } else {
    fail(
      "HTTP: Offer Letter workspace recruiter with mapping",
      `no assigned recruiter with workspace_flag=${OFFER_WORKSPACE_FLAG}`
    );
  }

  if (offerWorkspaceUnassigned) {
    const res = await fetchJson(
      `/feedback/${scheduleId}`,
      signToken(offerWorkspaceUnassigned)
    );
    res.status === 403
      ? pass(
          `HTTP: Offer Letter workspace without mapping denied (${offerWorkspaceUnassigned.employee_code})`
        )
      : fail(
          "HTTP: Offer Letter workspace without mapping",
          `expected 403, got ${res.status}`
        );
  } else {
    skip(
      "HTTP: Offer Letter workspace without mapping denied",
      `no recruiter with ${OFFER_WORKSPACE_FLAG} outside schedule assignment`
    );
  }

  if (offerWorkspaceAssigned) {
    const result = await withTemporaryOfferWorkspaceDeactivation(
      offerWorkspaceAssigned.employee_code,
      async () => {
        const inactiveService = await fetchJson(
          `/feedback/${scheduleId}`,
          signToken(offerWorkspaceAssigned)
        );

        if (inactiveService.status === 403) {
          pass(
            `HTTP: revoked Offer Letter workspace denied (${offerWorkspaceAssigned.employee_code})`
          );
        } else {
          fail(
            "HTTP: revoked Offer Letter workspace denied",
            `expected 403, got ${inactiveService.status}`
          );
        }

        const assignedNoWorkspace = await fetchJson(
          `/feedback/${scheduleId}`,
          signToken(offerWorkspaceAssigned)
        );

        if (assignedNoWorkspace.status === 403) {
          pass(
            `HTTP: assigned recruiter without active Offer Letter workspace denied HR read (${offerWorkspaceAssigned.employee_code})`
          );
        } else {
          fail(
            "HTTP: assigned recruiter without active Offer Letter workspace",
            `expected 403, got ${assignedNoWorkspace.status}`
          );
        }
      }
    );

    if (!result.ok) {
      fail("HTTP: temporary Offer Letter workspace deactivation fixture", result.reason);
    }
  }

  if (ordinaryRecruiter) {
    const res = await fetchJson(
      `/feedback/${scheduleId}`,
      signToken(ordinaryRecruiter)
    );
    res.status === 403
      ? pass(
          `HTTP: ordinary Recruiter without HR-read permission denied (${ordinaryRecruiter.employee_code})`
        )
      : fail(
          "HTTP: ordinary Recruiter without HR-read permission",
          `expected 403, got ${res.status}`
        );
  } else if (offerWorkspaceAssigned) {
    skip(
      "HTTP: ordinary Recruiter without HR-read permission",
      "using assigned-recruiter deactivation fixture instead"
    );
  } else {
    fail("HTTP: ordinary Recruiter without HR-read permission", "no fixture");
  }

  if (hrPanelUser) {
    const res = await fetchJson(`/feedback/${scheduleId}`, signToken(hrPanelUser));
    res.status === 403
      ? pass(
          `HTTP: Interviewer (HR panel) denied HR feedback read (${hrPanelUser.employee_code})`
        )
      : fail("HTTP: Interviewer HR panel read", `expected 403, got ${res.status}`);
  } else {
    const interviewer = await resolveUserByRole("Interviewer");
    if (interviewer) {
      const res = await fetchJson(`/feedback/${scheduleId}`, signToken(interviewer));
      res.status === 403
        ? pass("HTTP: ordinary Interviewer denied HR feedback read")
        : fail("HTTP: ordinary Interviewer", `expected 403, got ${res.status}`);
    } else {
      fail("HTTP: Interviewer denied HR feedback read", "no interviewer fixture");
    }
  }

  console.log("\n--- HTTP/JWT: aggregate interview feedback routes ---");

  async function assertAggregateRoutesOmitHr(token, labelPrefix) {
    if (!mapId) {
      skip(`${labelPrefix}: aggregate routes`, "no mapId");
      return;
    }

    const progress = await fetchJson(
      `/api/v1/interviews/progress/${mapId}`,
      token
    );

    if (progress.status === 200) {
      payloadHasHrFeedbackLeakage(progress.body?.data)
        ? fail(`HTTP: ${labelPrefix} progress HR leakage`, "HR feedback structures in response")
        : pass(`HTTP: ${labelPrefix} progress omits HR content`);
    } else if (progress.status === 403) {
      pass(`HTTP: ${labelPrefix} progress denied (no HR leakage)`);
    } else {
      fail(`HTTP: ${labelPrefix} progress`, `status=${progress.status}`);
    }

    const summaries = await fetchJson(
      `/api/v1/interviews/feedback-summaries/${mapId}`,
      token
    );

    if (summaries.status === 200) {
      payloadHasHrFeedbackLeakage({ feedbackSummaries: summaries.body?.data })
        ? fail(`HTTP: ${labelPrefix} feedback-summaries HR leakage`, "HR rows present")
        : pass(`HTTP: ${labelPrefix} feedback-summaries omit HR`);
    } else if (summaries.status === 403) {
      pass(`HTTP: ${labelPrefix} feedback-summaries denied`);
    } else {
      fail(`HTTP: ${labelPrefix} feedback-summaries`, `status=${summaries.status}`);
    }

    const permitted = await fetchJson(
      `/api/v1/interviews/permitted-feedback/${mapId}`,
      token
    );

    if (permitted.status === 200) {
      payloadHasHrFeedbackLeakage({ feedbackSummaries: permitted.body?.data })
        ? fail(`HTTP: ${labelPrefix} permitted-feedback HR leakage`, "HR rows present")
        : pass(`HTTP: ${labelPrefix} permitted-feedback omits HR`);
    } else if (permitted.status === 403) {
      pass(`HTTP: ${labelPrefix} permitted-feedback denied`);
    } else {
      fail(`HTTP: ${labelPrefix} permitted-feedback`, `status=${permitted.status}`);
    }

    const scheduled = await fetchJson(
      "/api/v1/interviews/recruiter-scheduled-feedback",
      token
    );

    if (scheduled.status === 200) {
      payloadHasHrFeedbackLeakage({ feedbackSummaries: scheduled.body?.data })
        ? fail(`HTTP: ${labelPrefix} recruiter-scheduled-feedback HR leakage`)
        : pass(`HTTP: ${labelPrefix} recruiter-scheduled-feedback omits HR`);
    } else {
      fail(`HTTP: ${labelPrefix} recruiter-scheduled-feedback`, `status=${scheduled.status}`);
    }
  }

  if (offerWorkspaceAssigned) {
    await withTemporaryOfferWorkspaceDeactivation(offerWorkspaceAssigned.employee_code, async () => {
      await assertAggregateRoutesOmitHr(
        signToken(offerWorkspaceAssigned),
        "assigned recruiter without active Offer Letter workspace"
      );
    });
  } else if (ordinaryRecruiter) {
    await assertAggregateRoutesOmitHr(
      signToken(ordinaryRecruiter),
      "ordinary recruiter without Offer Letter workspace"
    );
  } else {
    fail("HTTP: aggregate route HR checks", "no recruiter deny fixture");
  }

  console.log("\n--- HTTP/JWT: GET /api/v1/interviews bundle HR outcome metadata ---");

  const bundleRecruiterAssigned =
    offerWorkspaceAssigned || (await findAssignedRecruiterForSchedule(scheduleId));

  if (!bundleRecruiterAssigned) {
    fail(
      "HTTP: recruiter interview bundle HR redaction",
      "no recruiter assigned to HR fixture schedule"
    );
  } else if (offerWorkspaceAssigned) {
    const deactivateResult = await withTemporaryOfferWorkspaceDeactivation(
      offerWorkspaceAssigned.employee_code,
      async () => {
        await assertRecruiterBundleHrRedactionHttp(offerWorkspaceAssigned, mapId);
      }
    );

    if (!deactivateResult.ok) {
      fail(
        "HTTP: recruiter interview bundle HR redaction fixture",
        deactivateResult.reason
      );
    }

    if (admin) {
      await assertAuthorizedBundleHrOutcomeHttp(admin, mapId);
    }
  } else {
    await assertRecruiterBundleHrRedactionHttp(bundleRecruiterAssigned, mapId);
  }

  if (admin) {
    const adminBundle = await interviewService.getInterviewBundle(pool, { user: admin });
    const hrWithOutcome = (adminBundle.interviews || []).some(
      (row) =>
        isHrInterviewRound(row.roundType)
        && row.finalOutcome != null
        && String(row.finalOutcome).trim() !== ""
    );

    if (hrWithOutcome) {
      pass("Service: Admin interview bundle may include HR outcome metadata");
    } else {
      skip(
        "Service: Admin interview bundle HR outcome",
        "no HR row with outcome on scoped admin bundle"
      );
    }
  }

  console.log("\n--- Service: submit path must not imply HR read ---");

  if (hrPanelUser) {
    try {
      await interviewService.getFeedbackDetailsBySchedule(pool, scheduleId, {
        user: hrPanelUser
      });
      pass("Service: HR panel interviewer may load feedback-details (submit form)");
    } catch (error) {
      fail(
        "Service: HR panel feedback-details for submit",
        `${error.status} ${error.message}`
      );
    }

    try {
      await interviewService.getFeedbackBySchedule(pool, scheduleId, {
        user: hrPanelUser
      });
      fail("Service: HR panel read content", "expected 403");
    } catch (error) {
      error.status === 403
        ? pass("Service: HR panel denied HR feedback content read")
        : fail("Service: HR panel read content", `expected 403, got ${error.status}`);
    }
  } else {
    skip("Service: submit vs read separation", "no HR panel user on fixture");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nHR feedback read verification completed with failures.");
  } else {
    console.log("\nAll HR feedback read authorization checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
