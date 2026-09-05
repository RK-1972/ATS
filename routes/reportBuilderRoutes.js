const reportBuilderMetadataService = require("../services/reportBuilderMetadataService");
const reportBuilderQueryService = require("../services/reportBuilderQueryService");
const reportBuilderExportService = require("../services/reportBuilderExportService");
const standardReportService = require("../services/standardReportService");

function handleError(res, error) {
  console.error("Report Builder API Error:", error.message);

  if (error.status) {
    return res.status(error.status).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error"
  });
}

function registerReportBuilderRoutes(app, pool, verifyToken) {
  const guard = [verifyToken];

  app.get("/api/v1/reports/datasets", guard, async (req, res) => {
    try {
      const data = await reportBuilderMetadataService.listAuthorizedDatasets(
        pool,
        req
      );

      res.status(200).json({
        success: true,
        message: "Report datasets retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/reports/filter-options/recruiters", guard, async (req, res) => {
    try {
      const data = await reportBuilderMetadataService.listFilterRecruiters(pool, req);

      res.status(200).json({
        success: true,
        message: "Report recruiter filter options retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/reports/filter-options/hiring-managers", guard, async (req, res) => {
    try {
      const data = await reportBuilderMetadataService.listFilterHiringManagers(pool, req);

      res.status(200).json({
        success: true,
        message: "Report hiring manager filter options retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/reports/datasets/:datasetCode", guard, async (req, res) => {
    try {
      const data = await reportBuilderMetadataService.getDatasetMetadata(
        pool,
        req,
        req.params.datasetCode
      );

      res.status(200).json({
        success: true,
        message: "Report dataset metadata retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/reports/query", guard, async (req, res) => {
    try {
      const data = await reportBuilderQueryService.executeReportQuery(
        pool,
        req,
        req.body
      );

      res.status(200).json({
        success: true,
        message: "Report query executed successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/reports/standard-reports", guard, async (req, res) => {
    try {
      const data = await standardReportService.listAuthorizedStandardReports(pool, req);

      res.status(200).json({
        success: true,
        message: "Standard reports retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/reports/standard-reports/:reportCode", guard, async (req, res) => {
    try {
      const data = await standardReportService.getAuthorizedStandardReport(
        pool,
        req,
        req.params.reportCode
      );

      res.status(200).json({
        success: true,
        message: "Standard report definition retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/reports/export", guard, async (req, res) => {
    try {
      const exportFile = await reportBuilderExportService.exportReport(
        pool,
        req,
        req.body
      );

      res.setHeader("Content-Type", exportFile.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${exportFile.filename}"`
      );
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.status(200).send(exportFile.buffer);
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerReportBuilderRoutes };
