const masterDataService = require("../services/masterDataService");
const skillsMasterDataService = require("../services/skillsMasterDataService");

function isSkillsEntity(entityType) {
  return entityType === skillsMasterDataService.SKILLS_ENTITY;
}

function handleError(res, error) {
  console.error("Master Data API Error:", error.message);
  res.status(error.status || 500).json({
    message: error.message || "Internal server error"
  });
}

function registerMasterDataRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/master", verifyToken, async (req, res) => {
    try {
      const data = await masterDataService.buildMasterDataBundle(pool);

      // Admin owns EMD: full lifecycle bundle. Consumers: Active + Published only.
      if (req.user?.role_name === "Admin") {
        return res.json(data);
      }

      const publishedRecords = {};
      let publishedCount = 0;

      Object.entries(data.records || {}).forEach(([entityType, rows]) => {
        const filtered = (rows || []).filter(
          (record) =>
            record.status === "Active" &&
            record.versionStatus === "Published"
        );
        publishedRecords[entityType] = filtered;
        publishedCount += filtered.length;
      });

      res.json({
        ...data,
        records: publishedRecords,
        meta: {
          ...data.meta,
          total_records: publishedCount,
          published_records: publishedCount
        }
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/master/:entityType/export", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const records = isSkillsEntity(entityType)
        ? await skillsMasterDataService.exportSkills(pool)
        : await masterDataService.exportEntity(pool, entityType);
      res.json(records);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/import/preview", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const preview = isSkillsEntity(entityType)
        ? await skillsMasterDataService.previewSkillsImport(pool, rows)
        : await masterDataService.previewImport(pool, entityType, rows);
      res.json(preview);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/master/:entityType/import", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const result = isSkillsEntity(entityType)
        ? await skillsMasterDataService.commitSkillsImport(
          pool,
          rows,
          req,
          req.body?.reason || ""
        )
        : await masterDataService.commitImport(
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
      const records = isSkillsEntity(entityType)
        ? await skillsMasterDataService.listSkills(pool)
        : await masterDataService.listByEntityType(pool, entityType);
      res.json(records);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/master/:entityType/:id", guard, async (req, res) => {
    try {
      const entityType = masterDataService.resolveEntityType(req.params.entityType);
      const record = isSkillsEntity(entityType)
        ? await skillsMasterDataService.getSkillById(pool, req.params.id)
        : await masterDataService.getRecordById(
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
      const record = isSkillsEntity(entityType)
        ? await skillsMasterDataService.createSkill(pool, req.body, req)
        : await masterDataService.createRecord(
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
      const record = isSkillsEntity(entityType)
        ? await skillsMasterDataService.updateSkill(pool, req.params.id, req.body, req)
        : await masterDataService.updateRecord(
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
