const recruitmentService = require("../services/recruitmentService");
const {
  requireRequisitionAssigner,
  requireRequisitionRequestor
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
  app.get("/api/v1/recruitment/my-dashboard", verifyToken, async (req, res) => {
    try {
      const bundle = await recruitmentService.getMyRecruiterDashboard(pool, req);
      res.json(bundle);
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

  app.get("/api/v1/recruitment/requisitions", assignerGuard, async (req, res) => {
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

  app.get("/api/v1/recruitment/requisitions/:reqId/assigned-recruiters", assignerGuard, async (req, res) => {
    try {
      const data = await recruitmentService.getAssignedRecruitersForRequisition(
        pool,
        req.params.reqId
      );
      res.json({ success: true, count: data.length, data });
    } catch (error) {
      handleError(res, error);
    }
  });

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

  app.get("/api/v1/recruitment/form-options/recruiters", assignerGuard, async (req, res) => {
    try {
      const data = await recruitmentService.listFormRecruiters(pool);
      res.json({ success: true, count: data.length, data });
    } catch (error) {
      handleError(res, error);
    }
  });

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

  app.post("/api/v1/recruitment/candidate-mappings", operatorGuard, async (req, res) => {
    try {
      const result = await recruitmentService.mapCandidate(pool, req.body, req);
      res.status(201).json({ success: true, ...result });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/api/v1/recruitment/candidate-mappings/:mapId/stage", guard, async (req, res) => {
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
}

module.exports = { registerRecruitmentRoutes };
