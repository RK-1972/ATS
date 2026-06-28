const workflowService = require("../services/workflowService");

function handleError(res, error) {
  console.error("Workflow API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerWorkflowRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/workflows", guard, async (req, res) => {
    try {
      const bundle = await workflowService.getWorkflowsBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workflows/export", guard, async (req, res) => {
    try {
      const exported = await workflowService.exportWorkflows(pool);
      res.json(exported);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/publish", guard, async (req, res) => {
    try {
      const bundle = await workflowService.publishBundle(
        pool,
        req.body?.payload || req.body,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/discard", guard, async (req, res) => {
    try {
      const bundle = await workflowService.discardDraft(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/import/preview", guard, async (req, res) => {
    try {
      const preview = await workflowService.previewImport(pool, req.body?.payload || req.body);
      res.json(preview);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/import", guard, async (req, res) => {
    try {
      const result = await workflowService.commitImport(
        pool,
        req.body?.payload || req.body,
        req,
        req.body?.reason || ""
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/restore/:snapshotId", guard, async (req, res) => {
    try {
      const bundle = await workflowService.restoreSnapshot(
        pool,
        Number(req.params.snapshotId),
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/start", guard, async (req, res) => {
    try {
      const workflowCode = req.body?.workflowCode || req.body?.workflow_code;
      const executionContext = req.body?.executionContext || req.body?.context || {};
      const instance = await workflowService.startWorkflow(pool, workflowCode, executionContext, req);
      res.status(201).json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/instances/:instanceId/advance", guard, async (req, res) => {
    try {
      const result = await workflowService.advanceWorkflow(
        pool,
        req.params.instanceId,
        req.body?.action || "advance",
        req.body?.executionContext || req.body?.context || req.body,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workflows/instances/:instanceId", guard, async (req, res) => {
    try {
      const instance = await workflowService.getInstanceById(pool, req.params.instanceId);

      if (!instance) {
        return res.status(404).json({ message: "Workflow instance not found" });
      }

      res.json(instance);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workflows/instances/:instanceId/tasks", guard, async (req, res) => {
    try {
      const tasks = await workflowService.getCurrentTasks(pool, req.params.instanceId);
      res.json(tasks);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/instances/:instanceId/request-clarification", guard, async (req, res) => {
    try {
      const result = await workflowService.requestClarification(
        pool,
        req.params.instanceId,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/instances/:instanceId/submit-clarification", guard, async (req, res) => {
    try {
      const result = await workflowService.submitClarification(
        pool,
        req.params.instanceId,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/tasks/:taskId/complete", guard, async (req, res) => {
    try {
      const result = await workflowService.completeTask(pool, Number(req.params.taskId), req);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/tasks/:taskId/reassign", guard, async (req, res) => {
    try {
      const result = await workflowService.reassignTask(
        pool,
        Number(req.params.taskId),
        req.body?.assignee,
        req,
        req.body?.assigneeRole || req.body?.assignee_role || null
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workflows/:workflowCode", guard, async (req, res) => {
    try {
      const bundle = await workflowService.getWorkflowsBundle(pool);
      const definition = (bundle.config.definitions || []).find(
        (item) =>
          item.workflow_code === req.params.workflowCode ||
          item.workflow_key === req.params.workflowCode
      );

      if (!definition) {
        return res.status(404).json({ message: "Workflow not found" });
      }

      res.json(definitionToResponse(definition));
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workflows/:workflowCode/archive", guard, async (req, res) => {
    try {
      const bundle = await workflowService.archiveWorkflow(
        pool,
        req.params.workflowCode,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });
}

function definitionToResponse(definition) {
  const stages = definition.stages || [];
  return {
    key: definition.workflow_key,
    title: definition.title,
    description: definition.description,
    enabled: definition.enabled !== false,
    steps: stages.length,
    approvals: stages.filter((stage) => stage.is_approval_stage).length,
    status: definition.status,
    version: definition.version,
    sla_hours: definition.sla_hours,
    stages: stages.map((stage) => stage.stage_name),
    approval_stages: stages.filter((stage) => stage.is_approval_stage).map((stage) => stage.stage_name)
  };
}

module.exports = { registerWorkflowRoutes };
