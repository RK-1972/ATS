function registerCandidatePortalRoutes(
  app,
  pool,
  verifyCandidateToken,
  verifyToken,
  sendCandidateWelcomeEmail,
  upload,
  parserDeps
) {
  const {
    createCandidatePortalService
  } = require("../services/candidatePortalService");
  const {
    createCandidatePortalProfileService
  } = require("../services/candidatePortalProfileService");

  const candidatePortalService = createCandidatePortalService(pool);
  const candidatePortalProfileService =
    createCandidatePortalProfileService(pool, parserDeps);

  function getCandidateId(req) {
    return req.candidate.candidate_id;
  }

  // =====================================================
  // API — Candidate Portal Register
  // =====================================================

  app.post("/candidate-portal/register", async (req, res) => {
    try {
      const result = await candidatePortalService.registerCandidateAccount(
        req.body || {}
      );

      if (!result.ok) {
        return res.status(result.status).json({
          success: false,
          message: result.message
        });
      }

      const { account, linked_existing_candidate } = result.data;

      try {
        await sendCandidateWelcomeEmail(
          account.email_id,
          account.full_name
        );
      } catch (emailError) {
        console.error(
          "[candidate-portal/register] Welcome email failed:",
          emailError.message
        );
      }

      return res.status(201).json({
        success: true,
        message: "Candidate account created successfully",
        data: {
          email_id: account.email_id,
          full_name: account.full_name,
          candidate_id: account.candidate_id,
          linked_existing_candidate
        }
      });
    } catch (error) {
      console.error("[candidate-portal/register]", {
        message: error.message,
        code: error.code,
        detail: error.detail,
        constraint: error.constraint,
        table: error.table,
        column: error.column
      });
      return res.status(500).json({
        success: false,
        message: "Registration failed"
      });
    }
  });

  // =====================================================
  // API — Candidate Portal Login
  // =====================================================

  app.post("/candidate-portal/login", async (req, res) => {
    try {
      const result = await candidatePortalService.loginCandidateAccount(
        req.body || {}
      );

      if (!result.ok) {
        return res.status(result.status).json({
          success: false,
          message: result.message
        });
      }

      return res.status(200).json({
        success: true,
        message: "Login successful",
        data: result.data
      });
    } catch (error) {
      console.error("[candidate-portal/login]", error);

      if (error.message === "JWT_SECRET is not configured") {
        return res.status(500).json({
          success: false,
          message: "Login Error"
        });
      }

      return res.status(500).json({
        success: false,
        message: "Login failed"
      });
    }
  });

  // =====================================================
  // API — Candidate Portal Session
  // =====================================================

  app.get("/candidate-portal/me", verifyCandidateToken, async (req, res) => {
    try {
      const summary =
        await candidatePortalService.getCandidateWorkspaceSummary(
          getCandidateId(req)
        );

      if (!summary) {
        return res.status(404).json({
          success: false,
          message: "Candidate profile not found"
        });
      }

      return res.status(200).json({
        success: true,
        message: "Candidate session loaded",
        data: {
          account: {
            portal_account_id: req.candidate.portal_account_id,
            candidate_id: req.candidate.candidate_id,
            email_id: req.candidate.email_id,
            full_name: req.candidate.full_name
          },
          candidate: summary
        }
      });
    } catch (error) {
      console.error("[candidate-portal/me]", error);
      return res.status(500).json({
        success: false,
        message: "Failed to load candidate session"
      });
    }
  });

  // =====================================================
  // API — Candidate Portal Workspace
  // =====================================================

  app.get(
    "/candidate-portal/workspace",
    verifyCandidateToken,
    async (req, res) => {
      try {
        const summary =
          await candidatePortalService.getCandidateWorkspaceSummary(
            getCandidateId(req)
          );

        if (!summary) {
          return res.status(404).json({
            success: false,
            message: "Candidate workspace not found"
          });
        }

        return res.status(200).json({
          success: true,
          message: "Candidate workspace loaded",
          data: summary
        });
      } catch (error) {
        console.error("[candidate-portal/workspace]", error);
        return res.status(500).json({
          success: false,
          message: "Failed to load candidate workspace"
        });
      }
    }
  );

  // =====================================================
  // API — Candidate Portal Profile (read)
  // =====================================================

  app.get(
    "/candidate-portal/profile",
    verifyCandidateToken,
    async (req, res) => {
      try {
        const result = await candidatePortalProfileService.getCandidateProfile(
          getCandidateId(req)
        );

        if (!result.ok) {
          return res.status(result.status).json({
            success: false,
            message: result.message
          });
        }

        return res.status(200).json({
          success: true,
          message: "Candidate profile loaded",
          data: result.data
        });
      } catch (error) {
        console.error("[candidate-portal/profile GET]", error);
        return res.status(500).json({
          success: false,
          message: "Failed to load candidate profile"
        });
      }
    }
  );

  // =====================================================
  // API — Candidate Portal Profile (save, DRAFT only)
  // =====================================================

  app.put(
    "/candidate-portal/profile",
    verifyCandidateToken,
    async (req, res) => {
      try {
        const result = await candidatePortalProfileService.saveCandidateProfile(
          getCandidateId(req),
          req.body || {}
        );

        if (!result.ok) {
          return res.status(result.status).json({
            success: false,
            message: result.message,
            errors: result.errors || undefined
          });
        }

        return res.status(200).json({
          success: true,
          message: "Profile saved successfully",
          data: result.data
        });
      } catch (error) {
        console.error("[candidate-portal/profile PUT]", {
          message: error.message,
          code: error.code,
          detail: error.detail
        });
        return res.status(500).json({
          success: false,
          message: "Failed to save candidate profile"
        });
      }
    }
  );

  // =====================================================
  // API — Candidate Portal Profile Intake (create)
  // =====================================================

  app.post(
    "/candidate-portal/profile/intake",
    verifyCandidateToken,
    async (req, res) => {
      try {
        const result = await candidatePortalProfileService.createProfileIntake(
          getCandidateId(req)
        );

        if (!result.ok) {
          return res.status(result.status).json({
            success: false,
            message: result.message
          });
        }

        return res.status(201).json({
          success: true,
          message: "Profile intake created",
          data: result.data
        });
      } catch (error) {
        console.error("[candidate-portal/profile/intake POST]", error);
        return res.status(500).json({
          success: false,
          message: "Failed to create profile intake"
        });
      }
    }
  );

  // =====================================================
  // API — Candidate Portal Profile Intake (upload)
  // =====================================================

  app.post(
    "/candidate-portal/profile/intake/:intakeId/process",
    verifyCandidateToken,
    upload.single("resume"),
    async (req, res) => {
      try {
        const intakeId = Number(req.params.intakeId);
        const result = await candidatePortalProfileService.processProfileIntake(
          getCandidateId(req),
          intakeId,
          req.file
        );

        if (!result.ok) {
          return res.status(result.status).json({
            success: false,
            message: result.message
          });
        }

        return res.status(200).json({
          success: true,
          message: "Resume uploaded successfully",
          data: result.data
        });
      } catch (error) {
        console.error("[candidate-portal/profile/intake/process]", error);
        return res.status(500).json({
          success: false,
          message: "Failed to upload resume"
        });
      }
    }
  );

  // =====================================================
  // API — Candidate Portal Profile Intake (parse)
  // =====================================================

  app.post(
    "/candidate-portal/profile/intake/:intakeId/parse",
    verifyCandidateToken,
    async (req, res) => {
      try {
        const intakeId = Number(req.params.intakeId);
        const result = await candidatePortalProfileService.parseProfileIntake(
          getCandidateId(req),
          intakeId
        );

        if (!result.ok) {
          return res.status(result.status).json({
            success: false,
            message: result.message
          });
        }

        return res.status(200).json({
          success: true,
          message: "Resume parsed successfully",
          data: result.data
        });
      } catch (error) {
        console.error("[candidate-portal/profile/intake/parse]", {
          message: error.message,
          code: error.code,
          detail: error.detail
        });
        return res.status(500).json({
          success: false,
          message: "Failed to parse resume"
        });
      }
    }
  );

  // =====================================================
  // API — Portal Candidate Review Queue (recruiter)
  // =====================================================

  app.get(
    "/candidate-intake/portal-review-queue",
    verifyToken,
    async (req, res) => {
      try {
        const queue =
          await candidatePortalProfileService.listPortalReviewQueue();

        return res.status(200).json({
          success: true,
          message: "Portal candidate review queue loaded",
          data: queue
        });
      } catch (error) {
        console.error("[candidate-intake/portal-review-queue]", error);
        return res.status(500).json({
          success: false,
          message: "Failed to load portal review queue"
        });
      }
    }
  );
}

module.exports = {
  registerCandidatePortalRoutes
};
