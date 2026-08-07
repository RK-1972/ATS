const placeholderService = require("../services/placeholderService");

function handleError(res, error) {
  console.error("Document Placeholder API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerPlaceholderRoutes(app, verifyToken) {
  app.get("/api/v1/document-placeholders", verifyToken, async (req, res) => {
    try {
      const data = await placeholderService.getDocumentPlaceholders();
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerPlaceholderRoutes };
