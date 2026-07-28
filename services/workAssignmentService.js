/**
 * Work Assignment Engine — validation and orchestration only.
 * Persistence via workAssignmentRepository.
 * No HTTP handling, auth middleware, or workflow logic.
 */

const workAssignmentRepository = require("../repositories/workAssignmentRepository");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function parseOptionalDate(value, fieldName) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw httpError(`Invalid ${fieldName}.`, 400);
  }

  return parsed;
}

function assertEffectiveDates(effectiveFrom, effectiveTo) {
  const from = parseOptionalDate(effectiveFrom, "effective_from");
  const to = parseOptionalDate(effectiveTo, "effective_to");

  if (from && to && from.getTime() > to.getTime()) {
    throw httpError(
      "effective_from cannot be later than effective_to.",
      400
    );
  }

  return { effectiveFrom: from, effectiveTo: to };
}

function assertWorkAssignmentPayload(data, { partial = false, isCreate = false } = {}) {
  if (!data || typeof data !== "object") {
    throw httpError("Work assignment data is required.", 400);
  }

  if (isCreate || data.assignment_code !== undefined) {
    if (isCreate && isBlank(data.assignment_code)) {
      throw httpError("assignment_code is required.", 400);
    }
  }

  if (!partial || data.assignment_name !== undefined) {
    if (isBlank(data.assignment_name)) {
      throw httpError("assignment_name is required.", 400);
    }
  }

  if (!partial || data.business_module !== undefined) {
    if (isBlank(data.business_module)) {
      throw httpError("business_module is required.", 400);
    }
  }
}

function mapUniqueViolation(error) {
  if (error && error.code === "23505") {
    const detail = String(error.detail || error.message || "");
    if (/assignment_code/i.test(detail)) {
      throw httpError("Assignment Code must be unique.", 409);
    }
    if (/assignment_name/i.test(detail)) {
      throw httpError("Assignment Name must be unique.", 409);
    }
    throw httpError("Duplicate work assignment value.", 409);
  }
  throw error;
}

async function getAllWorkAssignments(pool) {
  return workAssignmentRepository.getAllWorkAssignments(pool);
}

async function getActiveWorkAssignments(pool) {
  return workAssignmentRepository.getActiveWorkAssignments(pool);
}

