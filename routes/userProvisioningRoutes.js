const userProvisioningService = require("../services/userProvisioningService");

const {

  requireUserAdministration,

  requireUserProvisioner,

  requirePrimaryRoleChanger,

  requireUserStatusChanger

} = require("../services/userProvisioningCapabilityAuth");



function handleError(res, error) {

  console.error("User Provisioning API Error:", error.message);

  res.status(error.status || 500).json({

    success: false,

    message: error.message || "Internal server error"

  });

}



function registerUserProvisioningRoutes(app, pool, verifyToken) {

  const userAdminGuard = [verifyToken, requireUserAdministration(pool)];

  const provisionGuard = [verifyToken, requireUserProvisioner(pool)];

  const roleChangeGuard = [verifyToken, requirePrimaryRoleChanger(pool)];

  const statusChangeGuard = [verifyToken, requireUserStatusChanger(pool)];



  app.get("/users", userAdminGuard, async (req, res) => {

    try {

      const result = await pool.query(

        `SELECT

           user_id,

           employee_code,

           full_name,

           email_id,

           role_name,

           is_active,

           created_on

         FROM user_mstr

         ORDER BY user_id DESC`

      );



      res.status(200).json({

        success: true,

        data: result.rows

      });

    } catch (error) {

      handleError(res, error);

    }

  });



  app.get("/users/:employeeCode/role-history", userAdminGuard, async (req, res) => {

    try {

      const data = await userProvisioningService.getRoleHistory(

        pool,

        req.params.employeeCode

      );



      res.status(200).json({

        success: true,

        message: "Role history retrieved successfully.",

        data

      });

    } catch (error) {

      handleError(res, error);

    }

  });



  app.get("/users/:employeeCode/status-history", userAdminGuard, async (req, res) => {

    try {

      const data = await userProvisioningService.getStatusHistory(

        pool,

        req.params.employeeCode

      );



      res.status(200).json({

        success: true,

        message: "Status history retrieved successfully.",

        data

      });

    } catch (error) {

      handleError(res, error);

    }

  });



  app.post("/users/provision", provisionGuard, async (req, res) => {

    try {

      const data = await userProvisioningService.provisionEmployee(

        pool,

        req,

        req.body || {}

      );



      res.status(201).json({

        success: true,

        message: "User provisioned successfully.",

        data

      });

    } catch (error) {

      handleError(res, error);

    }

  });



  app.post(

    "/users/:employeeCode/primary-role",

    roleChangeGuard,

    async (req, res) => {

      try {

        const data = await userProvisioningService.changePrimaryRole(

          pool,

          req,

          req.params.employeeCode,

          req.body || {}

        );



        res.status(200).json({

          success: true,

          message:

            "Primary Role updated successfully. The employee must sign in again for full role-dependent session behavior.",

          data

        });

      } catch (error) {

        handleError(res, error);

      }

    }

  );



  app.post(

    "/users/:employeeCode/deactivate",

    statusChangeGuard,

    async (req, res) => {

      try {

        const data = await userProvisioningService.changeUserStatus(

          pool,

          req,

          req.params.employeeCode,

          { is_active: false, reason: req.body?.reason }

        );



        res.status(200).json({

          success: true,

          message:

            "User deactivated successfully. Active sessions for this account are no longer authorized.",

          data

        });

      } catch (error) {

        handleError(res, error);

      }

    }

  );



  app.post(

    "/users/:employeeCode/activate",

    statusChangeGuard,

    async (req, res) => {

      try {

        const data = await userProvisioningService.changeUserStatus(

          pool,

          req,

          req.params.employeeCode,

          { is_active: true, reason: req.body?.reason }

        );



        res.status(200).json({

          success: true,

          message: "User activated successfully.",

          data

        });

      } catch (error) {

        handleError(res, error);

      }

    }

  );

}



module.exports = { registerUserProvisioningRoutes };


