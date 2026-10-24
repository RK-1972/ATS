const sessionTakeoverService = require("../services/sessionTakeoverService");

function handleError(res, error) {
  const status = error.status || 500;
  if (status >= 500) {
    console.error("[session-takeover]", error.message);
  }

  res.status(status).json({
    success: false,
    code: error.code || undefined,
    message: error.message || "Internal server error"
  });
}

function registerSessionTakeoverRoutes(app, pool, verifyToken) {
  app.get("/api/v1/auth/session-takeover/inbox", verifyToken, async (req, res) => {
    try {
      const sessionId = req.user?.session_id;
      const pending = await sessionTakeoverService.getPendingInboxForSession(
        pool,
        sessionId
      );

      res.status(200).json({
        success: true,
        message: pending
          ? "Pending takeover request retrieved."
          : "No pending takeover request.",
        data: { pending }
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post(
    "/api/v1/auth/session-takeover/:requestId/decision",
    verifyToken,
    async (req, res) => {
      try {
        const decision = req.body?.decision;
        const data = await sessionTakeoverService.decideTakeover(
          pool,
          req.params.requestId,
          decision,
          req
        );

        const message =
          data.status === "DENIED"
            ? "Sign-in request denied. Your session remains active."
            : data.status === "APPROVED"
              ? "Sign-in request approved. Your session will end."
              : "Decision recorded.";

        res.status(200).json({
          success: true,
          message,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post("/api/v1/auth/session-takeover/poll", async (req, res) => {
    try {
      const pollToken = req.body?.poll_token || req.body?.pollToken;
      const data = await sessionTakeoverService.pollTakeoverStatus(pool, pollToken);

      res.status(200).json({
        success: true,
        message: data.message,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/auth/session-takeover/complete", async (req, res) => {
    try {
      const pollToken = req.body?.poll_token || req.body?.pollToken;
      const email_id = req.body?.email_id;
      const password = req.body?.password;

      if (!email_id || typeof password !== "string") {
        return res.status(400).json({
          success: false,
          message: "email_id, password, and poll_token are required."
        });
      }

      const userResult = await pool.query(
        `SELECT * FROM user_mstr WHERE email_id = $1`,
        [email_id]
      );

      if (!userResult.rows.length) {
        return res.status(401).json({
          success: false,
          message: "Invalid Email"
        });
      }

      const user = userResult.rows[0];
      const bcrypt = require("bcryptjs");

      if (!user.password_hash) {
        return res.status(401).json({
          success: false,
          message: "Invalid Password"
        });
      }

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({
          success: false,
          message: "Invalid Password"
        });
      }

      if (user.is_active === false) {
        return res.status(403).json({
          success: false,
          message: "Account is inactive. Contact your administrator."
        });
      }

      const completed = await sessionTakeoverService.completeTakeoverLogin(
        pool,
        pollToken,
        user,
        req
      );

      res.status(200).json(completed.body);
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerSessionTakeoverRoutes };
