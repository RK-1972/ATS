const interviewService = require("../services/interviewService");
const interviewFeedbackConfidentialityService = require("../services/interviewFeedbackConfidentialityService");

function handleError(res, error) {
  console.error("Interview API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error",
    guardCode: error.guardCode || null,
    guard: error.guard || null,
    requiresRepeatConfirmation: error.requiresRepeatConfirmation || false,
    requiresRepeatReason: error.requiresRepeatReason || false,
    requiresRepeatOverride: error.requiresRepeatOverride || false,
    unauthorizedOverride: error.unauthorizedOverride || false
  });
}

function registerInterviewRoutes(app, pool, verifyToken, scheduleIntegrations = {}) {
  app.get("/api/v1/interviews", verifyToken, async (req, res) => {
    try {
      const bundle = await interviewService.getInterviewBundle(pool, req);
      const sanitized =
        await interviewFeedbackConfidentialityService.sanitizeInterviewBundleForCaller(
          pool,
          req,
          bundle
        );
      res.json(sanitized);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/interviews/schedule-precheck", verifyToken, async (req, res) => {
    try {
      const mapId = req.query.map_id || req.query.mapId;
      const roundType = req.query.round_type || req.query.roundType;

      const data = await interviewService.getRepeatSchedulePrecheck(
        pool,
        mapId,
        roundType,
        req
      );

      res.json({
        success: true,
        message: "Repeat schedule precheck loaded.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/interviews/recruiter-scheduled-feedback", verifyToken, async (req, res) => {
    try {
      const data = await interviewService.listRecruiterScheduledFeedbackHistory(
        pool,
        req
      );

      res.json({
        success: true,
        message: "Recruiter scheduled feedback history loaded.",
        count: data.length,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/interviews/permitted-feedback/:mapId",
    verifyToken,
    async (req, res) => {
      try {
        const data = await interviewService.getPermittedFeedbackHistoryForMap(
          pool,
          req.params.mapId,
          req,
          {
            anchorScheduleId:
              req.query.anchor_schedule_id || req.query.anchorScheduleId || null
          }
        );

        res.json({
          success: true,
          message: "Permitted feedback history loaded.",
          count: data.length,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/interviews/feedback-summaries/:mapId",
    verifyToken,
    async (req, res) => {
      try {
        const data = await interviewService.listInterviewFeedbackSummariesForMap(
          pool,
          req.params.mapId,
          req
        );

        res.json({
          success: true,
          message: "Interview feedback summaries loaded.",
          count: data.length,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/api/v1/interviews/progress/:mapId", verifyToken, async (req, res) => {
    try {
      const data = await interviewService.getInterviewProgressByMapId(
        pool,
        req.params.mapId,
        req
      );
      res.json({
        success: true,
        message: "Interview progress loaded.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/interviews/:id", verifyToken, async (req, res) => {
    try {
      const interview = await interviewService.getInterviewForRequest(
        pool,
        req.params.id,
        req
      );
      res.json({ success: true, data: interview });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/schedule", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.scheduleInterviewCanonical(
        pool,
        req.body,
        req,
        scheduleIntegrations
      );

      if (result.legacyScheduleRow) {
        return res.status(201).json({
          success: true,
          message: result.toastMessage,
          data: {
            ...result.legacyScheduleRow,
            teams_link: result.teamsLink,
            interview_id: result.interviewId,
            interview: result.interview,
            workflowInstanceId: result.workflowInstanceId
          }
        });
      }

      res.status(201).json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/accept", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.acceptAssignment(pool, req.params.id, req);
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/reschedule", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.rescheduleInterview(pool, req.params.id, req.body, req);
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/cancel", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.cancelInterview(pool, req.params.id, req.body, req);
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/complete", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.completeInterview(
        pool,
        req.params.id,
        req,
        req.body?.comment || ""
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/feedback", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.submitFeedback(
        pool,
        { ...req.body, interview_id: req.params.id },
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/panel", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.assignPanel(
        pool,
        req.params.id,
        req.body.panel_members || req.body.panelMembers || [],
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/:id/reassign-panel", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.reassignPanel(pool, req.params.id, req.body, req);
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerInterviewRoutes };
