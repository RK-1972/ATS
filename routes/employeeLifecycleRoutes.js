const employeeLifecycleService = require("../services/employeeLifecycleService");
const { assertCanManageEmployeeLifecycle } = require("../services/employeeLifecycleCapabilityAuth");
const { assertCanChangeUserStatus } = require("../services/userProvisioningCapabilityAuth");

function handleError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    success: false,
    message: error.message || "Request failed.",
    data: error.data || undefined
  });
}

function registerEmployeeLifecycleRoutes(app, pool, verifyToken) {
  app.get(
    "/users/:employeeCode/responsibility-preflight",
    verifyToken,
    async (req, res) => {
      try {
        await assertCanChangeUserStatus(pool, req, {
          targetEmployeeCode: req.params.employeeCode
        });
        const data = await employeeLifecycleService.buildResponsibilityPreflight(
          pool,
          req.params.employeeCode
        );
        res.status(200).json({
          success: true,
          message: "Responsibility preflight loaded.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get(
    "/employee-lifecycle/responsibility-clearance",
    verifyToken,
    async (req, res) => {
      try {
        await assertCanManageEmployeeLifecycle(pool, req);
        const data = await employeeLifecycleService.listOrganizationClearanceQueue(pool);
        res.status(200).json({
          success: true,
          message: "Organization responsibility clearance queue loaded.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/users/:employeeCode/responsibility-resolutions",
    verifyToken,
    async (req, res) => {
      try {
        const data = await employeeLifecycleService.applyResponsibilityResolutions(
          pool,
          req,
          req.params.employeeCode,
          req.body || {}
        );
        res.status(200).json({
          success: true,
          message: "Responsibility resolutions applied.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/employee-lifecycle/bulk-recruiter-replacement",
    verifyToken,
    async (req, res) => {
      try {
        const data = await employeeLifecycleService.bulkReplaceRecruiter(pool, req, req.body || {});
        res.status(200).json({
          success: true,
          message: "Recruiter assignments replaced.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.post(
    "/employee-lifecycle/bulk-workflow-reassign",
    verifyToken,
    async (req, res) => {
      try {
        const data = await employeeLifecycleService.bulkReassignWorkflowTasks(
          pool,
          req,
          req.body || {}
        );
        res.status(200).json({
          success: true,
          message: "Workflow tasks reassigned.",
          data
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );

  app.get("/session/workspace", verifyToken, async (req, res) => {
    try {
      const employeeCode = String(req.user?.employee_code || "").trim();
      if (!employeeCode) {
        return res.status(401).json({
          success: false,
          message: "Employee context is required."
        });
      }

      const userResult = await pool.query(
        `SELECT employee_code, email_id, role_name, full_name, is_active
         FROM user_mstr
         WHERE employee_code = $1`,
        [employeeCode]
      );

      const userRow = userResult.rows[0];
      if (!userRow || userRow.is_active !== true) {
        return res.status(403).json({
          success: false,
          message: "Account is inactive."
        });
      }

      const data = await employeeLifecycleService.buildSessionWorkspacePayload(
        pool,
        employeeCode,
        userRow
      );

      res.status(200).json({
        success: true,
        message: "Workspace session refreshed.",
        data
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerEmployeeLifecycleRoutes };
