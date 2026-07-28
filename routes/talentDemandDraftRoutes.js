const talentDemandDraftService = require("../services/talentDemandDraftService");
const talentDemandSubmitService = require("../services/talentDemandSubmitService");
const {
  requireRequisitionRequestor
} = require("../services/requisitionCapabilityAuth");

function handleError(res, error) {
  console.error("Talent Demand Draft API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerTalentDemandDraftRoutes(app, pool, verifyToken) {
  const requestorGuard = [verifyToken, requireRequisitionRequestor(pool)];

  // POST /api/v1/talent-demand/drafts — Create Draft
  app.post("/api/v1/talent-demand/drafts", requestorGuard, async (req, res) => {
    try {
      const draft = await talentDemandDraftService.createDraft(
        pool,
        req.body || {},
        req.user
      );

      res.status(201).json({
        success: true,
        message: "Draft created successfully.",
        data: draft
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /api/v1/talent-demand/drafts — List My Drafts
  app.get("/api/v1/talent-demand/drafts", requestorGuard, async (req, res) => {
    try {
      const drafts = await talentDemandDraftService.listMyDrafts(pool, req.user);

      res.status(200).json({
        success: true,
        message: "Drafts retrieved successfully.",
        data: drafts
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /api/v1/talent-demand/drafts/:draftId/submit — Submit Draft
  app.post(
    "/api/v1/talent-demand/drafts/:draftId/submit",
    requestorGuard,
    async (req, res) => {
      try {
        const { draftId } = req.params;
        const employeeCode = req.user?.employee_code;
        const rowVersion =
          req.body?.rowVersion ?? req.body?.row_version ?? null;

        const result = await talentDemandSubmitService.submitDraft(
          pool,
          draftId,
          employeeCode,
          rowVersion,
          req
        );

        res.status(200).json({
          success: true,
          message:
            result.toastMessage || "Draft submitted successfully.",
          data: result
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  // GET /api/v1/talent-demand/drafts/:draftId — Load Draft
  app.get(
    "/api/v1/talent-demand/drafts/:draftId",
    requestorGuard,
    async (req, res) => {
      try {
        const draft = await talentDemandDraftService.getDraft(
          pool,
          req.params.draftId,
          req.user
        );

        res.status(200).json({
          success: true,
          message: "Draft retrieved successfully.",
          data: draft
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  // PUT /api/v1/talent-demand/drafts/:draftId — Update Draft
  app.put(
    "/api/v1/talent-demand/drafts/:draftId",
    requestorGuard,
    async (req, res) => {
      try {
        const draft = await talentDemandDraftService.updateDraft(
          pool,
          req.params.draftId,
          req.body || {},
          req.user
        );

        res.status(200).json({
          success: true,
          message: "Draft updated successfully.",
          data: draft
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  // DELETE /api/v1/talent-demand/drafts/:draftId — Soft Delete Draft
  app.delete(
    "/api/v1/talent-demand/drafts/:draftId",
    requestorGuard,
    async (req, res) => {
      try {
        const draft = await talentDemandDraftService.deleteDraft(
          pool,
          req.params.draftId,
          req.user
        );

        res.status(200).json({
          success: true,
          message: "Draft deleted successfully.",
          data: draft
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );
}
module.exports = { registerTalentDemandDraftRoutes };
