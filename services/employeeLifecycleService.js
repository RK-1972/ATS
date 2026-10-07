const userProvisioningService = require("./userProvisioningService");
const recruitmentService = require("./recruitmentService");
const workflowService = require("./workflowService");
const interviewService = require("./interviewService");
const {
  buildResponsibilityPreflight,
  listOrganizationClearanceQueue,
  RESPONSIBILITY_CATEGORIES,
  REQUIRED_ACTIONS,
  assertSuccessorActive
} = require("./employeeResponsibilityPreflightService");
const { assertCanManageEmployeeLifecycle } = require("./employeeLifecycleCapabilityAuth");
const { assertCanChangeUserStatus } = require("./userProvisioningCapabilityAuth");
const { recordLifecycleAudit } = require("./employeeLifecycleAudit");
const { userContext } = require("./enterpriseAuditService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resolveActorIdentity(req) {
  const user = userContext(req);
  return {
    employee_code: req.user?.employee_code || user.employeeCode || null,
    name: user.name
  };
}

async function suspendActiveWorkAssignments(pool, req, employeeCode, reason) {
  const result = await pool.query(
    `UPDATE employee_work_assignment
     SET
       is_active = FALSE,
       effective_to = COALESCE(effective_to, CURRENT_DATE),
       updated_on = NOW()
     WHERE employee_code = $1
       AND is_active = TRUE
     RETURNING *`,
    [employeeCode]
  );

  for (const row of result.rows) {
    await recordLifecycleAudit(pool, req, {
      action: "Work assignment suspended on deactivation",
      entityId: String(row.employee_work_assignment_id),
      affectedEmployeeCode: employeeCode,
      responsibilityCategory: RESPONSIBILITY_CATEGORIES.WORK_ASSIGNMENT,
      oldAssigneeOrOwner: employeeCode,
      sourceOperation: "deactivate",
      reason
    });
  }

  return result.rows;
}

async function transferCandidateOwnership(
  db,
  req,
  candidateId,
  fromCode,
  toCode,
  reason,
  options = {}
) {
  await recruitmentService.assertGovernancePipelineOwnershipTransfer(
    db,
    req,
    candidateId,
    fromCode
  );
  await assertSuccessorActive(db, toCode);

  const inTransaction = options.inTransaction === true;
  const client = inTransaction ? db : await db.connect();
  const auditPool = inTransaction ? db : client;

  try {
    if (!inTransaction) {
      await client.query("BEGIN");
    }

    const cand = await client.query(
      `SELECT candidate_id, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1
       FOR UPDATE`,
      [candidateId]
    );

    if (!cand.rows.length) {
      throw httpError("Candidate not found.", 404);
    }

    const currentOwner = String(cand.rows[0].owner_employee_code || "").trim();
    if (currentOwner && currentOwner !== String(fromCode).trim()) {
      throw httpError("Candidate ownership has changed since preflight.", 409);
    }

    await client.query(
      `UPDATE cand_mstr
       SET owner_employee_code = $1
       WHERE candidate_id = $2`,
      [toCode, candidateId]
    );

    if (!inTransaction) {
      await client.query("COMMIT");
    }

    await recordLifecycleAudit(auditPool, req, {
      action: "Candidate ownership transferred (lifecycle clearance)",
      entityId: String(candidateId),
      affectedEmployeeCode: fromCode,
      responsibilityCategory: RESPONSIBILITY_CATEGORIES.CANDIDATE_OWNERSHIP,
      oldAssigneeOrOwner: currentOwner || fromCode,
      newAssigneeOrOwner: toCode,
      sourceOperation: "responsibility_clearance",
      reason
    });
  } catch (error) {
    if (!inTransaction) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw error;
  } finally {
    if (!inTransaction) {
      client.release();
    }
  }
}

async function resolveTransferRequest(db, req, requestId, fromCode, payload = {}) {
  const action = String(payload.action || "cancel").toLowerCase();
  const successorCode = payload.successor_employee_code
    ? String(payload.successor_employee_code).trim()
    : null;

  const requestResult = await db.query(
    `SELECT * FROM rm_candidate_transfer_requests WHERE request_id = $1`,
    [requestId]
  );

  const request = requestResult.rows[0];
  if (!request || request.status !== "Pending") {
    throw httpError("Transfer request not found or not pending.", 404);
  }

  const actor = resolveActorIdentity(req);

  if (action === "reassign_target" && successorCode) {
    await assertSuccessorActive(db, successorCode);
    await db.query(
      `UPDATE rm_candidate_transfer_requests
       SET to_recruiter_id = $1
       WHERE request_id = $2`,
      [successorCode, requestId]
    );
    await recordLifecycleAudit(db, req, {
      action: "Transfer request target reassigned",
      entityId: String(requestId),
      affectedEmployeeCode: fromCode,
      responsibilityCategory: RESPONSIBILITY_CATEGORIES.CANDIDATE_TRANSFER_REQUEST,
      oldAssigneeOrOwner: request.to_recruiter_id,
      newAssigneeOrOwner: successorCode,
      sourceOperation: "responsibility_clearance",
      reason: payload.reason
    });
    return;
  }

  await db.query(
    `UPDATE rm_candidate_transfer_requests
     SET status = 'Cancelled',
         actioned_on = NOW(),
         actioned_by = $1
     WHERE request_id = $2`,
    [actor.employee_code || actor.name, requestId]
  );

  await recordLifecycleAudit(db, req, {
    action: "Transfer request cancelled (lifecycle clearance)",
    entityId: String(requestId),
    affectedEmployeeCode: fromCode,
    responsibilityCategory: RESPONSIBILITY_CATEGORIES.CANDIDATE_TRANSFER_REQUEST,
    oldAssigneeOrOwner: fromCode,
    sourceOperation: "responsibility_clearance",
    reason: payload.reason
  });
}

async function applyResolution(db, req, employeeCode, resolution, options = {}) {
  const category = String(resolution.category || "").trim();
  const recordId = resolution.record_id;
  const successorCode = resolution.successor_employee_code
    ? String(resolution.successor_employee_code).trim()
    : null;
  const reason = resolution.reason ? String(resolution.reason).trim() : null;
  const txOptions = options.inTransaction ? { client: db } : null;

  if (category === RESPONSIBILITY_CATEGORIES.RECRUITER_ASSIGNMENT) {
    if (!successorCode) {
      await recruitmentService.removeRecruiterAssignment(db, recordId, req);
      await recordLifecycleAudit(db, req, {
        action: "Recruiter unassigned (lifecycle clearance)",
        entityId: String(recordId),
        affectedEmployeeCode: employeeCode,
        responsibilityCategory: category,
        oldAssigneeOrOwner: employeeCode,
        sourceOperation: "responsibility_clearance",
        reason
      });
      return;
    }

    await assertSuccessorActive(db, successorCode);
    const assignment = await db.query(
      `SELECT requisition_code, req_id FROM rm_recruiter_assignments WHERE assignment_id = $1`,
      [recordId]
    );
    const row = assignment.rows[0];
    if (!row) {
      throw httpError("Recruiter assignment not found.", 404);
    }

    await recruitmentService.removeRecruiterAssignment(db, recordId, req);
    const reqKey = row.requisition_code || row.req_id;
    await recruitmentService.assignRecruiter(db, reqKey, successorCode, req);

    await recordLifecycleAudit(db, req, {
      action: "Recruiter replaced (lifecycle clearance)",
      entityId: String(recordId),
      affectedEmployeeCode: employeeCode,
      responsibilityCategory: category,
      oldAssigneeOrOwner: employeeCode,
      newAssigneeOrOwner: successorCode,
      sourceOperation: "responsibility_clearance",
      reason
    });
    return;
  }

  if (category === RESPONSIBILITY_CATEGORIES.CANDIDATE_OWNERSHIP) {
    if (!successorCode) {
      throw httpError("successor_employee_code is required for candidate ownership transfer.", 400);
    }
    await transferCandidateOwnership(
      db,
      req,
      Number(recordId),
      employeeCode,
      successorCode,
      reason,
      options
    );
    return;
  }

  if (category === RESPONSIBILITY_CATEGORIES.CANDIDATE_TRANSFER_REQUEST) {
    await resolveTransferRequest(db, req, Number(recordId), employeeCode, {
      action: resolution.action || "cancel",
      successor_employee_code: successorCode,
      reason
    });
    return;
  }

  if (category === RESPONSIBILITY_CATEGORIES.WORKFLOW_TASK) {
    if (!successorCode) {
      throw httpError("successor_employee_code is required for workflow reassignment.", 400);
    }
    await assertSuccessorActive(db, successorCode);
    await workflowService.reassignTask(
      db,
      Number(recordId),
      successorCode,
      req,
      resolution.assignee_role || resolution.assigneeRole || null,
      txOptions
    );
    await recordLifecycleAudit(db, req, {
      action: "Workflow task reassigned (lifecycle clearance)",
      entityId: String(recordId),
      affectedEmployeeCode: employeeCode,
      responsibilityCategory: category,
      oldAssigneeOrOwner: employeeCode,
      newAssigneeOrOwner: successorCode,
      sourceOperation: "responsibility_clearance",
      reason
    });
    return;
  }

  if (category === RESPONSIBILITY_CATEGORIES.INTERVIEW_PANEL) {
    if (!successorCode) {
      throw httpError("successor_employee_code is required for interview panel replacement.", 400);
    }
    const successor = await db.query(
      `SELECT full_name, email_id FROM user_mstr WHERE employee_code = $1 AND is_active = TRUE`,
      [successorCode]
    );
    if (!successor.rows.length) {
      throw httpError("Successor must be an active employee.", 400);
    }
    await interviewService.reassignPanel(
      db,
      recordId,
      {
        interviewer_name: successor.rows[0].full_name,
        interviewer_email: successor.rows[0].email_id
      },
      req,
      txOptions
    );
    await recordLifecycleAudit(db, req, {
      action: "Interview panel replaced (lifecycle clearance)",
      entityId: String(recordId),
      affectedEmployeeCode: employeeCode,
      responsibilityCategory: category,
      oldAssigneeOrOwner: employeeCode,
      newAssigneeOrOwner: successorCode,
      sourceOperation: "responsibility_clearance",
      reason
    });
    return;
  }

  if (category === RESPONSIBILITY_CATEGORIES.WORK_ASSIGNMENT) {
    return;
  }

  throw httpError(`Unsupported responsibility category: ${category}`, 400);
}

