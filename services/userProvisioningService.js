/**

 * Atomic Enterprise user provisioning: user_mstr + employee_work_assignment + role history.

 */



const bcrypt = require("bcryptjs");

const workAssignmentRepository = require("../repositories/workAssignmentRepository");

const userRoleHistoryRepository = require("../repositories/userRoleHistoryRepository");

const userStatusHistoryRepository = require("../repositories/userStatusHistoryRepository");

const {

  getProvisionableRoles,

  isPlatformAdmin,

  assertAssignmentGrantAllowed,

  isPrivilegedAssignmentCode,

  assertCanChangePrimaryRole,

  assertCanChangeUserStatus

} = require("./userProvisioningCapabilityAuth");

const { PLATFORM_ADMIN_ROLE } = require("../constants/employeeRoles");



function httpError(message, status = 400) {

  const error = new Error(message);

  error.status = status;

  return error;

}



function isBlank(value) {

  return value === null || value === undefined || String(value).trim() === "";

}



function normalizeEmail(value) {

  return String(value || "").trim().toLowerCase();

}



function isValidEmail(value) {

  const email = normalizeEmail(value);

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

}



function normalizeRoleName(value) {

  const roleName = String(value || "").trim();



  if (!roleName) {

    return "Recruiter";

  }



  return roleName;

}



function normalizeWorkAssignmentIds(value) {

  if (!Array.isArray(value)) {

    return [];

  }



  const ids = value

    .map((item) => Number(item))

    .filter((item) => Number.isInteger(item) && item > 0);



  return [...new Set(ids)];

}



function resolveActorIdentity(req) {

  const employeeCode = req.user?.employee_code

    ? String(req.user.employee_code).trim()

    : null;

  const displayName =

    req.user?.full_name ||

    req.user?.email_id ||

    employeeCode ||

    "System";



  return {

    employee_code: employeeCode,

    display_name: displayName

  };

}



async function loadActiveWorkAssignmentMasters(pool, workAssignmentIds) {

  if (!workAssignmentIds.length) {

    return [];

  }



  const masters = [];



  for (const workAssignmentId of workAssignmentIds) {

    const master = await workAssignmentRepository.getWorkAssignmentById(

      pool,

      workAssignmentId

    );



    if (!master) {

      throw httpError(`Work assignment not found: ${workAssignmentId}`, 404);

    }



    if (!master.is_active) {

      throw httpError(

        `Work assignment is not active: ${master.assignment_code}`,

        400

      );

    }



    masters.push(master);

  }



  return masters;

}



async function assertLastAdminProtection(client, currentRoleName, newRoleName) {

  const currentRole = String(currentRoleName || "").trim();

  const nextRole = String(newRoleName || "").trim();



  if (currentRole !== PLATFORM_ADMIN_ROLE || nextRole === PLATFORM_ADMIN_ROLE) {

    return;

  }



  const result = await client.query(

    `SELECT COUNT(*)::int AS admin_count

     FROM user_mstr

     WHERE role_name = $1

       AND COALESCE(is_active, TRUE) = TRUE`,

    [PLATFORM_ADMIN_ROLE]

  );



  if ((result.rows[0]?.admin_count || 0) <= 1) {

    throw httpError(

      "Cannot change the role of the last active Platform Admin.",

      403

    );

  }

}



async function assertLastActiveAdminOnDeactivate(client, user) {

  const roleName = String(user?.role_name || "").trim();

  if (roleName !== PLATFORM_ADMIN_ROLE || user?.is_active !== true) {

    return;

  }



  const result = await client.query(

    `SELECT COUNT(*)::int AS admin_count

     FROM user_mstr

     WHERE role_name = $1

       AND COALESCE(is_active, TRUE) = TRUE`,

    [PLATFORM_ADMIN_ROLE]

  );



  if ((result.rows[0]?.admin_count || 0) <= 1) {

    throw httpError(

      "Cannot deactivate the last active Platform Admin.",

      403

    );

  }

}



/**

 * Provision a new employee account and optional work assignments atomically.

 */

