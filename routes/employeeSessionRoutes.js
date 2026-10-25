const {
  recordUserActivity,
  recordUserActivityThrottled,
  getEmployeeIdleStatus,
  completeIdleTimeoutTermination,
  EMPLOYEE_IDLE_TIMEOUT_MS,
  EMPLOYEE_IDLE_WARNING_LEAD_MS
} = require("../services/applicationSessionService");

const SESSION_INVALID_CODE = "SESSION_INVALID";
const SESSION_INVALID_MESSAGE =
  "Your session is no longer active. Sign in again.";

function handleError(res, error) {
  console.error("[employee-session]", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerEmployeeSessionRoutes(app, pool, verifyToken) {
  app.get("/api/v1/auth/session/idle-status", verifyToken, async (req, res) => {
    try {
      const sessionId = req.user?.session_id;
      const data = await getEmployeeIdleStatus(pool, sessionId);
      res.status(200).json({
        success: true,
        message: "Idle status retrieved.",
        data: {
          ...data,
          idle_timeout_ms: EMPLOYEE_IDLE_TIMEOUT_MS,
          warning_lead_ms: EMPLOYEE_IDLE_WARNING_LEAD_MS
        }
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/auth/session/activity", verifyToken, async (req, res) => {
    try {
      const sessionId = req.user?.session_id;
      const activity = await recordUserActivityThrottled(pool, sessionId);
      if (!activity.updated && !activity.throttled) {
        return res.status(401).json({
          success: false,
          code: SESSION_INVALID_CODE,
          message: SESSION_INVALID_MESSAGE
        });
      }

      const status =
        activity.status || (await getEmployeeIdleStatus(pool, sessionId));

      res.status(200).json({
        success: true,
        message: activity.throttled
          ? "Activity accepted (throttled)."
          : "Activity recorded.",
        data: {
          ...status,
          throttled: Boolean(activity.throttled)
        }
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/auth/session/stay-logged-in", verifyToken, async (req, res) => {
    try {
      const sessionId = req.user?.session_id;
      const activity = await recordUserActivity(pool, sessionId);
      if (!activity.updated) {
        return res.status(401).json({
          success: false,
          code: SESSION_INVALID_CODE,
          message: SESSION_INVALID_MESSAGE
        });
      }

      const status = await getEmployeeIdleStatus(pool, sessionId);
      res.status(200).json({
        success: true,
        message: "Session extended.",
        data: status
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/auth/session/idle-timeout", verifyToken, async (req, res) => {
    try {
      const sessionId = req.user?.session_id;
      const outcome = await completeIdleTimeoutTermination(pool, sessionId);

      if (!outcome.ok) {
        if (outcome.code === "NOT_DUE") {
          return res.status(409).json({
            success: false,
            code: "IDLE_TIMEOUT_NOT_DUE",
            message: "Session idle deadline has not elapsed yet."
          });
        }

        return res.status(401).json({
          success: false,
          code: SESSION_INVALID_CODE,
          message: SESSION_INVALID_MESSAGE
        });
      }

      res.status(200).json({
        success: true,
        message: "Session ended due to inactivity.",
        data: {
          terminated: Boolean(outcome.terminated),
          already_terminated: Boolean(outcome.alreadyTerminated)
        }
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerEmployeeSessionRoutes };
