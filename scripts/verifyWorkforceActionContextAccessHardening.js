require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const workforcePlanningService = require("../services/workforcePlanningService");
const recruitmentService = require("../services/recruitmentService");
const {
  assertRequisitionRequestorOwnerAccess
} = require("../services/requisitionCapabilityAuth");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
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

async function resolveRequestorUsers(limit = 2) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.is_active = TRUE
     WHERE UPPER(wam.assignment_code) = 'REQUISITION_REQUESTOR'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function findCrossOwnerRequisitionFixture(ownerKeys) {
  const result = await pool.query(
    `SELECT requisition_code, created_by, workflow_instance_id, req_status
     FROM rm_requisitions
     WHERE created_by IS NOT NULL
       AND TRIM(created_by) <> ''
     ORDER BY req_id DESC
     LIMIT 50`
  );

  return result.rows.find((row) => {
    const createdBy = String(row.created_by || "").trim();
    return createdBy && !ownerKeys.includes(createdBy);
  });
}

async function findOwnedRequisitionFixture(ownerKeys) {
  const result = await pool.query(
    `SELECT requisition_code, created_by, workflow_instance_id, req_status
     FROM rm_requisitions
     WHERE created_by IS NOT NULL
     ORDER BY req_id DESC`
  );

  return result.rows.find((row) => ownerKeys.includes(String(row.created_by || "").trim()));
}

async function findBudgetActionContextFixture() {
  const bundle = await workforcePlanningService.getWorkforceBundle(pool);
  const queue = bundle.config.approval_queue || [];

  return queue.find(
    (item) =>
      item.id
      && item.workflow_instance_id
      && (item.submitted_by_employee_code || item.current_approver)
  );
}

async function resolveOwnerKeysForUser(user) {
  const { resolveRequisitionRequestorCreatedByKeys } = require("../services/requisitionCapabilityAuth");
  return resolveRequisitionRequestorCreatedByKeys(pool, { user });
}

async function main() {
  console.log("=== Workforce Action Context + Requisition Owner Hardening (P2-1 / P2-2) ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");
  const requestors = await resolveRequestorUsers(2);
  const requestor = requestors[0] || null;
  const otherRequestor = requestors[1] || requestor;

  if (!admin || !requestor) {
    fail("fixtures", "Admin and at least one REQUISITION_REQUESTOR user required");
    await pool.end();
    return;
  }

  const ownerKeys = await resolveOwnerKeysForUser(requestor);
  const ownedReq = await findOwnedRequisitionFixture(ownerKeys);
  const foreignReq = await findCrossOwnerRequisitionFixture(ownerKeys);
  const budgetFixture = await findBudgetActionContextFixture();

  console.log("\n--- P2-1 Service layer ---");

  if (ownedReq) {
    try {
      await workforcePlanningService.getRequisitionApprovalActionContext(
        pool,
        ownedReq.requisition_code,
        { user: requestor }
      );
      pass("Service: requestor owner can read requisition action-context");
    } catch (error) {
      fail("Service: owner action-context", `${error.status} ${error.message}`);
    }
  } else {
    console.log("SKIP: no owned requisition fixture for requestor");
  }

  if (foreignReq && otherRequestor && otherRequestor.employee_code !== requestor.employee_code) {
    try {
      await workforcePlanningService.getRequisitionApprovalActionContext(
        pool,
        foreignReq.requisition_code,
        { user: otherRequestor }
      );
      fail("Service: cross-requestor action-context", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: cross-requestor denied requisition action-context");
      } else {
        fail("Service: cross-requestor action-context", `expected 403, got ${error.status}`);
      }
    }
  } else if (foreignReq && recruiter) {
    try {
      await workforcePlanningService.getRequisitionApprovalActionContext(
        pool,
        foreignReq.requisition_code,
        { user: recruiter }
      );
      fail("Service: recruiter action-context", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized recruiter denied requisition action-context");
      } else {
        fail("Service: recruiter action-context", `expected 403, got ${error.status}`);
      }
    }
  } else {
    console.log("SKIP: no foreign requisition / second requestor fixture");
  }

  if (foreignReq) {
    try {
      await workforcePlanningService.getRequisitionApprovalActionContext(
        pool,
        foreignReq.requisition_code,
        { user: admin }
      );
      pass("Service: Admin can read requisition action-context");
    } catch (error) {
      fail("Service: admin action-context", `${error.status} ${error.message}`);
    }
  }

  if (budgetFixture) {
    const requestorCode = String(budgetFixture.submitted_by_employee_code || "").trim();
    const budgetRequestor = requestorCode
      ? (
        await pool.query(
          `SELECT user_id, employee_code, email_id, role_name
           FROM user_mstr WHERE employee_code = $1 LIMIT 1`,
          [requestorCode]
        )
      ).rows[0]
      : null;

    if (budgetRequestor) {
      try {
        await workforcePlanningService.getBudgetApprovalActionContext(
          pool,
          budgetFixture.id,
          { user: budgetRequestor }
        );
        pass("Service: budget requestor can read budget action-context");
      } catch (error) {
        fail("Service: budget requestor action-context", `${error.status} ${error.message}`);
      }
    }

    if (recruiter) {
      try {
        await workforcePlanningService.getBudgetApprovalActionContext(
          pool,
          budgetFixture.id,
          { user: recruiter }
        );
        fail("Service: recruiter budget action-context", "expected throw");
      } catch (error) {
        if (error.status === 403) {
          pass("Service: unauthorized user denied budget action-context");
        } else {
          fail("Service: recruiter budget action-context", `expected 403, got ${error.status}`);
        }
      }
    }
  } else {
    console.log("SKIP: no budget action-context fixture");
  }

  console.log("\n--- P2-2 Service layer ---");

  if (ownedReq) {
    try {
      await recruitmentService.getRequisitionForRequestor(
        pool,
        ownedReq.requisition_code,
        { user: requestor }
      );
      pass("Service: owner requestor GET allowed");
    } catch (error) {
      fail("Service: owner GET", `${error.status} ${error.message}`);
    }
  }

  if (foreignReq && otherRequestor) {
    try {
      await recruitmentService.getRequisitionForRequestor(
        pool,
        foreignReq.requisition_code,
        { user: otherRequestor }
      );
      fail("Service: cross-requestor GET", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: cross-requestor GET denied");
      } else {
        fail("Service: cross-requestor GET", `expected 403, got ${error.status}`);
      }
    }

    const before = (
      await pool.query(
        `SELECT modified_on, position_title FROM rm_requisitions WHERE requisition_code = $1`,
        [foreignReq.requisition_code]
      )
    ).rows[0];

    try {
      await recruitmentService.updateRequisition(
        pool,
        foreignReq.requisition_code,
        { position_title: "blocked-owner-probe" },
        { user: otherRequestor }
      );
      fail("Service: cross-requestor PUT", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: cross-requestor PUT denied before mutation");
      } else {
        fail("Service: cross-requestor PUT", `expected 403, got ${error.status}`);
      }
    }

    const after = (
      await pool.query(
        `SELECT modified_on, position_title FROM rm_requisitions WHERE requisition_code = $1`,
        [foreignReq.requisition_code]
      )
    ).rows[0];

    if (
      String(before.modified_on) === String(after.modified_on)
      && before.position_title === after.position_title
    ) {
      pass("Service: blocked PUT did not mutate requisition row");
    } else {
      fail("Service: requisition mutated after blocked PUT");
    }
  } else {
    console.log("SKIP: no foreign requisition fixture for P2-2");
  }

  if (foreignReq) {
    try {
      await assertRequisitionRequestorOwnerAccess(pool, { user: admin }, foreignReq);
      fail("Service: admin owner GET", "expected throw (no admin widening on owner reads)");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: Admin without owner match denied on recruitment GET rule");
      } else {
        fail("Service: admin owner GET", `expected 403, got ${error.status}`);
      }
    }
  }

  const tokens = {
    admin: signToken(admin),
    requestor: signToken(requestor),
    otherRequestor: otherRequestor ? signToken(otherRequestor) : null,
    recruiter: recruiter ? signToken(recruiter) : null
  };

  console.log("\n--- HTTP layer (requires restarted backend) ---");

  if (foreignReq && tokens.recruiter) {
    const denied = await fetchJson(
      `/api/v1/workforce/requisitions/${foreignReq.requisition_code}/action-context`,
      tokens.recruiter
    );
    if (denied.status === 403) {
      pass("HTTP: unauthorized user denied requisition action-context");
    } else {
      fail("HTTP: requisition action-context", `expected 403, got ${denied.status}`);
    }

    const deniedGet = await fetchJson(
      `/api/v1/recruitment/requisitions/${foreignReq.requisition_code}`,
      tokens.otherRequestor || tokens.requestor
    );
    if (deniedGet.status === 403) {
      pass("HTTP: cross-owner recruitment GET denied");
    } else {
      fail("HTTP: cross-owner GET", `expected 403, got ${deniedGet.status}`);
    }
  }

  if (ownedReq) {
    const allowed = await fetchJson(
      `/api/v1/recruitment/requisitions/${ownedReq.requisition_code}`,
      tokens.requestor
    );
    if (allowed.status === 200 && allowed.body?.success) {
      pass("HTTP: owner recruitment GET allowed");
    } else {
      fail("HTTP: owner GET", `status=${allowed.status}`);
    }
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nP2-1/P2-2 verification completed with failures.");
  } else {
    console.log("\nAll P2-1/P2-2 verification checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