async function getWorkAssignmentById(pool, id) {
  if (isBlank(id)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  const row = await workAssignmentRepository.getWorkAssignmentById(pool, id);

  if (!row) {
    throw httpError("Work assignment not found.", 404);
  }

  return row;
}

async function getEmployeeCount(pool, id) {
  if (isBlank(id)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  const existing = await workAssignmentRepository.getWorkAssignmentById(
    pool,
    id
  );

  if (!existing) {
    throw httpError("Work assignment not found.", 404);
  }

  const employeesAssigned =
    await workAssignmentRepository.countActiveEmployeesForAssignment(pool, id);

  return {
    work_assignment_id: Number(id),
    employees_assigned: employeesAssigned
  };
}

async function createWorkAssignment(pool, data) {
  assertWorkAssignmentPayload(data, { partial: false, isCreate: true });

  try {
    return await workAssignmentRepository.createWorkAssignment(pool, {
      assignment_code: String(data.assignment_code).trim().toUpperCase(),
      assignment_name: String(data.assignment_name).trim(),
      business_module: String(data.business_module).trim(),
      description: data.description ?? null,
      category: data.category ?? null,
      workspace_route: data.workspace_route ?? null,
      workspace_icon: data.workspace_icon ?? null,
      workspace_flag: data.workspace_flag ?? null,
      display_order: data.display_order,
      system_defined: false,
      is_active: data.is_active,
      created_by: data.created_by ?? null
    });
  } catch (error) {
    mapUniqueViolation(error);
  }
}

async function updateWorkAssignment(pool, id, data) {
  if (isBlank(id)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  if (data && data.assignment_code !== undefined) {
    throw httpError(
      "Assignment Code cannot be modified after creation.",
      400
    );
  }

  assertWorkAssignmentPayload(data || {}, { partial: true, isCreate: false });

  const existing = await workAssignmentRepository.getWorkAssignmentById(
    pool,
    id
  );

  if (!existing) {
    throw httpError("Work assignment not found.", 404);
  }

  const nextIsActive =
    data.is_active === undefined ? undefined : Boolean(data.is_active);

  if (
    nextIsActive === false &&
    existing.is_active === true
  ) {
    const employeesAssigned =
      await workAssignmentRepository.countActiveEmployeesForAssignment(
        pool,
        id
      );

    if (employeesAssigned > 0) {
      throw httpError(
        "Cannot deactivate a Work Assignment that is currently assigned to one or more employees.",
        400
      );
    }
  }

  try {
    const updated = await workAssignmentRepository.updateWorkAssignment(
      pool,
      id,
      {
        assignment_name:
          data.assignment_name === undefined
            ? undefined
            : String(data.assignment_name).trim(),
        business_module:
          data.business_module === undefined
            ? undefined
            : String(data.business_module).trim(),
        description: data.description,
        category: data.category,
        workspace_route: data.workspace_route,
        workspace_icon: data.workspace_icon,
        workspace_flag: data.workspace_flag,
        display_order: data.display_order,
        is_active: data.is_active,
        updated_by: data.updated_by ?? null
      }
    );

    return updated;
  } catch (error) {
    mapUniqueViolation(error);
  }
}

async function activateWorkAssignment(pool, id, updatedBy) {
  if (isBlank(id)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  const existing = await workAssignmentRepository.getWorkAssignmentById(
    pool,
    id
  );

  if (!existing) {
    throw httpError("Work assignment not found.", 404);
  }

  return workAssignmentRepository.setWorkAssignmentActive(
    pool,
    id,
    true,
    updatedBy ?? null
  );
}

async function deactivateWorkAssignment(pool, id, updatedBy) {
  if (isBlank(id)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  const existing = await workAssignmentRepository.getWorkAssignmentById(
    pool,
    id
  );

  if (!existing) {
    throw httpError("Work assignment not found.", 404);
  }

  return workAssignmentRepository.setWorkAssignmentActive(
    pool,
    id,
    false,
    updatedBy ?? null
  );
}

async function deleteWorkAssignment(pool, id) {
  if (isBlank(id)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  const existing = await workAssignmentRepository.getWorkAssignmentById(
    pool,
    id
  );

  if (!existing) {
    throw httpError("Work assignment not found.", 404);
  }

  if (existing.system_defined === true) {
    throw httpError("System Defined assignments cannot be deleted.", 400);
  }

  const employeesAssigned =
    await workAssignmentRepository.countActiveEmployeesForAssignment(pool, id);

  if (employeesAssigned > 0) {
    throw httpError(
      "Cannot delete assignments currently assigned to employees.",
      400
    );
  }

  try {
    const deleted = await workAssignmentRepository.deleteWorkAssignment(
      pool,
      id
    );

    if (!deleted) {
      throw httpError("Work assignment not found.", 404);
    }

    return deleted;
  } catch (error) {
    if (error && error.code === "23503") {
      throw httpError(
        "Cannot delete assignments currently assigned to employees.",
        400
      );
    }
    throw error;
  }
}

async function assignWorkAssignment(
  pool,
  employeeCode,
  workAssignmentId,
  effectiveFrom,
  effectiveTo
) {
  if (isBlank(employeeCode)) {
    throw httpError("employee_code is required.", 400);
  }

  if (isBlank(workAssignmentId)) {
    throw httpError("work_assignment_id is required.", 400);
  }

  const workAssignment = await workAssignmentRepository.getWorkAssignmentById(
    pool,
    workAssignmentId
  );

  if (!workAssignment) {
    throw httpError("Work assignment not found.", 404);
  }

  if (!workAssignment.is_active) {
    throw httpError("Work assignment is not active.", 400);
  }

  const { effectiveFrom: from, effectiveTo: to } = assertEffectiveDates(
    effectiveFrom,
    effectiveTo
  );

  const existingAssignments =
    await workAssignmentRepository.getEmployeeWorkAssignments(
      pool,
      String(employeeCode).trim()
    );

  const duplicate = existingAssignments.find(
    (row) =>
      Number(row.work_assignment_id) === Number(workAssignmentId) &&
      row.is_active === true
  );

  if (duplicate) {
    throw httpError(
      "Employee already has an active assignment for this work assignment.",
      409
    );
  }

  try {
    return await workAssignmentRepository.assignWorkAssignment(
      pool,
      String(employeeCode).trim(),
      workAssignmentId,
      from,
      to
    );
  } catch (error) {
    if (error && error.code === "23505") {
      throw httpError(
        "Employee already has an active assignment for this work assignment.",
        409
      );
    }
    throw error;
  }
}

async function getEmployeeWorkAssignments(pool, employeeCode) {
  if (isBlank(employeeCode)) {
    throw httpError("employee_code is required.", 400);
  }

  return workAssignmentRepository.getEmployeeWorkAssignments(
    pool,
    String(employeeCode).trim()
  );
}

async function removeEmployeeWorkAssignment(pool, employeeWorkAssignmentId) {
  if (isBlank(employeeWorkAssignmentId)) {
    throw httpError("employee_work_assignment_id is required.", 400);
  }

  const removed = await workAssignmentRepository.removeEmployeeWorkAssignment(
    pool,
    employeeWorkAssignmentId
  );

  if (!removed) {
    throw httpError("Employee work assignment not found.", 404);
  }

  return removed;
}

module.exports = {
  getAllWorkAssignments,
  getActiveWorkAssignments,
  getWorkAssignmentById,
  getEmployeeCount,
  createWorkAssignment,
  updateWorkAssignment,
  activateWorkAssignment,
  deactivateWorkAssignment,
  deleteWorkAssignment,
  assignWorkAssignment,
  getEmployeeWorkAssignments,
  removeEmployeeWorkAssignment
};
