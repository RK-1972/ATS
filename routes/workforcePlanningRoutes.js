const workforcePlanningService = require("../services/workforcePlanningService");

function handleError(res, error) {
  console.error("Workforce Planning API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerWorkforcePlanningRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/workforce", guard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.getWorkforceBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/export", guard, async (req, res) => {
    try {
      const exported = await workforcePlanningService.exportWorkforce(pool);
      res.json(exported);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/publish", guard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.publishBundle(
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

  app.post("/api/v1/workforce/discard", guard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.discardDraft(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/import/preview", guard, async (req, res) => {
    try {
      const preview = await workforcePlanningService.previewImport(
        pool,
        req.body?.payload || req.body
      );
      res.json(preview);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/import", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.commitImport(
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

  app.get("/api/v1/workforce/budget-requests/:id", guard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.getWorkforceBundle(pool);
      const request = bundle.config.approval_queue.find(
        (item) => item.id === req.params.id
      );

      if (!request) {
        return res.status(404).json({ message: "Budget request not found" });
      }

      res.json(request);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/budget-requests/:id/approve", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.approveBudgetRequest(
        pool,
        req.params.id,
        req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/budget-requests/:id/reject", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.rejectBudgetRequest(
        pool,
        req.params.id,
        req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/budget-requests/:id/send-back", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.sendBackBudgetRequest(
        pool,
        req.params.id,
        req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/budget-requests/:id/request-clarification", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.requestBudgetClarification(
        pool,
        req.params.id,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/budget-requests/:id/submit-clarification", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.submitBudgetClarification(
        pool,
        req.params.id,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/approved-positions/:id/requisitions", guard, async (req, res) => {
    try {
      const result = await workforcePlanningService.createRequisition(
        pool,
        req.params.id,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/:id", guard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.getWorkforceBundle(pool);
      const request = bundle.config.approval_queue.find(
        (item) => item.id === req.params.id
      );

      if (!request) {
        return res.status(404).json({ message: "Not found" });
      }

      res.json(request);
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerWorkforcePlanningRoutes };
