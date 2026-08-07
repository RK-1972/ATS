const documentMergeService = require("../services/documentMergeService");

function handleError(res, error) {
  console.error("Document API Error:", error.message);
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

function registerDocumentRoutes(app, pool, verifyToken) {
  const authorize = verifyTokenOrQuery(verifyToken);

  app.post("/api/v1/documents/generate", verifyToken, async (req, res) => {
    try {
      const data = await documentMergeService.generateDocument(pool, req.body, req);
      res.status(201).json({
        success: true,
        message: data.responseMessage || "Document generated successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/documents/offer/:offerId/download",
    authorize,
    async (req, res) => {
      try {
        const file = await documentMergeService.downloadGeneratedDocumentForOffer(
          pool,
          req.params.offerId
        );
        const disposition =
          req.query.download === "1" ? "attachment" : "inline";
        const safeFileName = String(file.fileName || "offer.pdf").replace(
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

  app.get("/api/v1/documents/:id/download", authorize, async (req, res) => {
    try {
      const file = await documentMergeService.downloadGeneratedDocument(
        pool,
        req.params.id
      );
      const disposition =
        req.query.download === "1" ? "attachment" : "inline";
      const safeFileName = String(file.fileName || "document.docx").replace(
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
  });
}

module.exports = { registerDocumentRoutes };
