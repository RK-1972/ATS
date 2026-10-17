const applicationAuditReadService = require("../services/applicationAuditReadService");
const applicationScreenActivityService = require("../services/applicationScreenActivityService");
const { requireApplicationAuditWorkspace } = require("../services/applicationAuditCapabilityAuth");
const {
  touchSession,
  refreshStaleSessionStatesForHeartbeat
} = require("../services/applicationSessionService");

function handleError(res, error) {
  console.error("Application Audit API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerApplicationAuditRoutes(app, pool, verifyToken) {
  const workspaceGuard = [verifyToken, requireApplicationAuditWorkspace(pool)];

  app.get("/api/v1/application-audit/sessions", workspaceGuard, async (req, res) => {
    try {
      const data = await applicationAuditReadService.listSessions(pool, req.query);
      res.status(200).json({
        success: true,
        message: "Session history retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/application-audit/sessions/:sessionId", workspaceGuard, async (req, res) => {
    try {
      const data = await applicationAuditReadService.getSessionById(
        pool,
        req.params.sessionId
      );
      res.status(200).json({
        success: true,
        message: "Session detail retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/application-audit/screen-activity", workspaceGuard, async (req, res) => {
    try {
      const data = await applicationAuditReadService.listScreenActivity(pool, req.query);
      res.status(200).json({
        success: true,
        message: "Screen activity retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/application-audit/business-events", workspaceGuard, async (req, res) => {
    try {
      const data = await applicationAuditReadService.listBusinessAudit(pool, req.query);
      res.status(200).json({
        success: true,
        message: "Business audit events retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/application-audit/screen-activity/batch", verifyToken, async (req, res) => {
    try {
      const events = Array.isArray(req.body?.events) ? req.body.events : req.body;
      const data = await applicationScreenActivityService.ingestBatch(pool, req, events);

      if (req.user?.session_id) {
        try {
          await touchSession(pool, req.user.session_id);
        } catch (touchError) {
          console.error("[screen-activity] session touch failed", touchError.message);
        }
      }

      res.status(200).json({
        success: true,
        message: "Screen activity recorded.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/application-audit/sessions/heartbeat", verifyToken, async (req, res) => {
    try {
      await refreshStaleSessionStatesForHeartbeat(pool);

      const sessionId = req.user?.session_id;
      if (!sessionId) {
        return res.status(200).json({
          success: true,
          message: "No session identifier on token.",
          data: { updated: false }
        });
      }

      const data = await touchSession(pool, sessionId);
      res.status(200).json({
        success: true,
        message: "Session heartbeat recorded.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerApplicationAuditRoutes };
