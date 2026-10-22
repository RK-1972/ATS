const compensationService = require("../services/compensationService");
const compensationCalculationService = require("../services/compensationCalculationService");
const compensationConfigService = require("../services/compensationConfigService");
const { requireOfferWorkspace } = require("../services/offerCapabilityAuth");

function handleError(res, error) {
  console.error("Compensation API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerCompensationRoutes(app, pool, verifyToken, verifyAdmin) {
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

  app.put(
    "/api/v1/compensation-structures/:structureId/components/:structureComponentId",
    verifyToken,
    verifyAdmin,
    async (req, res) => {
      try {
        const data = await compensationConfigService.updateStructureComponent(
          pool,
          req.params.structureId,
          req.params.structureComponentId,
          req.body,
          req
        );

        res.json({
          success: true,
          message: "Compensation component updated successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  const offerGuard = [verifyToken, requireOfferWorkspace(pool)];

  app.post("/api/v1/compensation/calculate", offerGuard, async (req, res) => {
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
