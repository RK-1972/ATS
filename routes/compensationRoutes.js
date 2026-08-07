const compensationService = require("../services/compensationService");
const compensationCalculationService = require("../services/compensationCalculationService");

function handleError(res, error) {
  console.error("Compensation API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerCompensationRoutes(app, pool, verifyToken) {
  app.get("/api/v1/compensation-structures", verifyToken, async (req, res) => {
    try {
      const data = await compensationService.getActiveStructures(pool);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/compensation-structures/:id/components",
    verifyToken,
    async (req, res) => {
      try {
        const data = await compensationService.getStructureComponents(
          pool,
          req.params.id
        );
        res.json({ success: true, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post("/api/v1/compensation/calculate", verifyToken, async (req, res) => {
    try {
      const data = await compensationCalculationService.calculateOfferCompensation(
        pool,
        req.body,
        req
      );
      res.status(200).json({
        success: true,
        message: "Compensation calculated successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerCompensationRoutes };
