const enterpriseAuditReadService = require("../services/enterpriseAuditReadService");

function handleError(res, error) {
  console.error("Audit API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerAuditRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/audit", guard, async (req, res) => {
    try {
      const data = await enterpriseAuditReadService.listAudits(pool, req.query);
      res.status(200).json({
        success: true,
        message: "Audit events retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerAuditRoutes };
