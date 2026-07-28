const workAssignmentService = require("../services/workAssignmentService");

function handleError(res, error) {
  console.error("Work Assignment API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function registerWorkAssignmentRoutes(app, pool, verifyToken, verifyAdmin) {
  const adminGuard = [verifyToken, verifyAdmin];

  // GET /work-assignments — List all work assignments
  app.get("/work-assignments", verifyToken, async (req, res) => {
    try {
      const data = await workAssignmentService.getAllWorkAssignments(pool);

      res.status(200).json({
        success: true,
        message: "Work assignments retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /work-assignments/active — List active work assignments
  // Registered before /:id so "active" is not treated as an id.
  app.get("/work-assignments/active", verifyToken, async (req, res) => {
    try {
      const data = await workAssignmentService.getActiveWorkAssignments(pool);

      res.status(200).json({
        success: true,
        message: "Active work assignments retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /work-assignments/:id/employee-count — Active employee count
  app.get(
    "/work-assignments/:id/employee-count",
    verifyToken,
    async (req, res) => {
      try {
        const data = await workAssignmentService.getEmployeeCount(
          pool,
          req.params.id
        );

        res.status(200).json({
          success: true,
          message: "Employee count retrieved successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  // GET /work-assignments/:id — Get work assignment by id
  app.get("/work-assignments/:id", verifyToken, async (req, res) => {
    try {
      const data = await workAssignmentService.getWorkAssignmentById(
        pool,
        req.params.id
      );

      res.status(200).json({
        success: true,
        message: "Work assignment retrieved successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /work-assignments — Create work assignment (Admin)
  app.post("/work-assignments", adminGuard, async (req, res) => {
    try {
      const data = await workAssignmentService.createWorkAssignment(pool, {
        ...(req.body || {}),
        created_by:
          req.body?.created_by ||
          req.user?.employee_code ||
          req.user?.full_name ||
          null
      });

      res.status(201).json({
        success: true,
        message: "Work assignment created successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // PUT /work-assignments/:id — Update work assignment (Admin)
  app.put("/work-assignments/:id", adminGuard, async (req, res) => {
    try {
      const data = await workAssignmentService.updateWorkAssignment(
        pool,
        req.params.id,
        {
          ...(req.body || {}),
          updated_by:
            req.body?.updated_by ||
            req.user?.employee_code ||
            req.user?.full_name ||
            null
        }
      );

      res.status(200).json({
        success: true,
        message: "Work assignment updated successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /work-assignments/:id/activate — Activate (Admin)
  app.post("/work-assignments/:id/activate", adminGuard, async (req, res) => {
    try {
      const data = await workAssignmentService.activateWorkAssignment(
        pool,
        req.params.id,
        req.user?.employee_code || req.user?.full_name || null
      );

      res.status(200).json({
        success: true,
        message: "Work assignment activated successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /work-assignments/:id/deactivate — Deactivate (Admin)
  app.post(
    "/work-assignments/:id/deactivate",
    adminGuard,
    async (req, res) => {
      try {
        const data = await workAssignmentService.deactivateWorkAssignment(
          pool,
          req.params.id,
          req.user?.employee_code || req.user?.full_name || null
        );

        res.status(200).json({
          success: true,
          message: "Work assignment deactivated successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  // DELETE /work-assignments/:id — Delete when allowed (Admin)
  app.delete("/work-assignments/:id", adminGuard, async (req, res) => {
    try {
      const data = await workAssignmentService.deleteWorkAssignment(
        pool,
        req.params.id
      );

      res.status(200).json({
        success: true,
        message: "Work assignment deleted successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // POST /employee-work-assignments — Assign work assignment to employee
  app.post("/employee-work-assignments", verifyToken, async (req, res) => {
    try {
      const body = req.body || {};
      const data = await workAssignmentService.assignWorkAssignment(
        pool,
        body.employee_code,
        body.work_assignment_id,
        body.effective_from,
        body.effective_to
      );

      res.status(201).json({
        success: true,
        message: "Work assignment assigned successfully.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  // GET /employee-work-assignments/:employeeCode — List assignments for employee
  app.get(
    "/employee-work-assignments/:employeeCode",
    verifyToken,
    async (req, res) => {
      try {
        const data = await workAssignmentService.getEmployeeWorkAssignments(
          pool,
          req.params.employeeCode
        );

        res.status(200).json({
          success: true,
          message: "Employee work assignments retrieved successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  // DELETE /employee-work-assignments/:employeeWorkAssignmentId — Remove assignment
  app.delete(
    "/employee-work-assignments/:employeeWorkAssignmentId",
    verifyToken,
    async (req, res) => {
      try {
        const data = await workAssignmentService.removeEmployeeWorkAssignment(
          pool,
          req.params.employeeWorkAssignmentId
        );

        res.status(200).json({
          success: true,
          message: "Employee work assignment removed successfully.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );
}

module.exports = { registerWorkAssignmentRoutes };
