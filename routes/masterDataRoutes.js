const masterDataService = require("../services/masterDataService");

function handleError(res, error) {
  console.error("Master Data API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerMasterDataRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/master", guard, async (req, res) => {
    try {
      const data = await masterDataService.buildMasterDataBundle(pool);
      res.json(data);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/master/:entityType/export", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const records = await masterDataService.exportEntity(pool, entityType);
      res.json(records);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/import/preview", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const preview = await masterDataService.previewImport(pool, entityType, rows);
      res.json(preview);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/import", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const result = await masterDataService.commitImport(
        pool,
        entityType,
        rows,
        req,
        req.body?.reason || ""
      );
      const masterData = await masterDataService.buildMasterDataBundle(pool);
      res.json({ ...result, masterData });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/master/:entityType", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const records = await masterDataService.listByEntityType(pool, entityType);
      res.json(records);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/master/:entityType/:id", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = await masterDataService.getRecordById(
        pool,
        entityType,
        req.params.id
      );

      if (!record) {
        return res.status(404).json({ message: "Record not found" });
      }

      res.json(record);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = await masterDataService.createRecord(
        pool,
        entityType,
        req.body,
        req
      );
      res.status(201).json(record);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/api/v1/master/:entityType/:id", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = await masterDataService.updateRecord(
        pool,
        entityType,
        req.params.id,
        req.body,
        req
      );
      res.json(record);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/:id/publish", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = await masterDataService.publishRecord(
        pool,
        entityType,
        req.params.id,
        req.body || {},
        req
      );
      res.json(record);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/:id/archive", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = await masterDataService.archiveRecord(
        pool,
        entityType,
        req.params.id,
        req.body || {},
        req
      );
      res.json(record);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/:id/rollback", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = await masterDataService.rollbackRecord(
        pool,
        entityType,
        req.params.id,
        req.body || {},
        req
      );
      res.json(record);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.delete("/api/v1/master/:entityType/:id", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const result = await masterDataService.deleteRecord(
        pool,
        entityType,
        req.params.id,
        req
      );
      res.json(result);
    } catch (error) {
      handleError(res, error);
    }
  });

  console.log("✅ Master Data API routes registered (/api/v1/master)");
}

module.exports = { registerMasterDataRoutes };
