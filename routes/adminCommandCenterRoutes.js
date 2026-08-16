const adminCommandCenterService = require("../services/adminCommandCenterService");

function handleError(res, error) {
  console.error("Admin Command Center API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerAdminCommandCenterRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];

  app.get("/api/v1/admin/command-center", guard, async (req, res) => {
    try {
      const data = await adminCommandCenterService.buildAdminCommandCenterSnapshot(pool);
      res.status(200).json({
        success: true,
        message: "Admin command center snapshot retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerAdminCommandCenterRoutes };
