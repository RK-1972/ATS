const recruitmentService = require("../services/recruitmentService");
const resumeMatchService = require("../services/resumeMatchService");
const requisitionClosureService = require("../services/requisitionClosureService");
const requisitionHeadcountChangeService = require("../services/requisitionHeadcountChangeService");
const requisitionBudgetChangeService = require("../services/requisitionBudgetChangeService");
const hiringManagerIdentityService = require("../services/hiringManagerIdentityService");
const atsStageCatalogService = require("../services/atsStageCatalogService");
const {
  requireAdminOrRequisitionAssigner,
  requireRequisitionAssigner,
  requireRequisitionRequestor,
  requireRecruiterAssignmentOperator
} = require("../services/requisitionCapabilityAuth");

function handleError(res, error) {
  console.error("Recruitment API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerRecruitmentRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyAdmin];
  const operatorGuard = [verifyToken];
  const requestorGuard = [verifyToken, requireRequisitionRequestor(pool)];
  const assignerGuard = [verifyToken, requireRequisitionAssigner(pool)];
  const portalPublicationGuard = [verifyToken, requireAdminOrRequisitionAssigner(pool)];
  const recruiterAssignmentOperatorGuard = [
    verifyToken,
    requireRecruiterAssignmentOperator(pool)
  ];
  app.get("/api/v1/recruitment/my-dashboard", verifyToken, async (req, res) => {
    try {
      const bundle = await recruitmentService.getMyRecruiterDashboard(pool, req);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/candidates", operatorGuard, async (req, res) => {
    try {
      const view = String(req.query.view || "").trim().toLowerCase();

      if (!view) {
        return res.status(400).json({
          success: false,
          message: "Query parameter view is required."
        });
      }

      let data;

      if (view === "pool") {
        data = await recruitmentService.listTalentPoolCandidates(pool, req);
      } else if (view === "pipeline") {
        data = await recruitmentService.listMyPipelineCandidates(pool, req);
      } else {
        return res.status(400).json({
          success: false,
          message: `Unsupported candidates view "${view}".`
        });
      }

      res.status(200).json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/recruitment/candidates/:candidateId/profile",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.getCandidateWorkspaceProfile(
          pool,
          req.params.candidateId,
          req
        );

        res.status(200).json({
          success: true,
          message: "Candidate profile retrieved successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/candidates/:candidateId/education",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.listCandidateEducation(
          pool,
          req.params.candidateId,
          req
        );

        res.status(200).json({
          success: true,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/candidates/:candidateId/experience",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.listCandidateExperience(
          pool,
          req.params.candidateId,
          req
        );

        res.status(200).json({
          success: true,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/api/v1/recruitment/pending-applications", operatorGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listPendingPortalApplications(pool, req);

      res.status(200).json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post(
    "/api/v1/recruitment/pending-applications/:mappingId/claim",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.claimPendingPortalApplication(
          pool,
          req.params.mappingId,
          req
        );

        res.status(200).json({
          success: true,
          message: "Application accepted into your pipeline.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/candidates/:candidateId/ownership",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.getCandidateOwnership(
          pool,
          req.params.candidateId,
          req
        );

        res.status(200).json({
          success: true,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/api/v1/recruitment/my-hm-requisitions", operatorGuard, async (req, res) => {
    try {
      const data = await hiringManagerIdentityService.listMyHmRequisitions(
        pool,
        req
      );

      res.json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/my-hm-candidates", operatorGuard, async (req, res) => {
    try {
      const filter = {};

      if (req.query.requisition_code) {
        filter.requisition_code = req.query.requisition_code;
      }

      if (req.query.req_id) {
        filter.req_id = req.query.req_id;
      }

      const data = await hiringManagerIdentityService.listMyHmCandidates(
        pool,
        req,
        filter
      );

      res.json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/ats-stage-catalog", operatorGuard, async (req, res) => {
    try {
      const data = await atsStageCatalogService.listActiveAtsStageCatalog(pool);

      res.json({
        success: true,
        count: data.length,
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment", guard, async (req, res) => {
    try {
      const bundle = await recruitmentService.getRecruitmentBundle(pool);
      res.json(bundle);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/requisitions", recruiterAssignmentOperatorGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listRequisitionsForManagement(pool);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/approved-positions", operatorGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listApprovedPositions(pool);
      res.json({
        success: true,
        message: "Approved positions retrieved successfully",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/recruitment/requisitions/:reqId/assigned-recruiters",
    recruiterAssignmentOperatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.getAssignedRecruitersForRequisition(
          pool,
          req.params.reqId
        );
        res.json({ success: true, count: data.length, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.delete("/api/v1/recruitment/recruiter-assignments/:assignmentId", operatorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.removeRecruiterAssignment(
        pool,
        req.params.assignmentId,
        req
      );
      res.json({ success: true, message: result.toastMessage, data: result.responseData });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/recruitment/requisitions/legacy-form", operatorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.handleLegacyCreateRequisition(pool, req.body, req);
      res.status(201).json({
        success: true,
        message: "Requisition Created Successfully",
        data: result.legacyRequisition || result.requisition
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/recruitment/form-options/recruiters",
    recruiterAssignmentOperatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.listFormRecruiters(pool);
        res.json({ success: true, count: data.length, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/api/v1/recruitment/form-options/clients", operatorGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listFormClients(pool);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/form-options/projects/:clientId", operatorGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listFormProjectsByClient(pool, req.params.clientId);
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/form-options/hiring-managers/:projectId", operatorGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listFormHiringManagersByProject(
        pool,
        req.params.projectId
      );
      res.json({ success: true, data });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get("/api/v1/recruitment/requisitions/:code", requestorGuard, async (req, res) => {
    try {
      const requisition = await recruitmentService.getRequisitionForRequestor(
        pool,
        req.params.code,
        req
      );

      res.json({ success: true, data: requisition });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/api/v1/recruitment/requisitions/:code", requestorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.updateRequisition(
        pool,
        req.params.code,
        req.body || {},
        req
      );
      res.json({
        success: true,
        message: result.toastMessage,
        data: result.requisition
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/recruitment/requisitions/:code/submit", requestorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.submitRequisition(
        pool,
        req.params.code,
        req.body || {},
        req
      );
      res.json({
        success: true,
        message: result.toastMessage,
        data: result
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/recruitment/requisitions", requestorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.createFromApprovedPosition(
        pool,
        req.body.approved_position_id,
        {
          business_unit: req.body.business_unit,
          location: req.body.location,
          hiring_manager: req.body.hiring_manager,
          primary_skill: req.body.primary_skill
        },
        req
      );
      res.status(201).json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/recruitment/requisitions/:code/approve", guard, async (req, res) => {
    try {
      const result = await recruitmentService.approveRequisition(
        pool,
        req.params.code,
        req.body?.comment || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post("/api/v1/recruitment/requisitions/:code/assign-recruiter", operatorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.assignRecruiter(
        pool,
        req.params.code,
        req.body.recruiter_code,
        req
      );
      res.status(201).json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post(
    "/api/v1/recruitment/requisitions/:code/publish-to-candidate-portal",
    portalPublicationGuard,
    async (req, res) => {
      try {
        const result = await recruitmentService.publishRequisitionToCandidatePortal(
          pool,
          req.params.code,
          req
        );
        res.json({
          success: true,
          message: result.toastMessage,
          data: result.requisition
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/requisitions/:code/unpublish-from-candidate-portal",
    portalPublicationGuard,
    async (req, res) => {
      try {
        const result = await recruitmentService.unpublishRequisitionFromCandidatePortal(
          pool,
          req.params.code,
          req
        );
        res.json({
          success: true,
          message: result.toastMessage,
          data: result.requisition
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/requisitions/:code/resume-matches",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await resumeMatchService.getResumeMatches(
          pool,
          req.params.code,
          req
        );

        res.status(200).json({
          success: true,
          message: "Resume matches retrieved successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/requisitions/:code/fulfillment",
    recruiterAssignmentOperatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.getRequisitionFulfillment(
          pool,
          req.params.code
        );
        res.json({ success: true, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/requisitions/:code/close-filled",
    recruiterAssignmentOperatorGuard,
    async (req, res) => {
      try {
        const result = await requisitionClosureService.closeRequisitionAsFilled(
          pool,
          req.params.code,
          req
        );
        res.json({
          success: true,
          message: result.toastMessage,
          data: {
            requisition: recruitmentService.mapRequisitionForManagementUi(
              result.requisition
            ),
            fulfillment: result.fulfillment
          }
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/requisitions/:code/headcount-changes",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await requisitionHeadcountChangeService.listHeadcountChangeHistory(
          pool,
          req.params.code,
          req
        );
        res.json({ success: true, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/requisitions/:code/headcount-changes",
    operatorGuard,
    async (req, res) => {
      try {
        const result = await requisitionHeadcountChangeService.requestHeadcountChange(
          pool,
          req.params.code,
          req.body || {},
          req
        );
        res.status(201).json({
          success: true,
          message: result.toastMessage,
          data: result.change
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/api/v1/recruitment/requisitions/:code/budget-changes",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await requisitionBudgetChangeService.listBudgetChangeHistory(
          pool,
          req.params.code,
          req
        );
        res.json({ success: true, data });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/requisitions/:code/budget-changes",
    operatorGuard,
    async (req, res) => {
      try {
        const result = await requisitionBudgetChangeService.requestBudgetChange(
          pool,
          req.params.code,
          req.body || {},
          req
        );
        res.status(201).json({
          success: true,
          message: result.toastMessage,
          data: result.change
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/api/v1/recruitment/requisitions/:code/close-cancelled",
    recruiterAssignmentOperatorGuard,
    async (req, res) => {
      try {
        const result = await requisitionClosureService.closeRequisitionAsCancelled(
          pool,
          req.params.code,
          req.body?.cancellation_reason || req.body?.reason || "",
          req
        );
        res.json({
          success: true,
          message: result.toastMessage,
          data: {
            requisition: recruitmentService.mapRequisitionForManagementUi(
              result.requisition
            ),
            fulfillment: result.fulfillment
          }
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post("/api/v1/recruitment/candidate-mappings", operatorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.mapCandidate(pool, req.body, req);
      res.status(201).json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/api/v1/recruitment/candidate-mappings/:mapId/stage", operatorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.updateCandidateStage(
        pool,
        req.params.mapId,
        req.body.stage_name,
        req.body.remarks || "",
        req
      );
      res.json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.get(
    "/api/v1/recruitment/candidate-mappings/:mapId/pipeline-history",
    operatorGuard,
    async (req, res) => {
      try {
        const data = await recruitmentService.listPipelineHistoryForMapping(
          pool,
          req.params.mapId,
          req
        );
        res.json({
          success: true,
          count: data.length,
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );
}

module.exports = { registerRecruitmentRoutes };
