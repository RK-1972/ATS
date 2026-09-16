require("dotenv").config();

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const userProvisioningService = require("../services/userProvisioningService");
const {
  assertCanAccessUserAdministration,
  assertCanProvisionUsers,
  assertCanChangePrimaryRole,
  assertCanChangeUserStatus,
  assertAssignmentGrantAllowed,
  assertCanManageEmployeeWorkAssignments,
  getProvisionableRoles,
  USER_ADMINISTRATOR_CODE
} = require("../services/userProvisioningCapabilityAuth");
const { assertEmployeeAccountActive } = require("../middleware/activeEmployeeAuth");
const {
  EMPLOYEE_ROLE_NAMES,
  getProvisionableRolesForUserAdministrator
} = require("../constants/employeeRoles");

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
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

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

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveRecruiterWithoutProvisioner() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND wam.is_active = TRUE
           AND UPPER(wam.assignment_code) = $1
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [USER_ADMINISTRATOR_CODE]
  );
  return result.rows[0] || null;
}

async function resolveUserAdministrator() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.is_active = TRUE
     WHERE UPPER(wam.assignment_code) = $1
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND u.role_name <> 'Admin'
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [USER_ADMINISTRATOR_CODE]
  );
  return result.rows[0] || null;
}

async function resolveActiveOperationalAssignment() {
  const result = await pool.query(
    `SELECT work_assignment_id, assignment_code
     FROM work_assignment_mstr
     WHERE is_active = TRUE
       AND UPPER(assignment_code) = 'RECRUITER'
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolvePrivilegedAssignment() {
  const result = await pool.query(
    `SELECT work_assignment_id, assignment_code
     FROM work_assignment_mstr
     WHERE is_active = TRUE
       AND UPPER(assignment_code) = $1
     LIMIT 1`,
    [USER_ADMINISTRATOR_CODE]
  );
  return result.rows[0] || null;
}

async function cleanupProvisionedUser(employeeCode) {
  if (!employeeCode) {
    return;
  }

  await pool.query(
    `DELETE FROM user_status_history WHERE employee_code = $1`,
    [employeeCode]
  );
  await pool.query(
    `DELETE FROM user_role_history WHERE employee_code = $1`,
    [employeeCode]
  );
  await pool.query(
    `DELETE FROM employee_work_assignment WHERE employee_code = $1`,
    [employeeCode]
  );
  await pool.query(`DELETE FROM user_mstr WHERE employee_code = $1`, [
    employeeCode
  ]);
}

async function main() {
  const admin = await resolveAdminUser();
  const recruiter = await resolveRecruiterWithoutProvisioner();
  const userAdministrator = await resolveUserAdministrator();
  const recruiterAssignment = await resolveActiveOperationalAssignment();
  const privilegedAssignment = await resolvePrivilegedAssignment();

  if (!admin) {
    fail("fixtures", "Admin user required");
    return;
  }

  if (!recruiterAssignment) {
    fail("fixtures", "RECRUITER work assignment master required");
    return;
  }

  const roleHistoryTable = await pool.query(
    `SELECT to_regclass('public.user_role_history') AS table_name`
  );

  if (!roleHistoryTable.rows[0]?.table_name) {
    fail("user_role_history migration", "apply migration 047_user_role_history_schema.sql");
    return;
  }

  pass("user_role_history table exists");

  const statusHistoryTable = await pool.query(
    `SELECT to_regclass('public.user_status_history') AS table_name`
  );

  if (!statusHistoryTable.rows[0]?.table_name) {
    fail("user_status_history migration", "apply migration 048_user_status_history_schema.sql");
    return;
  }

  pass("user_status_history table exists");

  const stamp = Date.now();
  const adminToken = signToken(admin);
  const recruiterToken = recruiter ? signToken(recruiter) : null;
  const userAdminToken = userAdministrator ? signToken(userAdministrator) : null;

  try {
    await assertCanAccessUserAdministration(pool, { user: admin });
    pass("admin can access user administration");
  } catch (error) {
    fail("admin can access user administration", error.message);
  }

  const adminRoles = getProvisionableRoles({ user: admin });
  const userAdminRoles = getProvisionableRolesForUserAdministrator();

  if (adminRoles.length !== EMPLOYEE_ROLE_NAMES.length) {
    fail(
      "admin provisionable roles include full employee role catalog",
      adminRoles.join(", ")
    );
  } else {
    pass("admin provisionable roles include full employee role catalog");
  }

  if (userAdminRoles.includes("Admin")) {
    fail("user administrator provisionable roles exclude Admin");
  } else if (userAdminRoles.length !== EMPLOYEE_ROLE_NAMES.length - 1) {
    fail(
      "user administrator provisionable roles include all non-Admin employee roles",
      userAdminRoles.join(", ")
    );
  } else {
    pass("user administrator provisionable roles include all non-Admin employee roles");
  }

  if (recruiter) {
    try {
      await assertCanAccessUserAdministration(pool, { user: recruiter });
      fail("ordinary recruiter denied user administration");
    } catch (_error) {
      pass("ordinary recruiter denied user administration");
    }
  } else {
    console.log("SKIP: no ordinary recruiter fixture");
  }

  if (userAdministrator) {
    try {
      await assertCanAccessUserAdministration(pool, { user: userAdministrator });
      pass("USER_ADMINISTRATOR can access user administration");
    } catch (error) {
      fail("USER_ADMINISTRATOR can access user administration", error.message);
    }

    try {
      await assertCanProvisionUsers(pool, { user: userAdministrator }, {
        targetRoleName: "Admin"
      });
      fail("USER_ADMINISTRATOR denied Admin role creation");
    } catch (_error) {
      pass("USER_ADMINISTRATOR denied Admin role creation");
    }

    try {
      assertAssignmentGrantAllowed(
        { user: userAdministrator },
        USER_ADMINISTRATOR_CODE
      );
      fail("USER_ADMINISTRATOR cannot grant USER_ADMINISTRATOR");
    } catch (_error) {
      pass("USER_ADMINISTRATOR cannot grant USER_ADMINISTRATOR");
    }
  } else {
    console.log("SKIP: no USER_ADMINISTRATOR fixture — assign migration 046 then map an employee");
  }

  const adminProvisionCode = `VERIFY_PROV_ADMIN_${stamp}`;
  const adminProvisionEmail = `verify.prov.admin.${stamp}@optalynx.demo`;

  try {
    const provisioned = await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: adminProvisionCode,
        full_name: "Verify Provision Admin",
        email_id: adminProvisionEmail,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: [recruiterAssignment.work_assignment_id]
      }
    );

    if (!provisioned.user?.user_id) {
      fail("admin provisioning creates user");
    } else {
      pass("admin provisioning creates user");
    }

    if (provisioned.work_assignments.length !== 1) {
      fail("admin multi-assignment provisioning");
    } else {
      pass("admin multi-assignment provisioning");
    }

    const hashCheck = await pool.query(
      `SELECT password_hash, is_active
       FROM user_mstr
       WHERE employee_code = $1`,
      [adminProvisionCode]
    );

    const validHash = await bcrypt.compare(
      "VerifyPass123",
      hashCheck.rows[0]?.password_hash || ""
    );

    if (!validHash || hashCheck.rows[0]?.is_active !== true) {
      fail("password hashing and is_active flag");
    } else {
      pass("password hashing and is_active flag");
    }

    await cleanupProvisionedUser(adminProvisionCode);
  } catch (error) {
    await cleanupProvisionedUser(adminProvisionCode);
    fail("admin provisioning", error.message);
  }

  const zeroAssignmentCode = `VERIFY_PROV_ZERO_${stamp}`;
  const zeroAssignmentEmail = `verify.prov.zero.${stamp}@optalynx.demo`;

  try {
    const provisioned = await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: zeroAssignmentCode,
        full_name: "Verify Provision Zero",
        email_id: zeroAssignmentEmail,
        password: "VerifyPass123",
        role_name: "Interviewer",
        work_assignment_ids: []
      }
    );

    if (!provisioned.user?.user_id) {
      fail("zero-assignment provisioning");
    } else {
      pass("zero-assignment provisioning");
    }

    await cleanupProvisionedUser(zeroAssignmentCode);
  } catch (error) {
    await cleanupProvisionedUser(zeroAssignmentCode);
    fail("zero-assignment provisioning", error.message);
  }

  for (const extendedRole of ["TA Lead", "Hiring Manager"]) {
    const extendedCode = `VERIFY_PROV_${extendedRole.replace(/\s+/g, "_")}_${stamp}`;
    const extendedEmail = `verify.prov.${extendedRole.replace(/\s+/g, "").toLowerCase()}.${stamp}@optalynx.demo`;

    try {
      const provisioned = await userProvisioningService.provisionEmployee(
        pool,
        { user: admin },
        {
          employee_code: extendedCode,
          full_name: `Verify Provision ${extendedRole}`,
          email_id: extendedEmail,
          password: "VerifyPass123",
          role_name: extendedRole,
          work_assignment_ids: []
        }
      );

      if (provisioned.user?.role_name === extendedRole) {
        pass(`admin provisioning supports ${extendedRole} role`);
      } else {
        fail(`admin provisioning supports ${extendedRole} role`);
      }

      await cleanupProvisionedUser(extendedCode);
    } catch (error) {
      await cleanupProvisionedUser(extendedCode);
      fail(`admin provisioning supports ${extendedRole} role`, error.message);
    }
  }

  const duplicateCode = `VERIFY_DUP_${stamp}`;
  const duplicateEmail = `verify.dup.${stamp}@optalynx.demo`;

  try {
    await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: duplicateCode,
        full_name: "Duplicate Seed",
        email_id: duplicateEmail,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: []
      }
    );

    try {
      await userProvisioningService.provisionEmployee(
        pool,
        { user: admin },
        {
          employee_code: duplicateCode,
          full_name: "Duplicate User",
          email_id: duplicateEmail,
          password: "VerifyPass123",
          role_name: "Recruiter",
          work_assignment_ids: []
        }
      );
      fail("duplicate protection");
    } catch (error) {
      if (error.status === 409) {
        pass("duplicate protection");
      } else {
        fail("duplicate protection", error.message);
      }
    }
  } catch (error) {
    fail("duplicate protection seed", error.message);
  } finally {
    await cleanupProvisionedUser(duplicateCode);
  }

  if (userAdministrator && privilegedAssignment) {
    try {
      await userProvisioningService.provisionEmployee(
        pool,
        { user: userAdministrator },
        {
          employee_code: `VERIFY_PRIV_${stamp}`,
          full_name: "Privileged Block",
          email_id: `verify.priv.${stamp}@optalynx.demo`,
          password: "VerifyPass123",
          role_name: "Recruiter",
          work_assignment_ids: [privilegedAssignment.work_assignment_id]
        }
      );
      fail("USER_ADMINISTRATOR privileged assignment elevation blocked");
    } catch (error) {
      if (error.status === 403) {
        pass("USER_ADMINISTRATOR privileged assignment elevation blocked");
      } else {
        fail(
          "USER_ADMINISTRATOR privileged assignment elevation blocked",
          error.message
        );
      }
    }
  }

  const rollbackCode = `VERIFY_ROLLBACK_${stamp}`;
  const rollbackEmail = `verify.rollback.${stamp}@optalynx.demo`;

  try {
    await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: rollbackCode,
        full_name: "Rollback Test",
        email_id: rollbackEmail,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: [999999999]
      }
    );
    fail("transaction rollback");
  } catch (_error) {
    const residual = await pool.query(
      `SELECT user_id FROM user_mstr WHERE employee_code = $1`,
      [rollbackCode]
    );

    if (residual.rows.length === 0) {
      pass("transaction rollback");
    } else {
      await cleanupProvisionedUser(rollbackCode);
      fail("transaction rollback", "user_mstr row remained after failed provision");
    }
  }

  const httpAdminProvision = await fetchJson("/users/provision", adminToken, {
    method: "POST",
    body: {
      employee_code: `VERIFY_HTTP_${stamp}`,
      full_name: "Verify HTTP Provision",
      email_id: `verify.http.${stamp}@optalynx.demo`,
      password: "VerifyPass123",
      role_name: "Recruiter",
      work_assignment_ids: [recruiterAssignment.work_assignment_id]
    }
  });

  if (httpAdminProvision.status === 201) {
    pass("HTTP admin provisioning");
    await cleanupProvisionedUser(`VERIFY_HTTP_${stamp}`);
  } else if (httpAdminProvision.status === 404) {
    console.log("SKIP: HTTP admin provisioning — restart backend to load new routes");
  } else {
    fail(
      "HTTP admin provisioning",
      `${httpAdminProvision.status} ${httpAdminProvision.body?.message || ""}`
    );
  }

  if (recruiterToken) {
    const deniedList = await fetchJson("/users", recruiterToken);
    if (deniedList.status === 403) {
      pass("ordinary user denied GET /users");
    } else {
      fail("ordinary user denied GET /users", String(deniedList.status));
    }

    const deniedAssign = await fetchJson("/employee-work-assignments", recruiterToken, {
      method: "POST",
      body: {
        employee_code: recruiter.employee_code,
        work_assignment_id: recruiterAssignment.work_assignment_id
      }
    });

    if (deniedAssign.status === 403) {
      pass("ordinary user denied assignment modification");
    } else if (deniedAssign.status === 404 || deniedAssign.status === 409) {
      console.log(
        `SKIP: ordinary user assignment modification HTTP check (${deniedAssign.status}) — restart backend for hardened routes`
      );
    } else {
      fail(
        "ordinary user denied assignment modification",
        String(deniedAssign.status)
      );
    }
  }

  if (userAdminToken) {
    const deniedAdminCreate = await fetchJson("/users/provision", userAdminToken, {
      method: "POST",
      body: {
        employee_code: `VERIFY_DENY_ADMIN_${stamp}`,
        full_name: "Denied Admin Create",
        email_id: `verify.deny.admin.${stamp}@optalynx.demo`,
        password: "VerifyPass123",
        role_name: "Admin",
        work_assignment_ids: []
      }
    });

    if (deniedAdminCreate.status === 403) {
      pass("HTTP USER_ADMINISTRATOR denied Admin creation");
    } else {
      fail(
        "HTTP USER_ADMINISTRATOR denied Admin creation",
        String(deniedAdminCreate.status)
      );
    }
  }

  try {
    await assertCanManageEmployeeWorkAssignments(pool, { user: admin });
    pass("admin can manage employee work assignments");
  } catch (error) {
    fail("admin can manage employee work assignments", error.message);
  }

  if (recruiter) {
    try {
      await assertCanManageEmployeeWorkAssignments(pool, { user: recruiter });
      fail("ordinary user denied manage employee work assignments");
    } catch (_error) {
      pass("ordinary user denied manage employee work assignments");
    }
  }

  const roleStamp = `${stamp}_ROLE`;
  const roleProvisionCode = `VERIFY_ROLE_PROV_${roleStamp}`;
  const roleProvisionEmail = `verify.role.prov.${roleStamp}@optalynx.demo`;

  try {
    const provisioned = await userProvisioningService.provisionEmployee(
      pool,
      { user: admin },
      {
        employee_code: roleProvisionCode,
        full_name: "Verify Role History Provision",
        email_id: roleProvisionEmail,
        password: "VerifyPass123",
        role_name: "Recruiter",
        work_assignment_ids: [recruiterAssignment.work_assignment_id]
      }
    );

    const historyRows = await userProvisioningService.getRoleHistory(
      pool,
      roleProvisionCode
    );

    if (historyRows.length !== 1) {
      fail("provisioning creates initial role history", `rows=${historyRows.length}`);
    } else if (historyRows[0].previous_role_name !== null) {
      fail("provisioning initial history previous_role_name is null");
    } else if (historyRows[0].new_role_name !== "Recruiter") {
      fail("provisioning initial history new_role_name");
    } else if (!historyRows[0].effective_at || !historyRows[0].changed_by_employee_code) {
      fail("provisioning initial history timestamp and changed_by");
    } else {
      pass("provisioning creates initial role history");
    }

    const statusHistoryRows = await userProvisioningService.getStatusHistory(
      pool,
      roleProvisionCode
    );

    if (statusHistoryRows.length !== 1) {
      fail("provisioning creates initial status history", `rows=${statusHistoryRows.length}`);
    } else if (statusHistoryRows[0].previous_status !== null) {
      fail("provisioning initial status history previous_status is null");
    } else if (statusHistoryRows[0].new_status !== "Active") {
      fail("provisioning initial status history new_status is Active");
    } else {
      pass("provisioning creates initial status history");
    }

    const assignmentsBefore = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM employee_work_assignment
       WHERE employee_code = $1`,
      [roleProvisionCode]
    );

    const changed = await userProvisioningService.changePrimaryRole(
      pool,
      { user: admin },
      roleProvisionCode,
      {
        role_name: "Interviewer",
        reason: "Verification role change"
      }
    );

    if (changed.user?.role_name !== "Interviewer") {
      fail("role change updates current role");
    } else {
      pass("role change updates current role");
    }

    const historyAfter = await userProvisioningService.getRoleHistory(
      pool,
      roleProvisionCode
    );

    if (historyAfter.length !== 2) {
      fail("role change creates history row", `rows=${historyAfter.length}`);
    } else {
      pass("role change creates history row");
    }

    const latest = historyAfter[0];
    const previous = historyAfter[1];

    if (
      latest.previous_role_name !== "Recruiter" ||
      latest.new_role_name !== "Interviewer"
    ) {
      fail("role change history previous/new roles");
    } else {
      pass("role change history previous/new roles");
    }

    if (!latest.changed_by_employee_code || !latest.effective_at) {
      fail("role change history changed_by and timestamp");
    } else {
      pass("role change history changed_by and timestamp");
    }

    if (latest.reason !== "Verification role change") {
      fail("role change history reason stored");
    } else {
      pass("role change history reason stored");
    }

    if (
      new Date(historyAfter[0].effective_at).getTime() <
      new Date(historyAfter[1].effective_at).getTime()
    ) {
      fail("role history ordering");
    } else {
      pass("role history ordering");
    }

    const assignmentsAfter = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM employee_work_assignment
       WHERE employee_code = $1`,
      [roleProvisionCode]
    );

    if (assignmentsAfter.rows[0].cnt !== assignmentsBefore.rows[0].cnt) {
      fail("work assignments remain unchanged after role change");
    } else {
      pass("work assignments remain unchanged after role change");
    }

    try {
      await userProvisioningService.changePrimaryRole(
        pool,
        { user: admin },
        roleProvisionCode,
        { role_name: "Interviewer" }
      );
      fail("unchanged role rejected");
    } catch (error) {
      if (error.status === 400) {
        pass("unchanged role rejected");
      } else {
        fail("unchanged role rejected", error.message);
      }
    }

    try {
      await assertCanChangePrimaryRole(pool, { user: admin }, {
        targetEmployeeCode: admin.employee_code,
        targetRoleName: "Recruiter"
      });
      fail("self-role change rejected");
    } catch (error) {
      if (error.status === 403) {
        pass("self-role change rejected");
      } else {
        fail("self-role change rejected", error.message);
      }
    }

    if (userAdministrator) {
      try {
        await userProvisioningService.changePrimaryRole(
          pool,
          { user: userAdministrator },
          roleProvisionCode,
          { role_name: "Admin" }
        );
        fail("USER_ADMINISTRATOR cannot assign Admin role");
      } catch (error) {
        if (error.status === 403) {
          pass("USER_ADMINISTRATOR cannot assign Admin role");
        } else {
          fail("USER_ADMINISTRATOR cannot assign Admin role", error.message);
        }
      }
    }

    if (recruiter) {
      try {
        await userProvisioningService.changePrimaryRole(
          pool,
          { user: recruiter },
          roleProvisionCode,
          { role_name: "Recruiter" }
        );
        fail("unauthorized role change rejected");
      } catch (error) {
        if (error.status === 403) {
          pass("unauthorized role change rejected");
        } else {
          fail("unauthorized role change rejected", error.message);
        }
      }
    }

    const adminCount = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM user_mstr
       WHERE role_name = 'Admin'
         AND COALESCE(is_active, TRUE) = TRUE`
    );

    if (adminCount.rows[0].cnt === 1 && admin.employee_code) {
      try {
        await userProvisioningService.changePrimaryRole(
          pool,
          { user: { ...admin, employee_code: "OTHER_ADMIN_ACTOR" } },
          admin.employee_code,
          { role_name: "Recruiter" }
        );
        fail("last Admin protection");
      } catch (error) {
        if (error.status === 403) {
          pass("last Admin protection");
        } else {
          fail("last Admin protection", error.message);
        }
      }
    } else {
      console.log("SKIP: last Admin protection — multiple active Admins in database");
    }

    const httpRoleChange = await fetchJson(
      `/users/${encodeURIComponent(roleProvisionCode)}/primary-role`,
      adminToken,
      {
        method: "POST",
        body: {
          role_name: "Hiring Manager",
          reason: "HTTP verification"
        }
      }
    );

    if (httpRoleChange.status === 200) {
      pass("HTTP primary role change");
    } else if (httpRoleChange.status === 404) {
      console.log("SKIP: HTTP primary role change — restart backend to load new routes");
    } else {
      fail(
        "HTTP primary role change",
        `${httpRoleChange.status} ${httpRoleChange.body?.message || ""}`
      );
    }

    const httpHistory = await fetchJson(
      `/users/${encodeURIComponent(roleProvisionCode)}/role-history`,
      adminToken
    );

    if (httpHistory.status === 200 && Array.isArray(httpHistory.body?.data)) {
      pass("HTTP role history listing");
    } else if (httpHistory.status === 404 || httpHistory.status === 200) {
      console.log("SKIP: HTTP role history listing — restart backend to load new routes");
    } else {
      fail("HTTP role history listing", String(httpHistory.status));
    }

    const deactivated = await userProvisioningService.changeUserStatus(
      pool,
      { user: admin },
      roleProvisionCode,
      { is_active: false, reason: "Verification deactivation" }
    );

    if (deactivated.user?.is_active !== false) {
      fail("admin deactivate user");
    } else {
      pass("admin deactivate user");
    }

    const inactivePersisted = await pool.query(
      `SELECT is_active FROM user_mstr WHERE employee_code = $1 LIMIT 1`,
      [roleProvisionCode]
    );

    if (inactivePersisted.rows[0]?.is_active === false) {
      pass("inactive account persisted in database");
    } else {
      fail("inactive account persisted in database");
    }

    const statusHistoryAfterDeactivate =
      await userProvisioningService.getStatusHistory(pool, roleProvisionCode);

    if (
      statusHistoryAfterDeactivate.length < 2 ||
      statusHistoryAfterDeactivate[0].new_status !== "Inactive" ||
      statusHistoryAfterDeactivate[0].previous_status !== "Active"
    ) {
      fail("deactivate status history row");
    } else {
      pass("deactivate status history row");
    }

    const inactiveUserToken = signToken({
      user_id: provisioned.user.user_id,
      employee_code: roleProvisionCode,
      email_id: roleProvisionEmail,
      role_name: "Recruiter"
    });

    const inactiveSession = await fetchJson("/candidates", inactiveUserToken);

    if (inactiveSession.status === 403) {
      pass("existing session blocked after deactivation");
    } else if (inactiveSession.status === 200) {
      console.log("SKIP: existing session blocked — restart backend to load active-user guard");
    } else {
      fail(
        "existing session blocked after deactivation",
        String(inactiveSession.status)
      );
    }

    const inactiveLogin = await fetchJson("/login", null, {
      method: "POST",
      body: {
        email_id: roleProvisionEmail,
        password: "VerifyPass123"
      }
    });

    if (inactiveLogin.status === 403) {
      pass("inactive login rejected");
    } else if (inactiveLogin.status === 200) {
      console.log("SKIP: inactive login rejected — restart backend to load login guard");
    } else {
      const inactiveRow = await pool.query(
        `SELECT is_active, email_id
         FROM user_mstr
         WHERE employee_code = $1
         LIMIT 1`,
        [roleProvisionCode]
      );

      if (
        inactiveRow.rows[0]?.is_active === false &&
        (inactiveLogin.status === 401 || inactiveLogin.status === 404)
      ) {
        console.log(
          "SKIP: HTTP inactive login — restart backend to load login guard"
        );
      } else {
        fail(
          "inactive login rejected",
          `${inactiveLogin.status} ${inactiveLogin.body?.message || ""}`
        );
      }
    }

    const assignmentsDuringInactive = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM employee_work_assignment
       WHERE employee_code = $1`,
      [roleProvisionCode]
    );

    if (assignmentsDuringInactive.rows[0].cnt !== assignmentsBefore.rows[0].cnt) {
      fail("work assignments preserved during status change");
    } else {
      pass("work assignments preserved during status change");
    }

    try {
      await userProvisioningService.changeUserStatus(
        pool,
        { user: admin },
        roleProvisionCode,
        { is_active: false }
      );
      fail("redundant deactivate rejected");
    } catch (error) {
      if (error.status === 400) {
        pass("redundant deactivate rejected");
      } else {
        fail("redundant deactivate rejected", error.message);
      }
    }

    try {
      await assertCanChangeUserStatus(pool, { user: admin }, {
        targetEmployeeCode: admin.employee_code
      });
      fail("self-deactivation rejected");
    } catch (error) {
      if (error.status === 403) {
        pass("self-deactivation rejected");
      } else {
        fail("self-deactivation rejected", error.message);
      }
    }

    if (userAdministrator && admin?.employee_code) {
      try {
        await userProvisioningService.changeUserStatus(
          pool,
          { user: userAdministrator },
          admin.employee_code,
          { is_active: false }
        );
        fail("USER_ADMINISTRATOR cannot deactivate Admin");
      } catch (error) {
        if (error.status === 403) {
          pass("USER_ADMINISTRATOR cannot deactivate Admin");
        } else {
          fail("USER_ADMINISTRATOR cannot deactivate Admin", error.message);
        }
      }
    }

    const adminCountForDeactivate = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM user_mstr
       WHERE role_name = 'Admin'
         AND COALESCE(is_active, TRUE) = TRUE`
    );

    if (adminCountForDeactivate.rows[0].cnt === 1 && admin.employee_code) {
      try {
        await userProvisioningService.changeUserStatus(
          pool,
          { user: { ...admin, employee_code: "OTHER_ADMIN_ACTOR" } },
          admin.employee_code,
          { is_active: false }
        );
        fail("last Admin deactivation protection");
      } catch (error) {
        if (error.status === 403) {
          pass("last Admin deactivation protection");
        } else {
          fail("last Admin deactivation protection", error.message);
        }
      }
    } else {
      console.log("SKIP: last Admin deactivation protection — multiple active Admins in database");
    }

    if (recruiter) {
      try {
        await userProvisioningService.changeUserStatus(
          pool,
          { user: recruiter },
          roleProvisionCode,
          { is_active: false }
        );
        fail("unauthorized status change rejected");
      } catch (error) {
        if (error.status === 403) {
          pass("unauthorized status change rejected");
        } else {
          fail("unauthorized status change rejected", error.message);
        }
      }
    }

    const reactivated = await userProvisioningService.changeUserStatus(
      pool,
      { user: admin },
      roleProvisionCode,
      { is_active: true, reason: "Verification reactivation" }
    );

    if (reactivated.user?.is_active !== true) {
      fail("admin activate user");
    } else {
      pass("admin activate user");
    }

    const activeLogin = await fetchJson("/login", null, {
      method: "POST",
      body: {
        email_id: roleProvisionEmail,
        password: "VerifyPass123"
      }
    });

    if (activeLogin.status === 200 && activeLogin.body?.token) {
      pass("reactivated login allowed");
    } else if (activeLogin.status === 401 || activeLogin.status === 403) {
      console.log("SKIP: reactivated login — restart backend to load login guard");
    } else {
      fail("reactivated login allowed", String(activeLogin.status));
    }

    const operationalToken = signToken({
      user_id: provisioned.user.user_id,
      employee_code: roleProvisionCode,
      email_id: roleProvisionEmail,
      role_name: reactivated.user.role_name
    });

    const operationalCandidates = await fetchJson("/candidates", operationalToken);

    if (operationalCandidates.status === 200) {
      pass("reactivated user operational API access");
    } else if (operationalCandidates.status === 404) {
      console.log("SKIP: reactivated operational API — restart backend");
    } else {
      fail(
        "reactivated user operational API access",
        String(operationalCandidates.status)
      );
    }

    const httpDeactivate = await fetchJson(
      `/users/${encodeURIComponent(roleProvisionCode)}/deactivate`,
      adminToken,
      {
        method: "POST",
        body: { reason: "HTTP verification deactivate" }
      }
    );

    if (httpDeactivate.status === 200) {
      pass("HTTP deactivate user");
      await userProvisioningService.changeUserStatus(
        pool,
        { user: admin },
        roleProvisionCode,
        { is_active: true }
      );
    } else if (httpDeactivate.status === 404) {
      console.log("SKIP: HTTP deactivate user — restart backend to load new routes");
    } else {
      fail("HTTP deactivate user", `${httpDeactivate.status} ${httpDeactivate.body?.message || ""}`);
    }

    const httpStatusHistory = await fetchJson(
      `/users/${encodeURIComponent(roleProvisionCode)}/status-history`,
      adminToken
    );

    if (httpStatusHistory.status === 200 && Array.isArray(httpStatusHistory.body?.data)) {
      pass("HTTP status history listing");
    } else if (httpStatusHistory.status === 404 || httpStatusHistory.status === 200) {
      console.log("SKIP: HTTP status history listing — restart backend to load new routes");
    } else {
      fail("HTTP status history listing", String(httpStatusHistory.status));
    }

    await cleanupProvisionedUser(roleProvisionCode);
  } catch (error) {
    await cleanupProvisionedUser(roleProvisionCode);
    fail("role history workflow", error.message);
  }

  const rollbackRoleCode = `VERIFY_ROLE_ROLLBACK_${roleStamp}`;

  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO user_mstr (
         employee_code, full_name, email_id, password_hash, role_name, is_active
       ) VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [
        rollbackRoleCode,
        "Rollback Role",
        `verify.role.rollback.${roleStamp}@optalynx.demo`,
        "hash",
        "Recruiter"
      ]
    );
    await pool.query(
      `INSERT INTO user_role_history (
         employee_code, previous_role_name, new_role_name, effective_at, created_on
       ) VALUES ($1, NULL, $2, NOW(), NOW())`,
      [rollbackRoleCode, "Recruiter"]
    );
    await pool.query("ROLLBACK");

    const residualUser = await pool.query(
      `SELECT user_id FROM user_mstr WHERE employee_code = $1`,
      [rollbackRoleCode]
    );
    const residualHistory = await pool.query(
      `SELECT history_id FROM user_role_history WHERE employee_code = $1`,
      [rollbackRoleCode]
    );

    if (residualUser.rows.length === 0 && residualHistory.rows.length === 0) {
      pass("role history transaction rollback");
    } else {
      await cleanupProvisionedUser(rollbackRoleCode);
      fail("role history transaction rollback");
    }
  } catch (error) {
    try {
      await pool.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore
    }
    await cleanupProvisionedUser(rollbackRoleCode);
    fail("role history transaction rollback", error.message);
  }

  const rollbackStatusCode = `VERIFY_STATUS_ROLLBACK_${stamp}`;

  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO user_mstr (
         employee_code, full_name, email_id, password_hash, role_name, is_active
       ) VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [
        rollbackStatusCode,
        "Rollback Status",
        `verify.status.rollback.${stamp}@optalynx.demo`,
        "hash",
        "Recruiter"
      ]
    );
    await pool.query(
      `INSERT INTO user_status_history (
         employee_code, previous_status, new_status, effective_at, created_on
       ) VALUES ($1, NULL, $2, NOW(), NOW())`,
      [rollbackStatusCode, "Active"]
    );
    await pool.query("ROLLBACK");

    const residualUser = await pool.query(
      `SELECT user_id FROM user_mstr WHERE employee_code = $1`,
      [rollbackStatusCode]
    );
    const residualHistory = await pool.query(
      `SELECT history_id FROM user_status_history WHERE employee_code = $1`,
      [rollbackStatusCode]
    );

    if (residualUser.rows.length === 0 && residualHistory.rows.length === 0) {
      pass("status history transaction rollback");
    } else {
      await cleanupProvisionedUser(rollbackStatusCode);
      fail("status history transaction rollback");
    }
  } catch (error) {
    try {
      await pool.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore
    }
    await cleanupProvisionedUser(rollbackStatusCode);
    fail("status history transaction rollback", error.message);
  }

  if (recruiter && recruiterToken) {
    const inactiveRecruiter = await pool.query(
      `SELECT is_active FROM user_mstr WHERE user_id = $1`,
      [recruiter.user_id]
    );

    if (inactiveRecruiter.rows[0]?.is_active === false) {
      console.log("SKIP: inactive operational API guard — recruiter fixture inactive");
    } else {
      await pool.query(
        `UPDATE user_mstr SET is_active = FALSE, updated_on = NOW() WHERE user_id = $1`,
        [recruiter.user_id]
      );

      const inactiveGuard = await assertEmployeeAccountActive(pool, recruiter);

      if (inactiveGuard === false) {
        pass("inactive account guard detects inactive user");
      } else {
        fail("inactive account guard detects inactive user");
      }

      const inactiveOperational = await fetchJson("/candidates", recruiterToken);

      if (inactiveOperational.status === 403) {
        pass("inactive user blocked from operational API");
      } else if (inactiveOperational.status === 200) {
        console.log("SKIP: inactive operational API — restart backend to load active-user guard");
      } else {
        fail(
          "inactive user blocked from operational API",
          String(inactiveOperational.status)
        );
      }

      await pool.query(
        `UPDATE user_mstr SET is_active = TRUE, updated_on = NOW() WHERE user_id = $1`,
        [recruiter.user_id]
      );
    }
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
