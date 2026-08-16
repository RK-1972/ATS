const hiringControlTowerService = require("../services/hiringControlTowerService");

function handleError(res, error) {
  console.error("Hiring Control Tower API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerHiringControlTowerRoutes(app, pool, verifyToken, verifyAdmin) {
  const adminGuard = [verifyToken, verifyAdmin];

  app.get("/api/v1/hiring-control-tower/kpis", adminGuard, async (req, res) => {
    try {
      const data = await hiringControlTowerService.getExecutiveKpis(pool);
      res.json({
        success: true,
        message: "Executive KPIs retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/hiring-control-tower/requisitions", adminGuard, async (req, res) => {
    try {
      const data = await hiringControlTowerService.searchRequisitions(pool, req.query);
      res.json({
        success: true,
        message: "Requisitions retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/hiring-control-tower/requisitions/:code/lifecycle", adminGuard, async (req, res) => {
    try {
      const data = await hiringControlTowerService.getRequisitionLifecycle(
        pool,
        req.params.code
      );
      res.json({
        success: true,
        message: "Hiring lifecycle retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/hiring-control-tower/requisitions/:code/stage-inspector/:milestoneKey", adminGuard, async (req, res) => {
    try {
      const data = await hiringControlTowerService.getStageInspector(
        pool,
        req.params.code,
        req.params.milestoneKey
      );
      res.json({
        success: true,
        message: "Stage inspector retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/hiring-control-tower/requisitions/:code", adminGuard, async (req, res) => {
    try {
      const data = await hiringControlTowerService.getRequisitionHeader(
        pool,
        req.params.code
      );
      res.json({
        success: true,
        message: "Requisition header retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerHiringControlTowerRoutes };
