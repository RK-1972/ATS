const interviewService = require("../services/interviewService");

function handleError(res, error) {
  console.error("Interview API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerInterviewRoutes(app, pool, verifyToken) {
  app.get("/api/v1/interviews", verifyToken, async (req, res) => {
    try {
      const bundle = await interviewService.getInterviewBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/interviews/:id", verifyToken, async (req, res) => {
    try {
      const interview = await interviewService.getInterview(pool, req.params.id);
      res.json({ success: true, data: interview });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/interviews/schedule", verifyToken, async (req, res) => {
    try {
      const result = await interviewService.scheduleInterview(pool, req.body, req);
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
