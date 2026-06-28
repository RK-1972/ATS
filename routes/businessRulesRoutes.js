const businessRulesService = require("../services/businessRulesService");

function handleError(res, error) {
  console.error("Business Rules API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerBusinessRulesRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/business-rules", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.getRulesBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/business-rules/export", guard, async (req, res) => {
    try {
      const exported = await businessRulesService.exportRules(pool);
      res.json(exported);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/business-rules/snapshots", guard, async (req, res) => {
    try {
      const snapshots = await businessRulesService.listSnapshots(pool);
      res.json(snapshots);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/business-rules/:id", guard, async (req, res) => {
    try {
      const rule = await businessRulesService.getRuleById(pool, req.params.id);

      if (!rule) {
        return res.status(404).json({ message: "Rule not found" });
      }

      res.json(rule);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/validate", guard, async (req, res) => {
    try {
      const payload = req.body?.payload || req.body;
      const result = businessRulesService.validateBundle(payload);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/execute", guard, async (req, res) => {
    try {
      const ruleCode = req.body?.ruleCode || req.body?.rule_code;
      const executionContext = req.body?.executionContext || req.body?.context || {};

      if (!ruleCode) {
        return res.status(400).json({ message: "ruleCode is required" });
      }

      const result = await businessRulesService.executeRule(
        pool,
        ruleCode,
        executionContext,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/simulate", guard, async (req, res) => {
    try {
      const executionContext =
        req.body?.executionContext ||
        req.body?.context ||
        req.body?.simulationInput ||
        req.body;

      const result = await businessRulesService.simulateRules(pool, executionContext, req);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/import/preview", guard, async (req, res) => {
    try {
      const payload = req.body?.payload || req.body;
      const preview = await businessRulesService.previewImport(pool, payload);
      res.json(preview);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/import", guard, async (req, res) => {
    try {
      const payload = req.body?.payload || req.body;
      const result = await businessRulesService.commitImport(
        pool,
        payload,
        req,
        req.body?.reason || ""
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/publish", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.publishBundle(
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

  app.post("/api/v1/business-rules/discard", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.discardDraft(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/restore/:snapshotId", guard, async (req, res) => {
    try {
      const snapshotId = Number(req.params.snapshotId);
      const bundle = await businessRulesService.restoreSnapshot(
        pool,
        snapshotId,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.createRule(pool, req.body, req);
      res.status(201).json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/api/v1/business-rules/:id", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.updateRule(
        pool,
        req.params.id,
        req.body,
        req
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/:id/publish", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.publishRule(
        pool,
        req.params.id,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/business-rules/:id/archive", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.archiveRule(
        pool,
        req.params.id,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.delete("/api/v1/business-rules/:id", guard, async (req, res) => {
    try {
      const bundle = await businessRulesService.deleteRule(pool, req.params.id, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerBusinessRulesRoutes };
