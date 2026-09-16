/**
 * Phase 3C — my-interviews SoR consolidation verification.
 * Run: node scripts/verifyPhase3cMyInterviewsSorConsolidation.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
const { isEnterpriseOperationalSor } = require("../config/operationalCutover");

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
      role_name: user.role_name
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );

  return result.rows[0]?.exists === true;
}

function assertNoDuplicateScheduleIds(rows, label) {
  const seen = new Set();

  for (const row of rows) {
    if (row.schedule_id == null) {
      continue;
    }

    const key = String(row.schedule_id);
    if (seen.has(key)) {
      fail(`${label} duplicate schedule_id`, key);
      return false;
    }

    seen.add(key);
  }

  pass(`${label} has no duplicate schedule_id values`);
  return true;
}

async function resolvePanelInterviewer() {
  const result = await pool.query(
    `SELECT
       u.user_id,
       u.employee_code,
       u.email_id,
       u.role_name,
       ip.panel_id
     FROM interview_panel_mstr ip
     INNER JOIN user_mstr u
       ON u.employee_code = ip.employee_code
     WHERE ip.is_active = true
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY ip.panel_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveNonPanelUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr u
     WHERE COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM interview_panel_mstr ip
         WHERE ip.employee_code = u.employee_code
           AND ip.is_active = true
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function fetchJson(path, token) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`http://localhost:5000${path}`, { headers });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function main() {
  console.log("=== Phase 3C My Interviews SoR Consolidation ===\n");

  if (!isEnterpriseOperationalSor()) {
    skip("enterprise-first consolidation", "OPERATIONAL_SOR is not enterprise");
    await pool.end();
    return;
  }

  pass("OPERATIONAL_SOR is enterprise");

  const panelUser = await resolvePanelInterviewer();
  if (!panelUser) {
    fail("fixtures", "active panel interviewer required");
    await pool.end();
    return;
  }

  const interviews = await legacyOperationalAdapter.listMyInterviewsForLegacyApi(
    pool,
    panelUser.panel_id
  );
  assertNoDuplicateScheduleIds(interviews, "panel service list");

  const enterpriseBacked = await pool.query(
    `SELECT i.schedule_id
     FROM im_interviews i
     INNER JOIN interview_schedule_trn s ON s.schedule_id = i.schedule_id
     WHERE s.interviewer_id = $1`,
    [panelUser.panel_id]
  );

  const scheduleIds = new Set(interviews.map((row) => String(row.schedule_id)));
  let missingEnterprise = 0;
  for (const row of enterpriseBacked.rows) {
    if (!scheduleIds.has(String(row.schedule_id))) {
      missingEnterprise += 1;
    }
  }

  if (missingEnterprise > 0) {
    fail(
      "enterprise-backed interviews visible",
      `missing=${missingEnterprise}`
    );
  } else if (enterpriseBacked.rows.length > 0) {
    pass("enterprise-backed interviews visible");
  } else {
    skip("enterprise-backed interviews visible", "no enterprise-backed fixtures for panel");
  }

  const hasLegacySchedule = await tableExists("interview_schedule_trn");
  if (hasLegacySchedule) {
    const legacyOnly = await pool.query(
      `SELECT s.schedule_id
       FROM interview_schedule_trn s
       WHERE s.interviewer_id = $1
         AND NOT EXISTS (
           SELECT 1
           FROM im_interviews e
           WHERE e.schedule_id = s.schedule_id
         )`,
      [panelUser.panel_id]
    );

    let missingLegacyOnly = 0;
    for (const row of legacyOnly.rows) {
      if (!scheduleIds.has(String(row.schedule_id))) {
        missingLegacyOnly += 1;
      }
    }

    if (missingLegacyOnly > 0) {
      fail(
        "legacy-only interviews visible through fallback",
        `missing=${missingLegacyOnly}`
      );
    } else if (legacyOnly.rows.length > 0) {
      pass("legacy-only interviews visible through fallback");
    } else {
      skip(
        "legacy-only interviews visible through fallback",
        "no legacy-only interview fixtures for panel"
      );
    }

    const dualBacked = await pool.query(
      `SELECT
         i.schedule_id,
         COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code) AS enterprise_req_code,
         r.req_code AS legacy_req_code
       FROM im_interviews i
       INNER JOIN interview_schedule_trn s ON s.schedule_id = i.schedule_id
       LEFT JOIN rm_candidate_mappings rcm
         ON rcm.map_id = COALESCE(i.map_id, s.map_id)
        AND rcm.is_active = true
       LEFT JOIN rm_requisitions rr_by_id
         ON rr_by_id.req_id = COALESCE(i.req_id, rcm.req_id, s.req_id)
       LEFT JOIN rm_requisitions rr_by_code
         ON rr_by_code.requisition_code = COALESCE(i.requisition_code, rcm.requisition_code)
       LEFT JOIN candidate_req_map crm ON crm.map_id = s.map_id
       LEFT JOIN req_mstr r ON r.req_id = COALESCE(crm.req_id, s.req_id)
       WHERE s.interviewer_id = $1
       LIMIT 1`,
      [panelUser.panel_id]
    );

    if (dualBacked.rows[0]) {
      const sample = dualBacked.rows[0];
      const mergedRow = interviews.find(
        (row) => String(row.schedule_id) === String(sample.schedule_id)
      );

      if (!mergedRow) {
        fail(
          "enterprise wins on duplicate schedule_id",
          `schedule_id=${sample.schedule_id} missing`
        );
      } else if (
        sample.enterprise_req_code &&
        mergedRow.req_code !== sample.enterprise_req_code
      ) {
        fail(
          "enterprise wins on duplicate schedule_id",
          `expected req_code=${sample.enterprise_req_code}, got ${mergedRow.req_code}`
        );
      } else {
        pass("enterprise wins on duplicate schedule_id");
      }
    } else {
      skip(
        "enterprise wins on duplicate schedule_id",
        "no dual-backed interview fixtures for panel"
      );
    }
  } else {
    skip("legacy fallback checks", "interview_schedule_trn missing");
  }

  const panelToken = signToken(panelUser);
  const panelHttp = await fetchJson("/my-interviews", panelToken);

  if (panelHttp.status === 200 && Array.isArray(panelHttp.body?.data)) {
    pass(`HTTP panel my-interviews (200, count=${panelHttp.body.data.length})`);
    assertNoDuplicateScheduleIds(panelHttp.body.data, "HTTP panel list");

    const requiredFields = [
      "schedule_id",
      "candidate_name",
      "round_type",
      "interview_date",
      "interview_status",
      "feedback_submitted"
    ];
    const sample = panelHttp.body.data[0];
    if (sample) {
      const missingFields = requiredFields.filter((field) => !(field in sample));
      if (missingFields.length) {
        fail("HTTP response contract", `missing fields: ${missingFields.join(", ")}`);
      } else {
        pass("HTTP response contract preserved");
      }
    } else {
      pass("HTTP response contract preserved");
    }
  } else {
    fail("HTTP panel my-interviews", `status=${panelHttp.status}`);
  }

  const nonPanelUser = await resolveNonPanelUser();
  if (nonPanelUser) {
    const nonPanelToken = signToken(nonPanelUser);
    const nonPanelHttp = await fetchJson("/my-interviews", nonPanelToken);

    if (nonPanelHttp.status === 404) {
      pass("HTTP non-panel user blocked (404)");
    } else {
      fail("HTTP non-panel user blocked", `status=${nonPanelHttp.status}`);
    }
  } else {
    skip("HTTP non-panel user blocked", "no non-panel user fixture");
  }

  if (process.exitCode) {
    console.log("\nPhase 3C my-interviews verification completed with failures.");
  } else {
    console.log("\nAll Phase 3C my-interviews checks passed.");
  }
}

main()
  .catch((error) => {
    fail("verification script", error.message);
    console.error(error);
  })
  .finally(async () => {
    await pool.end();
  });
