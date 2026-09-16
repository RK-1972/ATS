/**
 * Candidate Portal publication verification.
 * Run: node scripts/verifyCandidatePortalPublication.js
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const recruitmentService = require("../services/recruitmentService");

const REQUISITION_ASSIGNER_CODE = "REQUISITION_ASSIGNER";

function resolveBackendApiBaseUrl() {
  if (process.env.BACKEND_API_URL) {
    return String(process.env.BACKEND_API_URL).replace(/\/$/, "");
  }

  const configured = String(process.env.API_BASE_URL || "").trim();
  if (configured.includes(":5000")) {
    return configured.replace(/\/$/, "");
  }

  return "http://localhost:5000";
}

const API_BASE_URL = resolveBackendApiBaseUrl();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(label, detail) {
  console.log(`SKIP: ${label}${detail ? ` — ${detail}` : ""}`);
}

function signEmployeeToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

function buildReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    }
  };
}

async function fetchJson(path, token, options = {}) {
  const headers = {
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });
  const contentType = String(response.headers.get("content-type") || "");
  const rawText = await response.text();
  let body = {};

  if (contentType.includes("application/json") || rawText.trim().startsWith("{")) {
    try {
      body = JSON.parse(rawText);
    } catch (_error) {
      body = {};
    }
  }

  return { response, body, rawText };
}

async function columnExists(tableName, columnName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  return result.rows.length > 0;
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role, full_name
     FROM user_mstr
     WHERE role_name = 'Admin'
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveAssignerUser() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code
      AND COALESCE(ewa.is_active, TRUE) = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.assignment_code = $1
      AND COALESCE(wam.is_active, TRUE) = TRUE
     WHERE COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function resolveUnauthorizedRecruiter() {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
      AND COALESCE(u.is_active, TRUE) = TRUE
      AND LOWER(COALESCE(u.role_name, '')) <> 'admin'
      AND NOT EXISTS (
        SELECT 1
        FROM employee_work_assignment ewa
        INNER JOIN work_assignment_mstr wam
          ON wam.work_assignment_id = ewa.work_assignment_id
         AND wam.assignment_code = $1
         AND COALESCE(wam.is_active, TRUE) = TRUE
        WHERE ewa.employee_code = u.employee_code
          AND COALESCE(ewa.is_active, TRUE) = TRUE
      )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [REQUISITION_ASSIGNER_CODE]
  );

  return result.rows[0] || null;
}

async function findApprovedUnpublishedRequisition() {
  const result = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     WHERE r.req_status = $1
       AND r.candidate_portal_published_at IS NULL
       AND (
         r.req_id IS NULL
         OR EXISTS (
           SELECT 1
           FROM req_mstr lm
           WHERE lm.req_id = r.req_id
         )
       )
     ORDER BY r.modified_on DESC NULLS LAST, r.created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED]
  );

  return result.rows[0]?.requisition_code || null;
}

async function findNonApprovedRequisition() {
  const result = await pool.query(
    `SELECT requisition_code
     FROM rm_requisitions
     WHERE req_status <> $1
     ORDER BY modified_on DESC NULLS LAST, created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED]
  );

  return result.rows[0]?.requisition_code || null;
}

async function countMappingsForRequisition(requisitionCode) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_candidate_mappings
     WHERE requisition_code = $1`,
    [requisitionCode]
  );

  return Number(result.rows[0]?.total || 0);
}

async function cleanupPortalCandidate(candidateId) {
  if (!candidateId) {
    return;
  }

  const mappingRows = await pool.query(
    `SELECT map_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1`,
    [candidateId]
  );
  const mapIds = mappingRows.rows
    .map((row) => row.map_id)
    .filter((value) => value != null);

  await pool.query(
    `DELETE FROM rm_pipeline_history
     WHERE candidate_id = $1`,
    [candidateId]
  );

  if (mapIds.length > 0) {
    await pool.query(
      `DELETE FROM candidate_req_map
       WHERE map_id = ANY($1::int[])`,
      [mapIds]
    );
  }

  await pool.query(
    `DELETE FROM candidate_req_map
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM rm_candidate_mappings
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM candidate_portal_account
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM cand_mstr
     WHERE candidate_id = $1`,
    [candidateId]
  );
}

async function registerPortalCandidate(uniqueSuffix) {
  const portalService = createCandidatePortalService(pool);
  const emailId = `portal.publication.${uniqueSuffix}@example.com`;
  const password = "TestPass1!";

  const registerResult = await portalService.registerCandidateAccount({
    full_name: "Portal Publication Candidate",
    mobile_number: "9876503333",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    throw new Error(registerResult.message || "registration failed");
  }

  const loginResult = await portalService.loginCandidateAccount({
    email_id: emailId,
    password
  });

  if (!loginResult.ok) {
    throw new Error(loginResult.message || "login failed");
  }

  return {
    candidateId: registerResult.data.account.candidate_id,
    token: loginResult.data.token
  };
}

async function main() {
  const uniqueSuffix = Date.now();
  let testRequisitionCode = null;
  let candidateId = null;

  try {
    const hasPublishedAt = await columnExists(
      "rm_requisitions",
      "candidate_portal_published_at"
    );
    const hasPublishedBy = await columnExists(
      "rm_requisitions",
      "candidate_portal_published_by"
    );

    if (!hasPublishedAt || !hasPublishedBy) {
      fail(
        "migration columns exist",
        "run node scripts/apply053CandidatePortalPublicationMigration.js"
      );
      return;
    }

    pass("migration columns exist");

    const adminUser = await resolveAdminUser();
    const assignerUser = await resolveAssignerUser();
    const publisherUser = adminUser || assignerUser;

    if (!publisherUser) {
      fail("resolve authorized publisher user");
      return;
    }

    pass(`resolved authorized publisher user (${publisherUser.employee_code})`);

    testRequisitionCode = await findApprovedUnpublishedRequisition();
    if (!testRequisitionCode) {
      skip("approved unpublished requisition scenarios", "none available");
      return;
    }

    pass(`resolved approved unpublished requisition (${testRequisitionCode})`);

    const unpublishedServiceRows =
      await recruitmentService.listOpenRequisitionsForCandidatePortal(pool);
    if (unpublishedServiceRows.some(
      (row) => row.requisition_code === testRequisitionCode
    )) {
      fail("approved unpublished requisition absent from portal service list");
    } else {
      pass("approved unpublished requisition absent from portal service list");
    }

    const publisherReq = buildReq(publisherUser);
    const publishResult = await recruitmentService.publishRequisitionToCandidatePortal(
      pool,
      testRequisitionCode,
      publisherReq
    );

    if (!publishResult.requisition?.candidate_portal_published) {
      fail("publish sets candidate_portal_published");
    } else {
      pass("publish sets candidate_portal_published");
    }

    const publishedServiceRows =
      await recruitmentService.listOpenRequisitionsForCandidatePortal(pool);
    if (!publishedServiceRows.some(
      (row) => row.requisition_code === testRequisitionCode
    )) {
      fail("approved published requisition appears in portal service list");
    } else {
      pass("approved published requisition appears in portal service list");
    }

    const idempotentPublish =
      await recruitmentService.publishRequisitionToCandidatePortal(
        pool,
        testRequisitionCode,
        publisherReq
      );
    if (!idempotentPublish.alreadyPublished) {
      fail("publish is idempotent");
    } else {
      pass("publish is idempotent");
    }

    const nonApprovedCode = await findNonApprovedRequisition();
    if (!nonApprovedCode) {
      skip("publish requires approved status", "no non-approved requisition available");
    } else {
      try {
        await recruitmentService.publishRequisitionToCandidatePortal(
          pool,
          nonApprovedCode,
          publisherReq
        );
        fail("publish requires approved status");
      } catch (error) {
        if (error.status === 400) {
          pass("publish requires approved status");
        } else {
          fail("publish requires approved status", error.message);
        }
      }
    }

    const unauthorizedUser = await resolveUnauthorizedRecruiter();
    if (!unauthorizedUser) {
      skip("unauthorized user cannot publish", "no recruiter without assigner assignment");
    } else {
      try {
        await recruitmentService.publishRequisitionToCandidatePortal(
          pool,
          testRequisitionCode,
          buildReq(unauthorizedUser)
        );
        fail("unauthorized user cannot publish");
      } catch (error) {
        if (error.status === 403) {
          pass("unauthorized user cannot publish");
        } else {
          fail("unauthorized user cannot publish", error.message);
        }
      }
    }

    const mappingCountBeforeApply = await countMappingsForRequisition(testRequisitionCode);
    const portalCandidate = await registerPortalCandidate(uniqueSuffix);
    candidateId = portalCandidate.candidateId;

    const application = await recruitmentService.applyCandidateFromPortal(
      pool,
      { candidate_id: candidateId, full_name: "Portal Publication Candidate", email_id: `portal.publication.${uniqueSuffix}@example.com` },
      { requisition_code: testRequisitionCode }
    );

    if (!application?.requisition_code) {
      fail("candidate can apply to published requisition");
    } else {
      pass("candidate can apply to published requisition");
    }

    const mappingCountAfterApply = await countMappingsForRequisition(testRequisitionCode);
    if (mappingCountAfterApply !== mappingCountBeforeApply + 1) {
      fail("application creates mapping for published requisition");
    } else {
      pass("application creates mapping for published requisition");
    }

    const applicationsBeforeUnpublish =
      await recruitmentService.listCandidatePortalApplications(
        pool,
        { candidate_id: candidateId }
      );
    const hasApplicationBeforeUnpublish = applicationsBeforeUnpublish.some(
      (row) => row.requisition_code === testRequisitionCode
    );

    if (!hasApplicationBeforeUnpublish) {
      fail("existing application visible before unpublish");
    } else {
      pass("existing application visible before unpublish");
    }

    const unpublishResult =
      await recruitmentService.unpublishRequisitionFromCandidatePortal(
        pool,
        testRequisitionCode,
        publisherReq
      );

    if (unpublishResult.requisition?.candidate_portal_published) {
      fail("unpublish clears candidate_portal_published");
    } else {
      pass("unpublish clears candidate_portal_published");
    }

    const unpublishedAfter =
      await recruitmentService.listOpenRequisitionsForCandidatePortal(pool);
    if (unpublishedAfter.some((row) => row.requisition_code === testRequisitionCode)) {
      fail("unpublish removes requisition from portal service list");
    } else {
      pass("unpublish removes requisition from portal service list");
    }

    try {
      await recruitmentService.applyCandidateFromPortal(
        pool,
        { candidate_id: candidateId, full_name: "Portal Publication Candidate", email_id: `portal.publication.${uniqueSuffix}@example.com` },
        { requisition_code: testRequisitionCode }
      );
      fail("unpublish blocks new application");
    } catch (error) {
      if (error.status === 404 || error.status === 409 || error.status === 400) {
        pass("unpublish blocks new application");
      } else {
        fail("unpublish blocks new application", error.message);
      }
    }

    const mappingCountAfterUnpublish = await countMappingsForRequisition(
      testRequisitionCode
    );
    if (mappingCountAfterUnpublish !== mappingCountAfterApply) {
      fail("existing mappings unchanged after unpublish");
    } else {
      pass("existing mappings unchanged after unpublish");
    }

    const applicationsAfterUnpublish =
      await recruitmentService.listCandidatePortalApplications(
        pool,
        { candidate_id: candidateId }
      );
    if (!applicationsAfterUnpublish.some(
      (row) => row.requisition_code === testRequisitionCode
    )) {
      fail("existing application remains visible after unpublish");
    } else {
      pass("existing application remains visible after unpublish");
    }

    const idempotentUnpublish =
      await recruitmentService.unpublishRequisitionFromCandidatePortal(
        pool,
        testRequisitionCode,
        publisherReq
      );
    if (!idempotentUnpublish.alreadyUnpublished) {
      fail("unpublish is idempotent");
    } else {
      pass("unpublish is idempotent");
    }

    const publisherToken = signEmployeeToken(publisherUser);
    const publishHttp = await fetchJson(
      `/api/v1/recruitment/requisitions/${encodeURIComponent(testRequisitionCode)}/publish-to-candidate-portal`,
      publisherToken,
      { method: "POST" }
    );

    const publishRouteMissing =
      publishHttp.response.status === 404 &&
      /cannot post/i.test(String(publishHttp.rawText || publishHttp.body.message || ""));

    if (publishRouteMissing) {
      skip("http publish route", "backend route not loaded — restart backend and rerun");
      skip("http portal listing after publish", "backend route not loaded");
    } else if (!publishHttp.response.ok) {
      fail("http publish route", publishHttp.body.message || publishHttp.response.status);
    } else {
      pass("http publish route");

      const republishHttp = await fetchJson(
        `/api/v1/recruitment/requisitions/${encodeURIComponent(testRequisitionCode)}/publish-to-candidate-portal`,
        publisherToken,
        { method: "POST" }
      );

      if (!republishHttp.response.ok) {
        fail("http publish route is idempotent", republishHttp.body.message || republishHttp.response.status);
      } else {
        pass("http publish route is idempotent");
      }

      const portalListHttp = await fetchJson(
        "/candidate-portal/open-requisitions",
        portalCandidate.token
      );

      if (!portalListHttp.response.ok) {
        fail("http portal listing after publish", portalListHttp.body.message || portalListHttp.response.status);
      } else {
        const requisitions = portalListHttp.body.data?.requisitions || [];
        if (!requisitions.some((row) => row.requisition_code === testRequisitionCode)) {
          fail("http portal listing includes published requisition");
        } else {
          pass("http portal listing includes published requisition");
        }

        for (const field of [
          "candidate_portal_published_at",
          "candidate_portal_published_by"
        ]) {
          if (requisitions.some((row) => Object.prototype.hasOwnProperty.call(row, field))) {
            fail(`portal response excludes ${field}`);
          }
        }
        pass("portal response excludes publication fields");
      }
    }
  } finally {
    try {
      if (testRequisitionCode) {
        await pool.query(
          `UPDATE rm_requisitions
           SET candidate_portal_published_at = NULL,
               candidate_portal_published_by = NULL
           WHERE requisition_code = $1`,
          [testRequisitionCode]
        );
      }

      await cleanupPortalCandidate(candidateId);
      pass("verification cleanup completed");
    } catch (cleanupError) {
      fail("verification cleanup completed", cleanupError.message);
    }

    console.log("Candidate Portal publication verification finished.");
    await pool.end();
  }
}

main().catch((error) => {
  fail("unexpected error", error.message);
});
