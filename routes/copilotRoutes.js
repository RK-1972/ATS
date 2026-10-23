const copilotSuggestionService = require("../services/copilotSuggestionService");

function handleError(res, error) {
  console.error("[copilot]", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Failed to load Copilot suggestions."
  });
}

function registerCopilotRoutes(app, pool, verifyToken) {
  app.get("/api/v1/copilot/suggestions", verifyToken, async (req, res) => {
    try {
      const data = await copilotSuggestionService.buildPersonalizedSuggestions(
        pool,
        req
      );

      res.status(200).json({
        success: true,
        message: "Copilot suggestions loaded.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerCopilotRoutes };
