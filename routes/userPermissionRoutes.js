const userPermissionRepository = require("../repositories/userPermissionRepository");

function handleError(res, error) {
  console.error("User Permission API Error:", error.message);
  res.status(error.status || 500).json({
    success: false,
    message: error.message || "Internal server error"
  });
}

function verifyPermissionAdmin(req, res, next) {
  if (req.user?.role_name !== "Admin") {
    return res.status(403).json({
      success: false,
      message: "You are not authorized to manage user permissions."
    });
  }

  next();
}

function registerUserPermissionRoutes(app, pool, verifyToken, verifyAdmin) {
  const guard = [verifyToken, verifyPermissionAdmin];

  app.get("/user-permissions/:employeeCode", guard, async (req, res) => {
    try {
      const { employeeCode } = req.params;

      if (!employeeCode || !String(employeeCode).trim()) {
        return res.status(400).json({
          success: false,
          message: "employeeCode is required."
        });
      }

      const permissions = await userPermissionRepository.getUserPermissions(
        pool,
        String(employeeCode).trim()
      );

      res.status(200).json({
        success: true,
        data: permissions
      });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put("/user-permissions/:employeeCode", guard, async (req, res) => {
    try {
      const { employeeCode } = req.params;
      const permissions = Array.isArray(req.body) ? req.body : req.body?.data;

      if (!employeeCode || !String(employeeCode).trim()) {
        return res.status(400).json({
          success: false,
          message: "employeeCode is required."
        });
      }

      if (!Array.isArray(permissions)) {
        return res.status(400).json({
          success: false,
          message: "Request body must be an array of permissions."
        });
      }

      const saved = await userPermissionRepository.saveUserPermissions(
        pool,
        String(employeeCode).trim(),
        permissions,
        req.user?.employee_code || req.user?.email_id || null
      );

      res.status(200).json({
        success: true,
        data: saved
      });
    } catch (error) {
      handleError(res, error);
    }
  });
}

module.exports = { registerUserPermissionRoutes };