async function provisionEmployee(pool, req, payload = {}) {

  const employeeCode = String(payload.employee_code || "").trim();

  const fullName = String(payload.full_name || "").trim();

  const emailId = normalizeEmail(payload.email_id);

  const password = String(payload.password || "");

  const roleName = normalizeRoleName(payload.role_name);

  const workAssignmentIds = normalizeWorkAssignmentIds(

    payload.work_assignment_ids

  );



  if (isBlank(employeeCode)) {

    throw httpError("employee_code is required.", 400);

  }



  if (isBlank(fullName)) {

    throw httpError("full_name is required.", 400);

  }



  if (!isValidEmail(emailId)) {

    throw httpError("A valid email_id is required.", 400);

  }



  if (!password || password.length < 8) {

    throw httpError("password must be at least 8 characters.", 400);

  }



  const provisionableRoles = getProvisionableRoles(req);



  if (!provisionableRoles.includes(roleName)) {

    throw httpError(

      `role_name must be one of: ${provisionableRoles.join(", ")}.`,

      400

    );

  }



  if (!isPlatformAdmin(req) && roleName === PLATFORM_ADMIN_ROLE) {

    throw httpError(

      "Enterprise Access Denied. User Administrators cannot create Admin users.",

      403

    );

  }



  const assignmentMasters = await loadActiveWorkAssignmentMasters(

    pool,

    workAssignmentIds

  );



  for (const master of assignmentMasters) {

    assertAssignmentGrantAllowed(req, master.assignment_code);



    if (

      !isPlatformAdmin(req) &&

      isPrivilegedAssignmentCode(master.assignment_code)

    ) {

      throw httpError(

        "Enterprise Access Denied. Only Platform Admins may grant privileged work assignments.",

        403

      );

    }

  }



  const hashedPassword = await bcrypt.hash(password, 10);

  const actor = resolveActorIdentity(req);



  const client = await pool.connect();



  try {

    await client.query("BEGIN");



    const duplicateCode = await client.query(

      `SELECT user_id

       FROM user_mstr

       WHERE employee_code = $1

       LIMIT 1`,

      [employeeCode]

    );



    if (duplicateCode.rows.length > 0) {

      throw httpError("employee_code already exists.", 409);

    }



    const duplicateEmail = await client.query(

      `SELECT user_id

       FROM user_mstr

       WHERE LOWER(email_id) = $1

       LIMIT 1`,

      [emailId]

    );



    if (duplicateEmail.rows.length > 0) {

      throw httpError("email_id already exists.", 409);

    }



    const userResult = await client.query(

      `INSERT INTO user_mstr (

         employee_code,

         full_name,

         email_id,

         password_hash,

         role_name,

         is_active

       ) VALUES ($1, $2, $3, $4, $5, TRUE)

       RETURNING

         user_id,

         employee_code,

         full_name,

         email_id,

         role_name,

         is_active,

         created_on`,

      [employeeCode, fullName, emailId, hashedPassword, roleName]

    );



    const user = userResult.rows[0];



    await userRoleHistoryRepository.insertRoleHistory(client, {

      employee_code: employeeCode,

      previous_role_name: null,

      new_role_name: roleName,

      changed_by_employee_code: actor.employee_code,

      changed_by_name: actor.display_name,

      reason: null

    });



    await userStatusHistoryRepository.insertStatusHistory(client, {

      employee_code: employeeCode,

      previous_status: null,

      new_status: userStatusHistoryRepository.STATUS_ACTIVE,

      changed_by_employee_code: actor.employee_code,

      changed_by_name: actor.display_name,

      reason: null

    });



    const assignedRows = [];



    for (const master of assignmentMasters) {

      const assigned = await workAssignmentRepository.assignWorkAssignment(

        client,

        employeeCode,

        master.work_assignment_id,

        null,

        null

      );



      assignedRows.push({

        ...assigned,

        assignment_code: master.assignment_code,

        assignment_name: master.assignment_name

      });

    }



    await client.query("COMMIT");



    return {

      user,

      work_assignments: assignedRows

    };

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();

  }

}



/**

 * Change an employee's Primary Role and append immutable history.

 */

async function changePrimaryRole(pool, req, employeeCode, payload = {}) {

  const targetEmployeeCode = String(employeeCode || "").trim();

  const newRoleName = normalizeRoleName(payload.role_name);

  const reason = payload.reason ? String(payload.reason).trim() : null;



  if (!targetEmployeeCode) {

    throw httpError("employeeCode is required.", 400);

  }



  const provisionableRoles = getProvisionableRoles(req);



  if (!provisionableRoles.includes(newRoleName)) {

    throw httpError(

      `role_name must be one of: ${provisionableRoles.join(", ")}.`,

      400

    );

  }



  await assertCanChangePrimaryRole(pool, req, {

    targetEmployeeCode,

    targetRoleName: newRoleName

  });



  const actor = resolveActorIdentity(req);

  const client = await pool.connect();



  try {

    await client.query("BEGIN");



    const userResult = await client.query(

      `SELECT

         user_id,

         employee_code,

         full_name,

         email_id,

         role_name,

         is_active,

         created_on,

         updated_on

       FROM user_mstr

       WHERE employee_code = $1

       FOR UPDATE`,

      [targetEmployeeCode]

    );



    const user = userResult.rows[0];



    if (!user) {

      throw httpError(`User not found: ${targetEmployeeCode}`, 404);

    }



    const currentRoleName = String(user.role_name || "").trim();



    if (currentRoleName === newRoleName) {

      throw httpError("Primary Role is unchanged.", 400);

    }



    await assertLastAdminProtection(client, currentRoleName, newRoleName);



    const updateResult = await client.query(

      `UPDATE user_mstr

       SET role_name = $1,

           updated_on = NOW()

       WHERE employee_code = $2

       RETURNING

         user_id,

         employee_code,

         full_name,

         email_id,

         role_name,

         is_active,

         created_on,

         updated_on`,

      [newRoleName, targetEmployeeCode]

    );



    const history = await userRoleHistoryRepository.insertRoleHistory(client, {

      employee_code: targetEmployeeCode,

      previous_role_name: currentRoleName,

      new_role_name: newRoleName,

      changed_by_employee_code: actor.employee_code,

      changed_by_name: actor.display_name,

      reason: reason || null

    });



    await client.query("COMMIT");



    return {

      user: updateResult.rows[0],

      history

    };

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();

  }

}



async function getRoleHistory(pool, employeeCode) {

  const targetEmployeeCode = String(employeeCode || "").trim();



  if (!targetEmployeeCode) {

    throw httpError("employeeCode is required.", 400);

  }



  const userResult = await pool.query(

    `SELECT user_id

     FROM user_mstr

     WHERE employee_code = $1

     LIMIT 1`,

    [targetEmployeeCode]

  );



  if (!userResult.rows[0]) {

    throw httpError(`User not found: ${targetEmployeeCode}`, 404);

  }



  const history = await userRoleHistoryRepository.listRoleHistoryByEmployeeCode(

    pool,

    targetEmployeeCode

  );



  return history;

}



async function changeUserStatus(pool, req, employeeCode, payload = {}) {

  const targetEmployeeCode = String(employeeCode || "").trim();

  const targetActive = payload.is_active === true;

  const reason = payload.reason ? String(payload.reason).trim() : null;



  if (!targetEmployeeCode) {

    throw httpError("employeeCode is required.", 400);

  }



  await assertCanChangeUserStatus(pool, req, { targetEmployeeCode });



  const actor = resolveActorIdentity(req);

  const client = await pool.connect();



  try {

    await client.query("BEGIN");



    const userResult = await client.query(

      `SELECT

         user_id,

         employee_code,

         full_name,

         email_id,

         role_name,

         is_active,

         created_on,

         updated_on

       FROM user_mstr

       WHERE employee_code = $1

       FOR UPDATE`,

      [targetEmployeeCode]

    );



    const user = userResult.rows[0];



    if (!user) {

      throw httpError(`User not found: ${targetEmployeeCode}`, 404);

    }



    const currentActive = user.is_active === true;



    if (currentActive === targetActive) {

      throw httpError(

        `User is already ${targetActive ? "Active" : "Inactive"}.`,

        400

      );

    }



    if (!targetActive) {

      await assertLastActiveAdminOnDeactivate(client, user);

    }



    const updateResult = await client.query(

      `UPDATE user_mstr

       SET is_active = $1,

           updated_on = NOW()

       WHERE employee_code = $2

       RETURNING

         user_id,

         employee_code,

         full_name,

         email_id,

         role_name,

         is_active,

         created_on,

         updated_on`,

      [targetActive, targetEmployeeCode]

    );



    const history = await userStatusHistoryRepository.insertStatusHistory(

      client,

      {

        employee_code: targetEmployeeCode,

        previous_status: userStatusHistoryRepository.statusFromBoolean(

          currentActive

        ),

        new_status: userStatusHistoryRepository.statusFromBoolean(targetActive),

        changed_by_employee_code: actor.employee_code,

        changed_by_name: actor.display_name,

        reason: reason || null

      }

    );



    await client.query("COMMIT");



    return {

      user: updateResult.rows[0],

      history

    };

  } catch (error) {

    await client.query("ROLLBACK");

    throw error;

  } finally {

    client.release();

  }

}



async function getStatusHistory(pool, employeeCode) {

  const targetEmployeeCode = String(employeeCode || "").trim();



  if (!targetEmployeeCode) {

    throw httpError("employeeCode is required.", 400);

  }



  const userResult = await pool.query(

    `SELECT user_id

     FROM user_mstr

     WHERE employee_code = $1

     LIMIT 1`,

    [targetEmployeeCode]

  );



  if (!userResult.rows[0]) {

    throw httpError(`User not found: ${targetEmployeeCode}`, 404);

  }



  return userStatusHistoryRepository.listStatusHistoryByEmployeeCode(

    pool,

    targetEmployeeCode

  );

}



module.exports = {

  provisionEmployee,

  changePrimaryRole,

  changeUserStatus,

  getRoleHistory,

  getStatusHistory,

  normalizeWorkAssignmentIds,

  normalizeRoleName

};