function blockingItemsUnresolved(preflight, resolutions) {
  const blocking = preflight.items.filter((item) => item.blocking);
  if (!blocking.length) {
    return [];
  }

  const resolutionKeys = new Set(
    (resolutions || []).map(
      (item) => `${item.category}:${String(item.record_id)}`
    )
  );

  return blocking.filter(
    (item) => !resolutionKeys.has(`${item.category}:${String(item.record_id)}`)
  );
}

async function createClearanceException(pool, req, employeeCode, reason) {
  const actor = resolveActorIdentity(req);
  const result = await pool.query(
    `INSERT INTO employee_responsibility_clearance_exception (
       employee_code,
       status,
       reason,
       created_by_employee_code,
       created_by_name
     ) VALUES ($1, 'Open', $2, $3, $4)
     RETURNING *`,
    [employeeCode, reason || null, actor.employee_code, actor.name]
  );

  await recordLifecycleAudit(pool, req, {
    action: "Emergency deactivation clearance exception opened",
    entityId: String(result.rows[0].exception_id),
    affectedEmployeeCode: employeeCode,
    sourceOperation: "emergency_deactivate",
    reason
  });

  return result.rows[0];
}

async function applyResolutionsInTransaction(pool, req, employeeCode, resolutions) {
  if (!resolutions.length) {
    return;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const resolution of resolutions) {
      await applyResolution(client, req, employeeCode, resolution, {
        inTransaction: true
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function applyResponsibilityResolutions(pool, req, employeeCode, payload = {}) {
  const code = String(employeeCode || "").trim();
  const resolutions = Array.isArray(payload.resolutions) ? payload.resolutions : [];
  const reason = payload.reason ? String(payload.reason).trim() : null;

  await assertCanManageEmployeeLifecycle(pool, req);

  if (!code) {
    throw httpError("employeeCode is required.", 400);
  }

  await applyResolutionsInTransaction(pool, req, code, resolutions);

  const preflight = await buildResponsibilityPreflight(pool, code);
  const blocking = preflight.items.filter((item) => item.blocking);

  await recordLifecycleAudit(pool, req, {
    action: "Responsibility resolutions applied",
    entityId: code,
    affectedEmployeeCode: code,
    sourceOperation: "responsibility_clearance",
    reason,
    metadata: {
      resolutions_applied: resolutions.length,
      blocking_remaining: blocking.length
    }
  });

  return { preflight, blocking_remaining: blocking.length };
}

async function deactivateEmployee(pool, req, employeeCode, payload = {}) {
  const code = String(employeeCode || "").trim();
  const reason = payload.reason ? String(payload.reason).trim() : null;
  const emergency = payload.emergency === true;
  const resolutions = Array.isArray(payload.resolutions) ? payload.resolutions : [];

  await assertCanChangeUserStatus(pool, req, { targetEmployeeCode: code });

  const preflight = await buildResponsibilityPreflight(pool, code);
  const unresolved = blockingItemsUnresolved(preflight, resolutions);

  if (unresolved.length && !emergency) {
    const error = httpError(
      "Unresolved blocking responsibilities. Complete clearance or use emergency deactivation.",
      409
    );
    error.data = { preflight, unresolved };
    throw error;
  }

  await applyResolutionsInTransaction(pool, req, code, resolutions);

  if (!emergency) {
    const afterResolutions = await buildResponsibilityPreflight(pool, code);
    const stillBlocking = afterResolutions.items.filter((item) => item.blocking);
    if (stillBlocking.length) {
      const error = httpError(
        "Blocking responsibilities remain after clearance.",
        409
      );
      error.data = { preflight: afterResolutions, unresolved: stillBlocking };
      throw error;
    }
  }

  if (emergency) {
    await createClearanceException(pool, req, code, reason);
  }

  await suspendActiveWorkAssignments(pool, req, code, reason);

  const statusResult = await userProvisioningService.changeUserStatus(pool, req, code, {
    is_active: false,
    reason
  });

  await recordLifecycleAudit(pool, req, {
    action: emergency ? "Employee emergency deactivated" : "Employee deactivated with lifecycle clearance",
    entityId: code,
    affectedEmployeeCode: code,
    sourceOperation: emergency ? "emergency_deactivate" : "deactivate",
    reason,
    metadata: {
      resolutions_applied: resolutions.length,
      emergency
    }
  });

  return {
    ...statusResult,
    preflight_summary: preflight.summary,
    emergency_exception: emergency
  };
}

async function bulkReplaceRecruiter(pool, req, payload) {
  await assertCanManageEmployeeLifecycle(pool, req);

  const fromCode = String(payload.from_recruiter_code || "").trim();
  const toCode = String(payload.to_recruiter_code || "").trim();
  const assignmentIds = Array.isArray(payload.assignment_ids)
    ? payload.assignment_ids.map((id) => Number(id)).filter((id) => id > 0)
    : [];

  if (!fromCode || !toCode) {
    throw httpError("from_recruiter_code and to_recruiter_code are required.", 400);
  }

  await assertSuccessorActive(pool, toCode);

  const toUser = await pool.query(
    `SELECT role_name FROM user_mstr WHERE employee_code = $1 AND is_active = TRUE`,
    [toCode]
  );
  if (toUser.rows[0]?.role_name !== "Recruiter") {
    throw httpError("Successor must be an active Recruiter.", 400);
  }

  let rows = [];
  if (assignmentIds.length) {
    const result = await pool.query(
      `SELECT assignment_id, requisition_code, req_id
       FROM rm_recruiter_assignments
       WHERE assignment_id = ANY($1::int[])
         AND recruiter_code = $2
         AND is_active = TRUE`,
      [assignmentIds, fromCode]
    );
    rows = result.rows;
  } else {
    const result = await pool.query(
      `SELECT assignment_id, requisition_code, req_id
       FROM rm_recruiter_assignments
       WHERE recruiter_code = $1 AND is_active = TRUE`,
      [fromCode]
    );
    rows = result.rows;
  }

  const outcomes = [];
  for (const row of rows) {
    await recruitmentService.removeRecruiterAssignment(pool, row.assignment_id, req);
    const reqKey = row.requisition_code || row.req_id;
    await recruitmentService.assignRecruiter(pool, reqKey, toCode, req);
    outcomes.push(row.assignment_id);
  }

  await recordLifecycleAudit(pool, req, {
    action: "Bulk recruiter replacement",
    entityId: fromCode,
    affectedEmployeeCode: fromCode,
    responsibilityCategory: RESPONSIBILITY_CATEGORIES.RECRUITER_ASSIGNMENT,
    oldAssigneeOrOwner: fromCode,
    newAssigneeOrOwner: toCode,
    sourceOperation: "bulk_recruiter_replacement",
    reason: payload.reason,
    metadata: { assignment_count: outcomes.length }
  });

  return { replaced_count: outcomes.length, assignment_ids: outcomes };
}

async function bulkReassignWorkflowTasks(pool, req, payload) {
  await assertCanManageEmployeeLifecycle(pool, req);

  const fromCode = String(payload.from_assignee_code || "").trim();
  const toCode = String(payload.to_assignee_code || "").trim();
  const taskIds = Array.isArray(payload.task_ids)
    ? payload.task_ids.map((id) => Number(id)).filter((id) => id > 0)
    : [];

  if (!fromCode || !toCode) {
    throw httpError("from_assignee_code and to_assignee_code are required.", 400);
  }

  await assertSuccessorActive(pool, toCode);

  let tasks = [];
  if (taskIds.length) {
    const result = await pool.query(
      `SELECT task_id FROM wf_tasks
       WHERE task_id = ANY($1::int[])
         AND assignee = $2
         AND LOWER(status) = 'pending'`,
      [taskIds, fromCode]
    );
    tasks = result.rows;
  } else {
    const result = await pool.query(
      `SELECT task_id FROM wf_tasks
       WHERE assignee = $1 AND LOWER(status) = 'pending'`,
      [fromCode]
    );
    tasks = result.rows;
  }

  for (const row of tasks) {
    await workflowService.reassignTask(pool, row.task_id, toCode, req, payload.assignee_role || null);
  }

  await recordLifecycleAudit(pool, req, {
    action: "Bulk workflow task reassignment",
    entityId: fromCode,
    affectedEmployeeCode: fromCode,
    responsibilityCategory: RESPONSIBILITY_CATEGORIES.WORKFLOW_TASK,
    oldAssigneeOrOwner: fromCode,
    newAssigneeOrOwner: toCode,
    sourceOperation: "bulk_workflow_reassign",
    reason: payload.reason,
    metadata: { task_count: tasks.length }
  });

  return { reassigned_count: tasks.length };
}

async function buildSessionWorkspacePayload(pool, employeeCode, userRow) {
  const workAssignmentService = require("./workAssignmentService");
  const workspaceResolverService = require("./workspaceResolverService");
  const hiringManagerIdentityService = require("./hiringManagerIdentityService");

  let workAssignments = [];
  let workAssignmentStatus = "NO_ASSIGNMENTS";
  let workspace = {};

  try {
    const employeeAssignments = await workAssignmentService.getEmployeeWorkAssignments(
      pool,
      employeeCode
    );
    workAssignments = (employeeAssignments || [])
      .filter((row) => row.is_active === true)
      .map((row) => ({
        assignment_code: row.assignment_code,
        assignment_name: row.assignment_name
      }));
    workAssignmentStatus =
      workAssignments.length > 0 ? "LOADED" : "NO_ASSIGNMENTS";
  } catch (_error) {
    workAssignments = [];
    workAssignmentStatus = "SERVICE_UNAVAILABLE";
  }

  try {
    const resolved = await workspaceResolverService.resolveWorkspace(pool, employeeCode);
    workspace = resolved?.workspace || {};
  } catch (_error) {
    workspace = {};
  }

  try {
    await hiringManagerIdentityService.resolveBoundHiringManager(pool, {
      user: {
        employee_code: employeeCode,
        email_id: userRow?.email_id
      }
    });
    workspace = { ...workspace, showHiringManagerWorkspace: true };
  } catch (_hmError) {
    // HM binding optional
  }

  if (userRow?.role_name === "TA Lead" || userRow?.role_name === "TA Leader") {
    workspace = { ...workspace, showTaLeadWorkspace: true };
  }

  return {
    work_assignments: workAssignments,
    work_assignment_status: workAssignmentStatus,
    workspace
  };
}

module.exports = {
  REQUIRED_ACTIONS,
  RESPONSIBILITY_CATEGORIES,
  buildResponsibilityPreflight,
  listOrganizationClearanceQueue,
  deactivateEmployee,
  applyResponsibilityResolutions,
  applyResolution,
  bulkReplaceRecruiter,
  bulkReassignWorkflowTasks,
  suspendActiveWorkAssignments,
  buildSessionWorkspacePayload
};
