const platformConfigService = require("../services/platformConfigService");

function handleError(res, error) {
  console.error("Platform Config API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerPlatformConfigRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/platform-config", guard, async (req, res) => {
    try {
      const bundle = await platformConfigService.getConfigBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/platform-config/export", guard, async (req, res) => {
    try {
      const exported = await platformConfigService.exportConfiguration(pool);
      res.json(exported);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/platform-config/snapshots", guard, async (req, res) => {
    try {
      const snapshots = await platformConfigService.listSnapshots(pool);
      res.json(snapshots);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/platform-config/validate", guard, async (req, res) => {
    try {
      const payload = req.body?.payload || req.body;
      const result = platformConfigService.validateConfiguration(payload);
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.patch("/api/v1/platform-config/draft", guard, async (req, res) => {
    try {
      const bundle = await platformConfigService.applyDraftMutation(pool, req, req.body);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/api/v1/platform-config/draft", guard, async (req, res) => {
    try {
      const bundle = await platformConfigService.applyDraftMutation(pool, req, {
        action: "replaceDraft",
        payload: req.body
      });
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/platform-config/publish", guard, async (req, res) => {
    try {
      const bundle = await platformConfigService.publishConfiguration(
        pool,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/platform-config/discard", guard, async (req, res) => {
    try {
      const bundle = await platformConfigService.discardDraft(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/platform-config/archive", guard, async (req, res) => {
    try {
      const bundle = await platformConfigService.archiveConfiguration(
        pool,
        req,
        req.body?.reason || ""
      );
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/platform-config/restore/:snapshotId", guard, async (req, res) => {
    try {
      const snapshotId = Number(req.params.snapshotId);
      const bundle = await platformConfigService.restoreSnapshot(
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

  app.post("/api/v1/platform-config/import/preview", guard, async (req, res) => {
    try {
      const payload = req.body?.payload || req.body;
      const preview = await platformConfigService.previewImport(pool, payload);
      res.json(preview);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/platform-config/import", guard, async (req, res) => {
    try {
      const payload = req.body?.payload || req.body;
      const result = await platformConfigService.commitImport(
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
}

module.exports = { registerPlatformConfigRoutes };
