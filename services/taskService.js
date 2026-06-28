const workflowService = require("./workflowService");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function recordTaskHistory(pool, taskId, eventType, actor, actorRole, fromStatus, toStatus, comments, metadata) {
  await pool.query(
    `INSERT INTO et_task_history (
      task_id, event_type, from_status, to_status, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      taskId,
      eventType,
      fromStatus || null,
      toStatus || null,
      actor,
      actorRole || null,
      comments || null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );
}

function mapTaskRow(row) {
  return {
    taskId: row.task_id,
    module: row.module,
    taskType: row.task_type,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    assigneeRole: row.assignee_role,
    dueAt: row.due_at?.toISOString?.() || null,
    slaHours: row.sla_hours,
    escalated: row.escalated,
    escalatedTo: row.escalated_to,
    workflowInstanceId: row.workflow_instance_id,
    workflowTaskId: row.workflow_task_id,
    businessObjectType: row.business_object_type,
    businessObjectId: row.business_object_id,
    metadata: row.metadata || {},
    createdBy: row.created_by,
    createdOn: row.created_on?.toISOString?.() || null,
    completedOn: row.completed_on?.toISOString?.() || null
  };
}

async function createTask(pool, payload, req) {
  const user = userContext(req);
  const slaHours = payload.slaHours || 24;
  const dueAt = payload.dueAt ? new Date(payload.dueAt) : addHours(new Date(), slaHours);

  let workflowTaskId = null;

  if (payload.workflowInstanceId) {
    workflowTaskId = await workflowService.createTask(pool, payload.workflowInstanceId, {
      stageKey: payload.stageKey || payload.taskType,
      taskType: payload.taskType,
      title: payload.title,
      assignee: payload.assignee,
      assigneeRole: payload.assigneeRole,
      dueAt: dueAt.toISOString(),
      assignedBy: user.name
    });
  }

  const result = await pool.query(
    `INSERT INTO et_tasks (
      module, task_type, title, status, priority, assignee, assignee_role,
      due_at, sla_hours, workflow_instance_id, workflow_task_id,
      business_object_type, business_object_id, metadata, created_by, effective_from
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING *`,
    [
      payload.module,
      payload.taskType,
      payload.title,
      payload.status || "Pending",
      payload.priority || "Normal",
      payload.assignee || null,
      payload.assigneeRole || null,
      dueAt,
      slaHours,
      payload.workflowInstanceId || null,
      workflowTaskId,
      payload.businessObjectType || null,
      payload.businessObjectId || null,
      JSON.stringify(payload.metadata || {}),
      user.name,
      new Date()
    ]
  );

  const task = mapTaskRow(result.rows[0]);

  await recordTaskHistory(
    pool,
    task.taskId,
    "TaskCreated",
    user.name,
    user.role,
    null,
    task.status,
    payload.comments || null,
    payload.metadata
  );

  await writeEnterpriseAudit(pool, {
    eventType: "TaskCreated",
    module: payload.module || "Enterprise Task Inbox",
    entity: "Task",
    entityId: String(task.taskId),
    action: task.title,
    userName: user.name,
    userRole: user.role,
    metadata: {
      assignee: task.assignee,
      assigneeRole: task.assigneeRole,
      workflowInstanceId: task.workflowInstanceId,
      businessObjectType: task.businessObjectType,
      businessObjectId: task.businessObjectId
    }
  });

  return task;
}

async function listInbox(pool, filters = {}) {
  const conditions = ["status <> 'Completed'"];
  const values = [];
  let index = 1;

  if (filters.module) {
    conditions.push(`module = $${index++}`);
    values.push(filters.module);
  }

  if (filters.status) {
    conditions.push(`status = $${index++}`);
    values.push(filters.status);
  }

  const result = await pool.query(
    `SELECT * FROM et_tasks
     WHERE ${conditions.join(" AND ")}
     ORDER BY due_at ASC NULLS LAST, created_on DESC
     LIMIT ${filters.limit || 200}`,
    values
  );

  return result.rows.map(mapTaskRow);
}

async function listMyTasks(pool, req) {
  const user = userContext(req);
  const result = await pool.query(
    `SELECT * FROM et_tasks
     WHERE status <> 'Completed'
       AND (
         assignee = $1
         OR assignee_role = $2
         OR (assignee IS NULL AND assignee_role IS NULL)
       )
     ORDER BY
       CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END,
       due_at ASC NULLS LAST,
       created_on DESC`,
    [user.name, user.role]
  );

  return result.rows.map(mapTaskRow);
}

async function getTask(pool, taskId) {
  const result = await pool.query("SELECT * FROM et_tasks WHERE task_id = $1", [taskId]);

  if (!result.rows.length) {
    throw httpError(`Task not found: ${taskId}`, 404);
  }

  return mapTaskRow(result.rows[0]);
}

async function completeTask(pool, taskId, req, comments = "") {
  const user = userContext(req);
  const task = await getTask(pool, taskId);

  if (task.status === "Completed") {
    return task;
  }

  await pool.query(
    `UPDATE et_tasks
     SET status = 'Completed', completed_by = $1, completed_on = NOW(), modified_on = NOW()
     WHERE task_id = $2`,
    [user.name, taskId]
  );

  if (task.workflowTaskId) {
    await workflowService.completeTask(pool, task.workflowTaskId, req);
  }

  await recordTaskHistory(
    pool,
    taskId,
    "TaskCompleted",
    user.name,
    user.role,
    task.status,
    "Completed",
    comments
  );

  await writeEnterpriseAudit(pool, {
    eventType: "TaskCompleted",
    module: task.module,
    entity: "Task",
    entityId: String(taskId),
    action: `Task completed: ${task.title}`,
    previousValue: task.status,
    newValue: "Completed",
    userName: user.name,
    userRole: user.role,
    metadata: { comments }
  });

  return getTask(pool, taskId);
}

async function reassignTask(pool, taskId, assignee, req, assigneeRole = null) {
  const user = userContext(req);
  const task = await getTask(pool, taskId);

  await pool.query(
    `UPDATE et_tasks
     SET assignee = $1, assignee_role = $2, modified_on = NOW()
     WHERE task_id = $3`,
    [assignee, assigneeRole, taskId]
  );

  if (task.workflowTaskId) {
    await workflowService.reassignTask(pool, task.workflowTaskId, assignee, req, assigneeRole);
  }

  await recordTaskHistory(
    pool,
    taskId,
    "TaskReassigned",
    user.name,
    user.role,
    task.status,
    task.status,
    `Reassigned to ${assignee}`,
    { assignee, assigneeRole }
  );

  await writeEnterpriseAudit(pool, {
    eventType: "TaskReassigned",
    module: task.module,
    entity: "Task",
    entityId: String(taskId),
    action: `Task reassigned to ${assignee}`,
    userName: user.name,
    userRole: user.role
  });

  return getTask(pool, taskId);
}

async function escalateTask(pool, taskId, escalateTo, req, reason = "") {
  const user = userContext(req);
  const task = await getTask(pool, taskId);

  await pool.query(
    `UPDATE et_tasks
     SET escalated = TRUE, escalated_to = $1, escalated_on = NOW(),
         status = 'Escalated', priority = 'Urgent', modified_on = NOW()
     WHERE task_id = $2`,
    [escalateTo, taskId]
  );

  await recordTaskHistory(
    pool,
    taskId,
    "TaskEscalated",
    user.name,
    user.role,
    task.status,
    "Escalated",
    reason,
    { escalateTo }
  );

  await writeEnterpriseAudit(pool, {
    eventType: "TaskEscalated",
    module: task.module,
    entity: "Task",
    entityId: String(taskId),
    action: `Task escalated to ${escalateTo}`,
    userName: user.name,
    userRole: user.role,
    metadata: { reason, escalateTo }
  });

  return getTask(pool, taskId);
}

async function getTaskBundle(pool) {
  const tasks = await listInbox(pool);
  const summary = {
    pending: tasks.filter((item) => item.status === "Pending").length,
    escalated: tasks.filter((item) => item.escalated).length,
    overdue: tasks.filter((item) => item.dueAt && new Date(item.dueAt) < new Date()).length
  };

  return { tasks, summary };
}

module.exports = {
  createTask,
  listInbox,
  listMyTasks,
  getTask,
  completeTask,
  reassignTask,
  escalateTask,
  getTaskBundle,
  mapTaskRow
};
