/**
 * Phase 1B — requisition SoR consolidation verification.
 * Run: node scripts/verifyPhase1bRequisitionSorConsolidation.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
const recruitmentLegacyHandlers = require("../handlers/recruitmentLegacyHandlers");
const recruitmentService = require("../services/recruitmentService");
const { isLegacyDualWriteEnabled } = require("../config/operationalCutover");

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

async function main() {
  if (typeof recruitmentLegacyHandlers.handleLegacyUpdateRequisition !== "function") {
    fail("handleLegacyUpdateRequisition exported");
  } else {
    pass("handleLegacyUpdateRequisition exported");
  }

  pass(`LEGACY_DUAL_WRITE remains ${isLegacyDualWriteEnabled()}`);

  const recruiter = await pool.query(
    `SELECT employee_code
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     LIMIT 1`
  );
  const recruiterCode = recruiter.rows[0]?.employee_code;

  if (!recruiterCode) {
    skip("my-requisitions cockpit alignment", "no recruiter user");
  } else {
    const myReqs = await legacyOperationalAdapter.getMyRequisitions(
      pool,
      recruiterCode
    );
    const dashboard = await recruitmentService.getMyRecruiterDashboard(pool, {
      user: { employee_code: recruiterCode, role_name: "Recruiter" }
    });

    const myReqIds = new Set(
      myReqs.map((row) => String(row.req_id)).filter(Boolean)
    );
    const cockpitReqIds = new Set(
      (dashboard.requisitions || [])
        .map((row) => String(row.req_id))
        .filter(Boolean)
    );

    let missingInMyReqs = 0;
    for (const reqId of cockpitReqIds) {
      if (!myReqIds.has(reqId)) {
        missingInMyReqs += 1;
      }
    }

    if (missingInMyReqs > 0) {
      fail(
        "my-requisitions includes cockpit assignment requisitions",
        `missing=${missingInMyReqs}`
      );
    } else if (cockpitReqIds.size > 0) {
      pass("my-requisitions includes cockpit assignment requisitions");
    } else {
      skip("my-requisitions includes cockpit assignment requisitions", "no assignments");
    }

    if (myReqIds.size > cockpitReqIds.size) {
      fail(
        "my-requisitions not broader than cockpit assignments",
        `my=${myReqIds.size}, cockpit=${cockpitReqIds.size}`
      );
    } else {
      pass("my-requisitions not broader than cockpit assignments");
    }
  }

  const allReqs = await legacyOperationalAdapter.listLegacyRequisitions(pool);
  const enterpriseCount = await pool.query(
    `SELECT COUNT(*)::int AS total FROM rm_requisitions`
  );
  const legacyOnlyCount = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM req_mstr l
     WHERE NOT EXISTS (
       SELECT 1 FROM rm_requisitions r
       WHERE r.req_id IS NOT NULL AND r.req_id = l.req_id
     )`
  );

  if (allReqs.length < enterpriseCount.rows[0].total) {
    fail(
      "list requisitions includes enterprise rows",
      `listed=${allReqs.length}, enterprise=${enterpriseCount.rows[0].total}`
    );
  } else {
    pass("list requisitions includes enterprise rows");
  }

  if (legacyOnlyCount.rows[0].total > 0) {
    const legacyOnlyId = await pool.query(
      `SELECT req_id
       FROM req_mstr l
       WHERE NOT EXISTS (
         SELECT 1 FROM rm_requisitions r
         WHERE r.req_id IS NOT NULL AND r.req_id = l.req_id
       )
       LIMIT 1`
    );
    const legacyReqId = String(legacyOnlyId.rows[0]?.req_id || "");
    const listed = allReqs.some((row) => String(row.req_id) === legacyReqId);
    if (!listed) {
      fail("legacy-only requisitions remain listed", `req_id=${legacyReqId}`);
    } else {
      pass("legacy-only requisitions remain listed");
    }
  } else {
    skip("legacy-only requisitions remain listed", "no legacy-only rows");
  }

  const enterpriseReq = await pool.query(
    `SELECT r.req_id, r.requisition_code, r.position_title, r.modified_on, r.created_by
     FROM rm_requisitions r
     WHERE r.req_id IS NOT NULL
       AND COALESCE(r.req_status, '') NOT IN ('Approved', 'Rejected')
     LIMIT 1`
  );

  if (!enterpriseReq.rows[0]) {
    skip("PUT /requisition/:id uses rm_requisitions", "no editable enterprise requisition");
  } else {
    const row = enterpriseReq.rows[0];
    const legacyBefore = await pool.query(
      `SELECT job_title, updated_on
       FROM req_mstr
       WHERE req_id = $1`,
      [row.req_id]
    );

    const requestor = await pool.query(
      `SELECT user_id, employee_code, email_id, role_name, full_name
       FROM user_mstr
       WHERE COALESCE(is_active, TRUE) = TRUE
         AND (
           full_name = $1
           OR email_id = $1
           OR employee_code = $1
         )
       LIMIT 1`,
      [row.created_by]
    );

    if (!requestor.rows[0]) {
      skip("PUT /requisition/:id uses rm_requisitions", "no requestor user for sample requisition");
    } else {
      const marker = `Phase1B-${Date.now()}`;
      const req = {
        user: {
          user_id: requestor.rows[0].user_id,
          employee_code: requestor.rows[0].employee_code,
          email_id: requestor.rows[0].email_id,
          role_name: requestor.rows[0].role_name,
          full_name: requestor.rows[0].full_name
        },
        params: { id: row.req_id },
        body: {
          job_title: marker
        }
      };

      const response = {
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.payload = payload;
          return this;
        }
      };

      await recruitmentLegacyHandlers.handleLegacyUpdateRequisition(pool, req, response);

      if (response.statusCode !== 200 || response.payload?.success !== true) {
        fail(
          "PUT compatibility wrapper updates enterprise requisition",
          response.payload?.message || `status=${response.statusCode}`
        );
      } else {
        pass("PUT compatibility wrapper updates enterprise requisition");
      }

      const enterpriseAfter = await pool.query(
        `SELECT position_title
         FROM rm_requisitions
         WHERE requisition_code = $1`,
        [row.requisition_code]
      );

      if (enterpriseAfter.rows[0]?.position_title !== marker) {
        fail("rm_requisitions updated by PUT wrapper");
      } else {
        pass("rm_requisitions updated by PUT wrapper");
      }

      if (!isLegacyDualWriteEnabled() && legacyBefore.rows[0]) {
        const legacyAfter = await pool.query(
          `SELECT job_title, updated_on
           FROM req_mstr
           WHERE req_id = $1`,
          [row.req_id]
        );

        if (
          legacyAfter.rows[0]?.job_title !== legacyBefore.rows[0].job_title ||
          String(legacyAfter.rows[0]?.updated_on) !==
            String(legacyBefore.rows[0]?.updated_on)
        ) {
          fail(
            "req_mstr unchanged when LEGACY_DUAL_WRITE=false",
            `before=${legacyBefore.rows[0]?.job_title}, after=${legacyAfter.rows[0]?.job_title}`
          );
        } else {
          pass("req_mstr unchanged when LEGACY_DUAL_WRITE=false");
        }
      } else {
        skip("req_mstr unchanged check", "dual-write enabled or no legacy parent row");
      }

      await pool.query(
        `UPDATE rm_requisitions
         SET position_title = $1, modified_on = $2
         WHERE requisition_code = $3`,
        [row.position_title, row.modified_on, row.requisition_code]
      );
      pass("PUT wrapper test reverted requisition title");
    }
  }

  const legacyOnlyUpdate = await pool.query(
    `SELECT req_id
     FROM req_mstr l
     WHERE NOT EXISTS (
       SELECT 1 FROM rm_requisitions r
       WHERE r.req_id IS NOT NULL AND r.req_id = l.req_id
     )
     LIMIT 1`
  );

  if (legacyOnlyUpdate.rows[0]?.req_id) {
    const req = {
      user: { employee_code: "TEST", role_name: "Admin", email_id: "test@example.com" },
      params: { id: legacyOnlyUpdate.rows[0].req_id },
      body: { job_title: "Should Fail" }
    };
    const response = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      }
    };

    await recruitmentLegacyHandlers.handleLegacyUpdateRequisition(pool, req, response);
    if (response.statusCode === 404) {
      pass("legacy-only req_mstr cannot be operationally updated via PUT wrapper");
    } else {
      fail(
        "legacy-only req_mstr cannot be operationally updated via PUT wrapper",
        `status=${response.statusCode}`
      );
    }
  } else {
    skip("legacy-only PUT rejection", "no legacy-only requisition");
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
