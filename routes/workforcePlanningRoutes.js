const workforcePlanningService = require("../services/workforcePlanningService");
const {
  assertCanCreateRequisition
} = require("../services/requisitionCapabilityAuth");

function handleError(res, error) {
  console.error("Workforce Planning API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerWorkforcePlanningRoutes(app, pool, verifyToken, verifyAdmin) {
  const adminGuard = [verifyToken, verifyAdmin];
  const userGuard = [verifyToken];

  app.get("/api/v1/workforce", userGuard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.getWorkforceBundle(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/requisitions/detail/:code", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.getRequisitionInspectorDetail(
        pool,
        req.params.code,
        req
      );
      res.json({
        success: true,
        message: "Requisition inspector detail retrieved successfully.",
        data: result
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/requisitions/:code/action-context", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.getRequisitionApprovalActionContext(
        pool,
        req.params.code,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/requisitions/:code/submit-clarification", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.submitRequisitionClarification(
        pool,
        req.params.code,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json({
        success: true,
        message: result.toastMessage,
        data: result
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/requisitions/:queue", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.listWorkforceRequisitionQueue(
        pool,
        req.params.queue,
        req
      );
      res.json({
        success: true,
        message: "Workforce requisition queue retrieved successfully.",
        data: result.rows,
        meta: {
          queue: result.queue,
          status: result.status,
          count: result.rows.length
        }
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/export", adminGuard, async (req, res) => {
    try {
      const exported = await workforcePlanningService.exportWorkforce(pool);
      res.json(exported);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/publish", adminGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/discard", adminGuard, async (req, res) => {
    try {
      const bundle = await workforcePlanningService.discardDraft(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/import/preview", adminGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/import", adminGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/budget-requests", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.createBudgetRequest(
        pool,
        req.body || {},
        req
      );
      res.status(201).json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/budget-requests/:id/submit", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.submitBudgetRequest(
        pool,
        req.params.id,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/workforce/budget-requests/:id", userGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/budget-requests/:id/approve", userGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/budget-requests/:id/reject", userGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/budget-requests/:id/send-back", userGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/budget-requests/:id/request-clarification", userGuard, async (req, res) => {
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

  app.post("/api/v1/workforce/budget-requests/:id/submit-clarification", userGuard, async (req, res) => {
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

  app.get("/api/v1/workforce/budget-requests/:id/action-context", userGuard, async (req, res) => {
    try {
      const result = await workforcePlanningService.getBudgetApprovalActionContext(
        pool,
        req.params.id,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/workforce/approved-positions/:id/requisitions", userGuard, async (req, res) => {
    try {
      await assertCanCreateRequisition(pool, req);
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

  app.get("/api/v1/workforce/:id", adminGuard, async (req, res) => {
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
