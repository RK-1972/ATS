/**
 * Keeps interview_panel_mstr aligned with active INTERVIEWER work assignments.
 * Scheduling continues to use panel_id as the source of truth.
 */

const INTERVIEWER_ASSIGNMENT_CODE = "INTERVIEWER";

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function tableExists(pool, tableName) {
  const result = await pool.query(`SELECT to_regclass($1) AS table_name`, [
    `public.${tableName}`
  ]);
  return Boolean(result.rows[0]?.table_name);
}

async function assertInterviewPanelSchema(pool) {
  if (!(await tableExists(pool, "interview_panel_mstr"))) {
    throw httpError("interview_panel_mstr is not available.", 500);
  }

  const columns = await pool.query(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'interview_panel_mstr'`
  );

  const byName = new Map(
    columns.rows.map((row) => [row.column_name, row.is_nullable === "YES"])
  );

  const required = ["panel_id", "employee_code", "interviewer_name", "is_active"];
  for (const name of required) {
    if (!byName.has(name)) {
      throw httpError(`interview_panel_mstr.${name} is missing.`, 500);
    }
  }

  if (!byName.has("interviewer_type") || !byName.get("interviewer_type")) {
    throw httpError(
      "interview_panel_mstr.interviewer_type must exist and allow NULL for auto-provision.",
      500
    );
  }

  const constraints = await pool.query(
    `SELECT pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname = 'interview_panel_mstr'
       AND con.contype = 'u'`
  );

  const hasEmployeeCodeUnique = constraints.rows.some((row) =>
    /UNIQUE\s*\(\s*employee_code\s*\)/i.test(row.def || "")
  );

  if (!hasEmployeeCodeUnique) {
    throw httpError(
      "interview_panel_mstr must have UNIQUE (employee_code) for safe upsert.",
      500
    );
  }
}

async function loadUserForPanel(pool, employeeCode) {
  const code = String(employeeCode || "").trim();
  const result = await pool.query(
    `SELECT
       user_id,
       employee_code,
       full_name,
       email_id,
       department,
       designation,
       primary_skill
     FROM user_mstr
     WHERE employee_code = $1`,
    [code]
  );

  return result.rows[0] || null;
}

async function findPanelByEmployeeOrUser(pool, employeeCode, userId) {
  const result = await pool.query(
    `SELECT panel_id, employee_code, user_id, is_active
     FROM interview_panel_mstr
     WHERE employee_code = $1
        OR ($2::int IS NOT NULL AND user_id = $2)
     ORDER BY
       CASE WHEN employee_code = $1 THEN 0 ELSE 1 END,
       panel_id ASC
     LIMIT 1`,
    [employeeCode, userId ?? null]
  );

  return result.rows[0] || null;
}

/**
 * Upsert/reactivate panel row when INTERVIEWER work assignment is active.
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 */
async function syncInterviewerPanelForActiveAssignment(pool, employeeCode) {
  await assertInterviewPanelSchema(pool);

  const user = await loadUserForPanel(pool, employeeCode);
  if (!user) {
    throw httpError(`Employee not found: ${employeeCode}`, 404);
  }

  const interviewerName = String(user.full_name || "").trim() || user.employee_code;
  const emailId = user.email_id || null;
  const existing = await findPanelByEmployeeOrUser(
    pool,
    user.employee_code,
    user.user_id
  );

  if (existing) {
    const updated = await pool.query(
      `UPDATE interview_panel_mstr
       SET
         user_id = $2,
         employee_code = $3,
         interviewer_name = $4,
         email_id = $5,
         department = COALESCE($6, department),
         designation = COALESCE($7, designation),
         primary_skill = COALESCE($8, primary_skill),
         is_active = TRUE,
         updated_on = CURRENT_TIMESTAMP
       WHERE panel_id = $1
       RETURNING panel_id, is_active`,
      [
        existing.panel_id,
        user.user_id,
        user.employee_code,
        interviewerName,
        emailId,
        user.department || null,
        user.designation || null,
        user.primary_skill || null
      ]
    );

    return {
      panel_id: updated.rows[0].panel_id,
      created: false,
      reactivated: existing.is_active !== true
    };
  }

  try {
    const inserted = await pool.query(
      `INSERT INTO interview_panel_mstr (
         user_id,
         employee_code,
         interviewer_name,
         email_id,
         primary_skill,
         department,
         designation,
         interviewer_type,
         is_active
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, TRUE)
       RETURNING panel_id`,
      [
        user.user_id,
        user.employee_code,
        interviewerName,
        emailId,
        user.primary_skill || null,
        user.department || null,
        user.designation || null
      ]
    );

    return {
      panel_id: inserted.rows[0].panel_id,
      created: true,
      reactivated: false
    };
  } catch (error) {
    if (error && error.code === "23505") {
      const raced = await findPanelByEmployeeOrUser(
        pool,
        user.employee_code,
        user.user_id
      );
      if (raced) {
        const updated = await pool.query(
          `UPDATE interview_panel_mstr
           SET
             user_id = $2,
             employee_code = $3,
             interviewer_name = $4,
             email_id = $5,
             department = COALESCE($6, department),
             designation = COALESCE($7, designation),
             primary_skill = COALESCE($8, primary_skill),
             is_active = TRUE,
             updated_on = CURRENT_TIMESTAMP
           WHERE panel_id = $1
           RETURNING panel_id`,
          [
            raced.panel_id,
            user.user_id,
            user.employee_code,
            interviewerName,
            emailId,
            user.department || null,
            user.designation || null,
            user.primary_skill || null
          ]
        );
        return {
          panel_id: updated.rows[0].panel_id,
          created: false,
          reactivated: true
        };
      }
    }
    throw error;
  }
}

/**
 * Deactivate panel when INTERVIEWER work assignment is removed (row preserved).
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 */
async function deactivateInterviewerPanelForEmployee(pool, employeeCode) {
  if (!(await tableExists(pool, "interview_panel_mstr"))) {
    return { panel_id: null, updated: false };
  }

  const user = await loadUserForPanel(pool, employeeCode);
  if (!user) {
    return { panel_id: null, updated: false };
  }

  const existing = await findPanelByEmployeeOrUser(
    pool,
    user.employee_code,
    user.user_id
  );

  if (!existing) {
    return { panel_id: null, updated: false };
  }

  const updated = await pool.query(
    `UPDATE interview_panel_mstr
     SET is_active = FALSE, updated_on = CURRENT_TIMESTAMP
     WHERE panel_id = $1
     RETURNING panel_id`,
    [existing.panel_id]
  );

  return {
    panel_id: updated.rows[0]?.panel_id ?? existing.panel_id,
    updated: true
  };
}

function isInterviewerAssignmentCode(assignmentCode) {
  return (
    String(assignmentCode || "").trim().toUpperCase() === INTERVIEWER_ASSIGNMENT_CODE
  );
}

module.exports = {
  INTERVIEWER_ASSIGNMENT_CODE,
  assertInterviewPanelSchema,
  syncInterviewerPanelForActiveAssignment,
  deactivateInterviewerPanelForEmployee,
  isInterviewerAssignmentCode
};
