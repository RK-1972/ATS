/**
 * Candidate Portal canonical cand_mstr flow verification.
 * Run: node scripts/verifyCandidatePortalCanonicalFlow.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const {
  createCandidatePortalProfileService
} = require("../services/candidatePortalProfileService");
const recruitmentService = require("../services/recruitmentService");

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

function buildMinimalPdfBuffer() {
  return Buffer.from(
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj
4 0 obj<</Length 120>>stream
BT /F1 12 Tf 72 720 Td (Canonical Flow Candidate) Tj 0 -20 Td (Email: canonical.flow@example.com) Tj 0 -20 Td (Mobile: 9876543210) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000101 00000 n 
0000000204 00000 n 
trailer<</Size 5/Root 1 0 R>>
startxref
320
%%EOF`,
    "utf8"
  );
}

async function cleanup(candidateId, emailId) {
  await pool.query(
    `DELETE FROM rm_pipeline_history
     WHERE candidate_id = $1`,
    [candidateId]
  );
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
    `DELETE FROM rm_candidate_intake
     WHERE source_reference = $1`,
    [`portal-candidate:${candidateId}`]
  );
  await pool.query(
    `DELETE FROM candidate_portal_account
     WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM cand_mstr
     WHERE candidate_id = $1 OR LOWER(email_id) = LOWER($2)`,
    [candidateId, emailId]
  );
}

async function findOpenRequisition(candidateId) {
  const result = await pool.query(
    `SELECT r.requisition_code
     FROM rm_requisitions r
     WHERE r.req_status = $1
       AND r.candidate_portal_published_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM rm_candidate_mappings m
         WHERE m.candidate_id = $2
           AND m.requisition_code = r.requisition_code
       )
     ORDER BY r.created_on DESC
     LIMIT 1`,
    [REQUISITION_STATUS.APPROVED, candidateId]
  );

  return result.rows[0]?.requisition_code || null;
}

async function main() {
  const uniqueSuffix = Date.now();
  const emailId = `portal.canonical.${uniqueSuffix}@example.com`;
  const password = "TestPass1!";

  const portalService = createCandidatePortalService(pool);
  const profileService = createCandidatePortalProfileService(pool, {
    uploadResumeToStorage: async () => `portal-canonical/${uniqueSuffix}.pdf`,
    downloadResumeFromStorage: async () => buildMinimalPdfBuffer(),
    extractPdfText: async () =>
      "Canonical Flow Candidate\nEmail: canonical.flow@example.com\nMobile: 9876543210\nSkills: Java\nExperience: 4 years",
    parseBasicCandidateInfo: () => ({
      candidate_name: "Canonical Flow Candidate",
      email: emailId,
      mobile: "9876543210",
      experience: "4",
      skills: ["Java"]
    }),
    splitCandidateName: (name) => {
      const parts = String(name || "").trim().split(/\s+/);
      return {
        first_name: parts[0] || "",
        last_name: parts.slice(1).join(" ")
      };
    },
    normalizeExperience: (value) => Number(String(value || "").match(/\d+/)?.[0] || 0),
    markIntakeParsingFailed: async () => {}
  });

  let candidateId = null;

  try {
    const registerResult = await portalService.registerCandidateAccount({
      full_name: "Canonical Flow Candidate",
      mobile_number: "9876502222",
      email_id: emailId,
      password,
      confirm_password: password
    });

    if (!registerResult.ok) {
      fail("portal registration succeeds", registerResult.message);
      await pool.end();
      return;
    }

    candidateId = registerResult.data.account.candidate_id;

    const afterRegisterCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE LOWER(email_id) = LOWER($1)`,
      [emailId]
    );

    if (afterRegisterCount.rows[0]?.total !== 1) {
      fail(
        "portal registration creates exactly one cand_mstr",
        String(afterRegisterCount.rows[0]?.total)
      );
    } else {
      pass("portal registration creates exactly one cand_mstr");
    }

    const sourceCheck = await pool.query(
      `SELECT candidate_source_code FROM cand_mstr WHERE candidate_id = $1`,
      [candidateId]
    );

    if (sourceCheck.rows[0]?.candidate_source_code !== "PORTAL") {
      fail(
        "portal candidate preserves candidate_source_code PORTAL",
        sourceCheck.rows[0]?.candidate_source_code
      );
    } else {
      pass("portal candidate preserves candidate_source_code PORTAL");
    }

    const intakeResult = await profileService.createProfileIntake(candidateId);
    const intakeId = intakeResult.data?.intake_id;

    await profileService.processProfileIntake(
      candidateId,
      intakeId,
      { originalname: "canonical-flow.pdf", buffer: buildMinimalPdfBuffer() }
    );
    await profileService.parseProfileIntake(candidateId, intakeId);
    await profileService.saveCandidateProfile(candidateId, {
      first_name: "Canonical",
      last_name: "Flow",
      email: emailId,
      mobile: "9876502222",
      skills: "Java",
      experience: "4"
    });

    const afterProfile = await pool.query(
      `SELECT candidate_id, resume_path
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [candidateId]
    );

    if (Number(afterProfile.rows[0]?.candidate_id) !== Number(candidateId)) {
      fail("profile and resume update the same candidate");
    } else if (!afterProfile.rows[0]?.resume_path) {
      fail("parsed resume updates the same cand_mstr row");
    } else {
      pass("profile and parsed resume update the same cand_mstr row");
    }

    const afterProfileCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE LOWER(email_id) = LOWER($1)`,
      [emailId]
    );

    if (afterProfileCount.rows[0]?.total !== 1) {
      fail(
        "profile flow does not create a second cand_mstr",
        String(afterProfileCount.rows[0]?.total)
      );
    } else {
      pass("profile flow does not create a second cand_mstr");
    }

    const requisitionCode = await findOpenRequisition(candidateId);

    if (!requisitionCode) {
      fail("open published requisition available for apply test");
      await cleanup(candidateId, emailId);
      await pool.end();
      return;
    }

    const applyResult = await recruitmentService.applyCandidateFromPortal(
      pool,
      {
        candidate_id: candidateId,
        email_id: emailId,
        full_name: "Canonical Flow Candidate"
      },
      { requisition_code: requisitionCode }
    );

    if (!applyResult?.requisition_code) {
      fail("portal apply succeeds");
    } else {
      pass("portal apply succeeds");
    }

    const afterApplyCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE LOWER(email_id) = LOWER($1)`,
      [emailId]
    );

    if (afterApplyCount.rows[0]?.total !== 1) {
      fail(
        "apply creates no second cand_mstr",
        String(afterApplyCount.rows[0]?.total)
      );
    } else {
      pass("apply creates no second cand_mstr");
    }

    const mappingCheck = await pool.query(
      `SELECT candidate_id
       FROM rm_candidate_mappings
       WHERE candidate_id = $1
         AND requisition_code = $2
       LIMIT 1`,
      [candidateId, requisitionCode]
    );

    if (Number(mappingCheck.rows[0]?.candidate_id) !== Number(candidateId)) {
      fail("apply uses the same candidate_id on rm_candidate_mappings");
    } else {
      pass("apply uses the same candidate_id on rm_candidate_mappings");
    }

    const ownerCheck = await pool.query(
      `SELECT owner_employee_code, candidate_container
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [candidateId]
    );

    if (ownerCheck.rows[0]?.owner_employee_code) {
      fail(
        "apply does not auto-assign recruiter ownership",
        ownerCheck.rows[0].owner_employee_code
      );
    } else {
      pass("apply does not auto-assign recruiter ownership");
    }
  } catch (error) {
    fail("unexpected error", error.message);
  } finally {
    if (candidateId) {
      await cleanup(candidateId, emailId);
    }
    console.log("Candidate portal canonical flow verification finished.");
    await pool.end();
  }
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
