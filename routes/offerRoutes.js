const offerManagementService = require("../services/offerManagementService");
const { requireOfferWorkspace } = require("../services/offerCapabilityAuth");

function handleError(res, error) {
  console.error("Offer API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerOfferRoutes(app, pool, verifyToken) {
  const offerGuard = [verifyToken, requireOfferWorkspace(pool)];

  app.get("/api/v1/offers", offerGuard, async (req, res) => {
    try {
      const bundle = await offerManagementService.getOfferBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/offers/:offerId", offerGuard, async (req, res) => {
    try {
      const offer = await offerManagementService.getOffer(pool, req.params.offerId);
      res.json({ success: true, data: offer });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.createOffer(pool, req.body, req);
      res.status(201).json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/submit", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.submitOffer(
        pool,
        req.params.offerId,
        req.body?.comment || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/approve", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.approveOffer(
        pool,
        req.params.offerId,
        req.body.approval_step || req.body.approvalStep,
        req.body?.comment || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/negotiate", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.negotiateOffer(
        pool,
        req.params.offerId,
        req.body,
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/revise", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.reviseOffer(
        pool,
        req.params.offerId,
        req.body,
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/release", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.releaseOffer(
        pool,
        req.params.offerId,
        req.body,
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/accept", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.acceptOffer(pool, req.params.offerId, req);
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/reject", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.rejectOffer(
        pool,
        req.params.offerId,
        req.body?.reason || req.body?.comment || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/withdraw", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.withdrawOffer(
        pool,
        req.params.offerId,
        req.body?.reason || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/request-clarification", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.requestClarification(
        pool,
        req.params.offerId,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offers/:offerId/submit-clarification", offerGuard, async (req, res) => {
    try {
      const result = await offerManagementService.submitClarification(
        pool,
        req.params.offerId,
        req.body?.comments || req.body?.comment || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerOfferRoutes };
