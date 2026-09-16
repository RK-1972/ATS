const taLeadOperationsService = require("../services/taLeadOperationsService");
const { requireTaLeadWorkspace } = require("../services/requisitionCapabilityAuth");

function handleError(res, error) {
  console.error("TA Lead API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerTaLeadRoutes(app, pool, verifyToken) {
  const guard = [verifyToken, requireTaLeadWorkspace(pool)];

  app.get("/api/v1/ta-lead/operations-summary", guard, async (req, res) => {
    try {
      const data = await taLeadOperationsService.buildOperationsSummary(pool, req);
      res.json({
        success: true,
        message: "TA Lead operations summary retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/ta-lead/attention-queues", guard, async (req, res) => {
    try {
      const data = await taLeadOperationsService.getAttentionQueues(pool, req);
      res.json({
        success: true,
        message: "TA Lead attention queues retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/ta-lead/recruiters/:recruiterCode/summary", guard, async (req, res) => {
    try {
      const data = await taLeadOperationsService.getRecruiterOversightSummary(
        pool,
        req,
        req.params.recruiterCode
      );
      res.json({
        success: true,
        message: "Recruiter oversight summary retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerTaLeadRoutes };
