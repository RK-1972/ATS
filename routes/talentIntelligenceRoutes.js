const otiCapabilityAuth = require("../services/oti/otiCapabilityAuth");
const otiOrchestratorService = require("../services/oti/otiOrchestratorService");
const otiRecruiterActionService = require("../services/oti/otiRecruiterActionService");
const otiResumeIndexService = require("../services/oti/otiResumeIndexService");
const { describeConnectorCatalog } = require("../services/oti/connectors/otiConnectorRegistry");
const otiExternalRecruiterActionService = require("../services/oti/otiExternalRecruiterActionService");
const otiExternalResumeRetrievalService = require("../services/oti/otiExternalResumeRetrievalService");
const otiResumeRetrievalGrantService = require("../services/oti/otiResumeRetrievalGrantService");
const otiPublicResumeDocumentService = require("../services/oti/otiPublicResumeDocumentService");
const otiExternalLeadIntakeService = require("../services/oti/otiExternalLeadIntakeService");

function handleError(res, error) {
  console.error("Talent Intelligence API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerTalentIntelligenceRoutes(app, pool, verifyToken, intakeDeps = null) {
  const guard = [verifyToken];

  app.get("/api/v1/recruitment/talent-intelligence/availability", guard, async (req, res) => {
    try {
      await otiCapabilityAuth.assertCanAccessOtiFeatureMetadata(pool, req, req.query || {});
      const data = await otiCapabilityAuth.getOtiAvailability(pool);
      res.status(200).json({
        success: true,
        message: "Talent Intelligence availability retrieved.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/recruitment/talent-intelligence/workspace/requisitions",
    guard,
    async (req, res) => {
      try {
        const data = await otiCapabilityAuth.listTalentIntelligenceWorkspaceRequisitions(
          pool,
          req
        );

        res.status(200).json({
          success: true,
          message: "Talent Intelligence workspace requisitions retrieved.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/workspace/requisitions/:code/runs",
    guard,
    async (req, res) => {
      try {
        const data = await otiOrchestratorService.executeSourcingRun(
          pool,
          req.params.code,
          req,
          req.body || {},
          "workspace"
        );

        const completed = String(data?.status || "").trim() === "completed";
        res.status(completed ? 201 : 200).json({
          success: completed,
          message: completed
            ? "Sourcing run completed."
            : data?.error_message || "Sourcing run did not complete successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/talent-intelligence/workspace/requisitions/:code/runs",
    guard,
    async (req, res) => {
      try {
        const data = await otiOrchestratorService.listRunsForRequisition(
          pool,
          req.params.code,
          req,
          "workspace"
        );

        res.status(200).json({
          success: true,
          message: "Workspace sourcing runs retrieved.",
          data: { runs: data }
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/requisitions/:code/talent-intelligence/runs",
    guard,
    async (req, res) => {
      try {
        const data = await otiOrchestratorService.executeSourcingRun(
          pool,
          req.params.code,
          req,
          req.body || {},
          "requisition"
        );

        const completed = String(data?.status || "").trim() === "completed";
        res.status(completed ? 201 : 200).json({
          success: completed,
          message: completed
            ? "Sourcing run completed."
            : data?.error_message || "Sourcing run did not complete successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/talent-intelligence/runs/:runId",
    guard,
    async (req, res) => {
      try {
        const data = await otiOrchestratorService.getRunByPublicId(
          pool,
          req.params.runId,
          req
        );

        res.status(200).json({
          success: true,
          message: "Sourcing run retrieved.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/talent-intelligence/runs/:runId/results",
    guard,
    async (req, res) => {
      try {
        const data = await otiOrchestratorService.listRunResults(
          pool,
          req.params.runId,
          req,
          req.query || {}
        );

        res.status(200).json({
          success: true,
          message: "Sourcing run results retrieved.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/requisitions/:code/talent-intelligence/runs",
    guard,
    async (req, res) => {
      try {
        const data = await otiOrchestratorService.listRunsForRequisition(
          pool,
          req.params.code,
          req,
          "requisition"
        );

        res.status(200).json({
          success: true,
          message: "Requisition sourcing runs retrieved.",
          data: { runs: data }
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/candidates/:candidateId/resume-index",
    guard,
    async (req, res) => {
      try {
        const data = await otiResumeIndexService.queueAndProcessIndex(
          pool,
          Number(req.params.candidateId),
          req
        );

        res.status(202).json({
          success: true,
          message: "Resume indexing completed or queued for processing.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/talent-intelligence/candidates/:candidateId/resume-index/status",
    guard,
    async (req, res) => {
      try {
        await otiResumeIndexService.assertCanManageCandidateIndex(
          pool,
          req,
          Number(req.params.candidateId)
        );
        const data = await otiResumeIndexService.getPublicIndexStatus(
          pool,
          Number(req.params.candidateId)
        );

        res.status(200).json({
          success: true,
          message: "Resume index status retrieved.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/candidates/:candidateId/resume-index/retry",
    guard,
    async (req, res) => {
      try {
        const data = await otiResumeIndexService.retryIndex(
          pool,
          Number(req.params.candidateId),
          req
        );

        res.status(202).json({
          success: true,
          message: "Resume indexing retry completed or scheduled.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/api/v1/recruitment/talent-intelligence/connectors", guard, async (req, res) => {
    try {
      await otiCapabilityAuth.assertCanAccessOtiFeatureMetadata(pool, req, req.query || {});
      const data = await describeConnectorCatalog({ publicView: true });

      res.status(200).json({
        success: true,
        message: "OTI connector catalog retrieved.",
        data: { connectors: data }
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/resume-retrieval/status",
    guard,
    async (req, res) => {
      try {
        const data = await otiExternalResumeRetrievalService.getResumeRetrievalStatus(
          pool,
          Number(req.params.leadId),
          req
        );

        res.status(200).json({
          success: true,
          message: "External resume retrieval status retrieved.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/resume-retrieval",
    guard,
    async (req, res) => {
      try {
        const data = await otiExternalResumeRetrievalService.executeLicensedRetrieval(
          pool,
          Number(req.params.leadId),
          req,
          req.body || {}
        );

        res.status(201).json({
          success: true,
          message: "Licensed resume retrieval completed.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/resume-retrieval/grants/:grantUuid/revoke",
    guard,
    async (req, res) => {
      try {
        const data = await otiResumeRetrievalGrantService.revokeGrant(
          pool,
          req.params.grantUuid,
          req,
          {
            ...(req.body || {}),
            ...(req.query || {}),
            external_lead_id: Number(req.params.leadId)
          }
        );

        res.status(200).json({
          success: true,
          message: "Retrieval grant revoked.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/resume-document",
    guard,
    async (req, res) => {
      try {
        const data = await otiPublicResumeDocumentService.getExternalLeadResumeDocument(
          pool,
          Number(req.params.leadId),
          req,
          req.query || {}
        );

        res.setHeader("Content-Type", data.mime_type || "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `inline; filename="external-lead-${req.params.leadId}.${data.detected_format || "pdf"}"`
        );
        res.status(200).send(data.buffer);
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/prepare-intake-review",
    guard,
    async (req, res) => {
      try {
        if (!intakeDeps) {
          return res.status(503).json({
            success: false,
            message: "Candidate intake services are not configured for OTI review."
          });
        }

        const data = await otiExternalLeadIntakeService.prepareExternalLeadIntakeReview(
          pool,
          Number(req.params.leadId),
          req,
          { ...(req.body || {}), ...(req.query || {}) },
          intakeDeps
        );

        res.status(200).json({
          success: true,
          message: "External lead intake review session prepared.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/complete-registration",
    guard,
    async (req, res) => {
      try {
        const data = await otiExternalLeadIntakeService.completeExternalLeadRegistration(
          pool,
          Number(req.params.leadId),
          req,
          { ...(req.body || {}), ...(req.query || {}) }
        );

        res.status(200).json({
          success: true,
          message: "External lead registration completed.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/external-leads/:leadId/actions",
    guard,
    async (req, res) => {
      try {
        const data = await otiExternalRecruiterActionService.recordExternalLeadAction(
          pool,
          req.params.leadId,
          req,
          req.body || {}
        );

        res.status(201).json({
          success: true,
          message: "External lead action recorded.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/talent-intelligence/results/:resultId/actions",
    guard,
    async (req, res) => {
      try {
        const data = await otiRecruiterActionService.recordRecruiterAction(
          pool,
          req.params.resultId,
          req,
          req.body || {}
        );

        res.status(201).json({
          success: true,
          message: "Recruiter action recorded.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );
}

module.exports = {
  registerTalentIntelligenceRoutes
};
