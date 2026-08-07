const multer = require("multer");

const documentTemplateService = require("../services/documentTemplateService");
const documentTemplateCompiler = require("../services/documentTemplateCompiler");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function handleError(res, error) {
  console.error("Document Template API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function verifyTokenOrQuery(verifyToken) {
  return (req, res, next) => {
    if (!req.headers.authorization && req.query.token) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }

    return verifyToken(req, res, next);
  };
}

function registerDocumentTemplateRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];
  const authorize = verifyTokenOrQuery(verifyToken);

  app.get("/api/v1/document-templates", verifyToken, async (req, res) => {
    try {
      const data = await documentTemplateService.getTemplates(pool);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/document-templates/:id/download",
    authorize,
    async (req, res) => {
      try {
        const file = await documentTemplateService.downloadTemplateDocument(
          pool,
          req.params.id
        );
        const disposition =
          req.query.download === "1" ? "attachment" : "inline";
        const safeFileName = String(file.fileName || "template.docx").replace(
          /"/g,
          ""
        );

        res.setHeader("Content-Type", file.contentType);
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${safeFileName}"`
        );
        res.setHeader("Content-Length", file.buffer.length);
        res.setHeader("Cache-Control", "private, no-store");

        return res.status(200).send(file.buffer);
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/api/v1/document-templates/:id", verifyToken, async (req, res) => {
    try {
      const data = await documentTemplateService.getTemplateById(
        pool,
        req.params.id
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/document-templates", guard, async (req, res) => {
    try {
      const data = await documentTemplateService.createTemplate(
        pool,
        req.body,
        req
      );
      res.status(201).json({
        success: true,
        message: "Document template created.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post(
    "/api/v1/document-templates/:id/upload",
    guard,
    upload.single("document"),
    async (req, res) => {
      try {
        const data = await documentTemplateService.uploadTemplateDocument(
          pool,
          req.params.id,
          req.file,
          req
        );
        res.status(200).json({
          success: true,
          message: "Template document uploaded.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/document-templates/:id/compile",
    guard,
    async (req, res) => {
      try {
        const data = await documentTemplateCompiler.compileTemplate(
          pool,
          req.params.id
        );
        res.status(200).json({
          success: true,
          message: "Template compiled successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/document-templates/:id/placeholders",
    verifyToken,
    async (req, res) => {
      try {
        const data = await documentTemplateCompiler.getTemplatePlaceholders(
          pool,
          req.params.id
        );
        res.json({ success: true, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.put("/api/v1/document-templates/:id/activate", guard, async (req, res) => {
    try {
      const data = await documentTemplateService.activateTemplateVersion(
        pool,
        req.params.id,
        req
      );
      res.json({
        success: true,
        message: "Template version activated.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerDocumentTemplateRoutes };
