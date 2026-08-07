const offerLetterService = require("../services/offerLetterService");

function handleError(res, error) {
  const status = error.status || 500;

  if (status >= 500) {
    console.error("Offer Letter API Error:", error.message);
  }

  res.status(status).json({
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

function registerOfferLetterRoutes(app, pool, verifyToken) {
  const authorize = verifyTokenOrQuery(verifyToken);

  app.get("/api/v1/offer-letters/pending", verifyToken, async (req, res) => {
    try {
      const data = await offerLetterService.getPendingLetters(pool);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/offer-letters/generated", verifyToken, async (req, res) => {
    try {
      const data = await offerLetterService.getGeneratedLetters(pool);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/offer-letters/:id/pdf", authorize, async (req, res) => {
    try {
      const pdf = await offerLetterService.getGeneratedOfferLetterPdf(
        pool,
        req.params.id
      );
      const disposition =
        req.query.download === "1" ? "attachment" : "inline";
      const safeFileName = pdf.fileName.replace(/"/g, "");

      res.setHeader("Content-Type", pdf.contentType);
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${safeFileName}"`
      );
      res.setHeader("Content-Length", pdf.buffer.length);
      res.setHeader("Cache-Control", "private, no-store");

      return res.status(200).send(pdf.buffer);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/offer-letters/:id", verifyToken, async (req, res) => {
    try {
      const data = await offerLetterService.getOfferLetterDetail(
        pool,
        req.params.id
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/offer-letters/:id/generate", verifyToken, async (req, res) => {
    try {
      const data = await offerLetterService.generateOfferLetter(
        pool,
        req.params.id,
        req.body,
        req
      );
      res.status(201).json({
        success: true,
        message: "Offer letter generated successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerOfferLetterRoutes };
