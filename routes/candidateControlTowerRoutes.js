const {
  searchApplications,
  getSummaryMetrics,
  getApplicationDetail
} = require("../services/candidateControlTowerService");
const {
  requireCandidateControlTowerWorkspace
} = require("../services/candidateControlTowerCapabilityAuth");

function handleError(res, error) {
  console.error("Candidate Control Tower API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerCandidateControlTowerRoutes(app, pool, verifyToken) {
  const guard = [verifyToken, requireCandidateControlTowerWorkspace(pool)];

  app.get("/api/v1/candidate-control-tower/summary", guard, async (req, res) => {
    try {
      const data = await getSummaryMetrics(pool, req);

      res.status(200).json({
        success: true,
        message: "Candidate Control Tower summary loaded.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/candidate-control-tower/applications", guard, async (req, res) => {
    try {
      const data = await searchApplications(pool, req, req.query || {});

      res.status(200).json({
        success: true,
        message: "Candidate applications retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/candidate-control-tower/applications/:mappingId",
    guard,
    async (req, res) => {
      try {
        const data = await getApplicationDetail(pool, req, req.params.mappingId);

        res.status(200).json({
          success: true,
          message: "Application detail loaded.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );
}

module.exports = {
  registerCandidateControlTowerRoutes
};
