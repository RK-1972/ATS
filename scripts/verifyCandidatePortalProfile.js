require("dotenv").config();

const { Pool } = require("pg");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const {
  createCandidatePortalProfileService,
  calculateProfileCompletion
} = require("../services/candidatePortalProfileService");

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

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return result.rowCount > 0;
}

async function main() {
  if (!(await tableExists("rm_candidate_intake"))) {
    fail("rm_candidate_intake table exists");
    await pool.end();
    return;
  }

  pass("rm_candidate_intake table exists");

  const portalService = createCandidatePortalService(pool);
  const uniqueSuffix = Date.now();
  const emailId = `portal.phase2.${uniqueSuffix}@example.com`;
  const password = "TestPass1!";

  const registerResult = await portalService.registerCandidateAccount({
    full_name: "Phase Two Candidate",
    mobile_number: "9876501234",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    fail("register portal account for profile test", registerResult.message);
    await pool.end();
    return;
  }

  pass("register portal account for profile test");

  const candidateId = registerResult.data.account.candidate_id;

  const profileService = createCandidatePortalProfileService(pool, {
    uploadResumeToStorage: async () => "portal-test/resume.pdf",
    downloadResumeFromStorage: async () => Buffer.from(""),
    extractPdfText: async () =>
      "John Doe\nEmail: john@example.com\nMobile: 9999999999\nSkills: Java, SQL\nExperience: 5 years",
    parseBasicCandidateInfo: (text) => ({
      candidate_name: "John Doe",
      email: emailId,
      mobile: "9999999999",
      experience: "5",
      skills: ["Java", "SQL"],
      education: "B.Tech"
    }),
    splitCandidateName: (name) => {
      const parts = String(name || "").trim().split(/\s+/);
      return {
        first_name: parts[0] || "",
        last_name: parts.slice(1).join(" ") || ""
      };
    },
    normalizeExperience: (value) => {
      const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
      return match ? Number(match[1]) : null;
    },
    markIntakeParsingFailed: async () => {}
  });

  const intakeResult = await profileService.createProfileIntake(candidateId);

  if (!intakeResult.ok) {
    fail("create profile intake", intakeResult.message);
  } else {
    pass("create profile intake");
  }

  const intakeId = intakeResult.data.intake_id;

  const processResult = await profileService.processProfileIntake(
    candidateId,
    intakeId,
    { originalname: "resume.pdf" }
  );

  if (!processResult.ok) {
    fail("process profile intake", processResult.message);
  } else {
    pass("process profile intake");
  }

  const parseResult = await profileService.parseProfileIntake(
    candidateId,
    intakeId
  );

  if (!parseResult.ok) {
    fail("parse profile intake", parseResult.message);
  } else {
    pass("parse profile intake");
  }

  const afterParse = await pool.query(
    `SELECT candidate_status, resume_path, profile_completion
     FROM cand_mstr WHERE candidate_id = $1`,
    [candidateId]
  );

  if (afterParse.rows[0]?.candidate_status !== "DRAFT") {
    fail("candidate remains DRAFT after parse", afterParse.rows[0]?.candidate_status);
  } else {
    pass("candidate remains DRAFT after parse");
  }

  const saveResult = await profileService.saveCandidateProfile(candidateId, {
    first_name: "Phase",
    last_name: "Two",
    email: emailId,
    mobile: "9876501234",
    current_company: "Optalynx",
    designation: "Engineer",
    experience: 5,
    skills: "Java, SQL"
  });

  if (!saveResult.ok) {
    fail("save candidate profile", saveResult.message);
  } else {
    pass("save candidate profile");
  }

  const afterSave = await pool.query(
    `SELECT candidate_status, profile_completion FROM cand_mstr WHERE candidate_id = $1`,
    [candidateId]
  );

  if (afterSave.rows[0]?.candidate_status !== "DRAFT") {
    fail("candidate remains DRAFT after save", afterSave.rows[0]?.candidate_status);
  } else {
    pass("candidate remains DRAFT after save");
  }

  const intakeReview = await pool.query(
    `SELECT review_status FROM rm_candidate_intake WHERE intake_id = $1`,
    [intakeId]
  );

  if (intakeReview.rows[0]?.review_status !== "SUBMITTED") {
    fail("intake review_status set to SUBMITTED", intakeReview.rows[0]?.review_status);
  } else {
    pass("intake review_status set to SUBMITTED");
  }

  const queue = await profileService.listPortalReviewQueue();
  const inQueue = queue.some((row) => row.candidate_id === candidateId);

  if (!inQueue) {
    fail("candidate appears in portal review queue");
  } else {
    pass("candidate appears in portal review queue");
  }

  if (Number(afterSave.rows[0]?.profile_completion || 0) <= 0) {
    fail("profile completion calculated");
  } else {
    pass("profile completion calculated");
  }

  await pool.query(
    `DELETE FROM rm_candidate_intake WHERE intake_id = $1`,
    [intakeId]
  );
  await pool.query(
    `DELETE FROM candidate_portal_account WHERE candidate_id = $1`,
    [candidateId]
  );
  await pool.query(
    `DELETE FROM cand_mstr WHERE candidate_id = $1`,
    [candidateId]
  );

  pass("phase 2 verification cleanup completed");
  await pool.end();

  if (process.exitCode) {
    console.error("Candidate portal profile verification failed.");
  } else {
    console.log("Candidate portal profile verification passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
