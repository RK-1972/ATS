const taskService = require("../services/taskService");

function handleError(res, error) {
  console.error("Task API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerTaskRoutes(app, pool, verifyToken) {
  app.get("/api/v1/tasks", verifyToken, async (req, res) => {
    try {
      const bundle = await taskService.getTaskBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/tasks/inbox", verifyToken, async (req, res) => {
    try {
      const tasks = await taskService.listInbox(pool, {
        module: req.query.module,
        status: req.query.status,
        limit: Number(req.query.limit) || 200
      });
      res.json({ success: true, data: tasks });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/tasks/my", verifyToken, async (req, res) => {
    try {
      const tasks = await taskService.listMyTasks(pool, req);
      res.json({ success: true, data: tasks });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/tasks/:taskId", verifyToken, async (req, res) => {
    try {
      const task = await taskService.getTask(pool, req.params.taskId);
      res.json({ success: true, data: task });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/tasks/:taskId/complete", verifyToken, async (req, res) => {
    try {
      const task = await taskService.completeTask(
        pool,
        req.params.taskId,
        req,
        req.body?.comment || ""
      );
      res.json({ success: true, data: task });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/tasks/:taskId/reassign", verifyToken, async (req, res) => {
    try {
      const task = await taskService.reassignTask(
        pool,
        req.params.taskId,
        req.body.assignee,
        req,
        req.body.assignee_role || req.body.assigneeRole || null
      );
      res.json({ success: true, data: task });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/tasks/:taskId/escalate", verifyToken, async (req, res) => {
    try {
      const task = await taskService.escalateTask(
        pool,
        req.params.taskId,
        req.body.escalate_to || req.body.escalateTo,
        req,
        req.body.reason || ""
      );
      res.json({ success: true, data: task });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerTaskRoutes };
