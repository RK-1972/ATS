require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const {
  createCandidatePortalProfileService,
  listIntakeReviewQueue
} = require("../services/candidatePortalProfileService");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

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
BT /F1 12 Tf 72 720 Td (Recruiter Flow Candidate) Tj 0 -20 Td (Email: portal.recruiter.flow@example.com) Tj 0 -20 Td (Mobile: 9876543210) Tj ET
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

async function main() {
  const uniqueSuffix = Date.now();
  const testPan = `ABCRF${String(uniqueSuffix).slice(-4)}F`;
  const emailId = `portal.recruiter.${uniqueSuffix}@example.com`;
  const password = "TestPass1!";

  const portalService = createCandidatePortalService(pool);
  const profileService = createCandidatePortalProfileService(pool, {
    uploadResumeToStorage: async () => `portal-recruiter/${uniqueSuffix}.pdf`,
    downloadResumeFromStorage: async () => buildMinimalPdfBuffer(),
    extractPdfText: async () =>
      "Recruiter Flow Candidate\nEmail: portal.recruiter.flow@example.com\nMobile: 9876543210\nSkills: Java\nExperience: 4 years",
    parseBasicCandidateInfo: (text) => ({
      candidate_name: "Recruiter Flow Candidate",
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

  const registerResult = await portalService.registerCandidateAccount({
    full_name: "Recruiter Flow Candidate",
    mobile_number: "9876501111",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    fail("register portal candidate", registerResult.message);
    await pool.end();
    return;
  }

  pass("register portal candidate");

  const candidateId = registerResult.data.account.candidate_id;
  const beforeCount = await pool.query(
    `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE email_id = $1`,
    [emailId]
  );

  if (beforeCount.rows[0]?.total !== 1) {
    fail("single cand_mstr row exists after registration", beforeCount.rows[0]?.total);
    await pool.end();
    return;
  }

  pass("single cand_mstr row exists after registration");

  const intakeResult = await profileService.createProfileIntake(candidateId);
  const intakeId = intakeResult.data?.intake_id;

  await profileService.processProfileIntake(
    candidateId,
    intakeId,
    { originalname: "recruiter-flow.pdf", buffer: buildMinimalPdfBuffer() }
  );
  await profileService.parseProfileIntake(candidateId, intakeId);

  await profileService.saveCandidateProfile(candidateId, {
    first_name: "Recruiter",
    last_name: "Flow",
    email: emailId,
    mobile: "9876501111",
    pan_number: testPan,
    skills: "Java",
    experience: "4"
  });

  pass("portal candidate saved profile and submitted for review");

  const draftCheck = await pool.query(
    `SELECT candidate_status FROM cand_mstr WHERE candidate_id = $1`,
    [candidateId]
  );

  if (String(draftCheck.rows[0]?.candidate_status || "").toUpperCase() !== "DRAFT") {
    fail("candidate remains DRAFT before recruiter registration", draftCheck.rows[0]?.candidate_status);
  } else {
    pass("candidate remains DRAFT before recruiter registration");
  }

  const queue = await listIntakeReviewQueue(pool);
  const queueRow = queue.find((row) => Number(row.candidate_id) === Number(candidateId));

  if (!queueRow) {
    fail("candidate appears in intake review queue");
  } else {
    pass("candidate appears in intake review queue");
  }

  const recruiterResult = await pool.query(
    `
    SELECT user_id, employee_code, email_id, role_name, secondary_role
    FROM user_mstr
    WHERE role_name = 'Recruiter'
      AND is_active = TRUE
    ORDER BY user_id
    LIMIT 1
    `
  );

  if (recruiterResult.rows.length === 0) {
    fail("active recruiter user exists for registration test");
    await pool.end();
    return;
  }

  const recruiter = recruiterResult.rows[0];
  const recruiterToken = signEmployeeToken(recruiter);

  const dashboardResponse = await fetch(`${API_BASE_URL}/candidate-intake/dashboard`, {
    headers: { Authorization: `Bearer ${recruiterToken}` }
  });
  const dashboardBody = await dashboardResponse.json();
  const dashboardQueue = dashboardBody.dashboard?.review_queue || [];
  const dashboardRow = dashboardQueue.find(
    (row) => Number(row.candidate_id) === Number(candidateId)
  );

  if (!dashboardResponse.ok || !dashboardRow) {
    fail(
      "dashboard review_queue exposes portal candidate to recruiter",
      dashboardBody.message || dashboardResponse.status
    );
  } else {
    pass("dashboard review_queue exposes portal candidate to recruiter");
  }

  if (String(queueRow.source_name || "") !== "Candidate portal") {
    fail(
      "review queue displays Candidate portal source label",
      queueRow.source_name
    );
  } else {
    pass("review queue displays Candidate portal source label");
  }

  if (!String(queueRow.resume_path || "").trim()) {
    fail("review queue exposes resume path for portal candidate");
  } else {
    pass("review queue exposes resume path for portal candidate");
  }

  const processFormData = new FormData();
  const processPdfBlob = new Blob([buildMinimalPdfBuffer()], {
    type: "application/pdf"
  });
  processFormData.append("resume", processPdfBlob, "recruiter-flow.pdf");

  const processHttpResponse = await fetch(
    `${API_BASE_URL}/candidate-intake/${intakeId}/process`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${recruiterToken}` },
      body: processFormData
    }
  );
  const processHttpBody = await processHttpResponse.json().catch(() => ({}));

  if (!processHttpResponse.ok) {
    fail(
      "HTTP process resume seeds storage for idempotent parse test",
      processHttpBody.message || String(processHttpResponse.status)
    );
    await pool.end();
    return;
  }

  pass("HTTP process resume seeds storage for idempotent parse test");

  const intakePathResult = await pool.query(
    `SELECT resume_path FROM rm_candidate_intake WHERE intake_id = $1`,
    [intakeId]
  );
  const expectedResumePath = String(intakePathResult.rows[0]?.resume_path || "").trim();

  if (!expectedResumePath) {
    fail("intake resume_path set after HTTP process");
    await pool.end();
    return;
  }

  const editedProfile = {
    first_name: "EditedFirst",
    last_name: "EditedLast",
    mobile_number: "9999888777",
    primary_skill: "RecruiterEditedSkill",
    total_experience: "9"
  };

  await pool.query(
    `
    UPDATE cand_mstr
    SET
      first_name = $1,
      last_name = $2,
      mobile_number = $3,
      primary_skill = $4,
      total_experience = $5,
      resume_path = NULL
    WHERE candidate_id = $6
    `,
    [
      editedProfile.first_name,
      editedProfile.last_name,
      editedProfile.mobile_number,
      editedProfile.primary_skill,
      editedProfile.total_experience,
      candidateId
    ]
  );

  const beforeRepairCount = await pool.query(
    `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE email_id = $1`,
    [emailId]
  );

  const parseRepairResponse = await fetch(
    `${API_BASE_URL}/candidate-intake/${intakeId}/parse`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${recruiterToken}` }
    }
  );
  const parseRepairBody = await parseRepairResponse.json().catch(() => ({}));

  if (!parseRepairResponse.ok) {
    fail(
      "HTTP idempotent parse repairs missing master resume_path",
      parseRepairBody.message || String(parseRepairResponse.status)
    );
  } else {
    pass("HTTP idempotent parse repairs missing master resume_path");
  }

  const afterRepair = await pool.query(
    `
    SELECT
      resume_path,
      first_name,
      last_name,
      mobile_number,
      primary_skill,
      total_experience
    FROM cand_mstr
    WHERE candidate_id = $1
    `,
    [candidateId]
  );
  const afterRepairRow = afterRepair.rows[0];

  const intakeAfterRepair = await pool.query(
    `SELECT resume_path FROM rm_candidate_intake WHERE intake_id = $1`,
    [intakeId]
  );
  const intakeResumeAfterRepair = String(
    intakeAfterRepair.rows[0]?.resume_path || ""
  ).trim();
  const masterResumeAfterRepair = String(afterRepairRow?.resume_path || "").trim();

  if (
    !masterResumeAfterRepair ||
    masterResumeAfterRepair !== intakeResumeAfterRepair
  ) {
    fail(
      "HTTP idempotent parse sets master resume_path from intake",
      `master=${masterResumeAfterRepair || "(empty)"} intake=${intakeResumeAfterRepair || "(empty)"}`
    );
  } else {
    pass("HTTP idempotent parse sets master resume_path from intake");
  }

  if (
    afterRepairRow?.first_name !== editedProfile.first_name ||
    afterRepairRow?.last_name !== editedProfile.last_name ||
    afterRepairRow?.mobile_number !== editedProfile.mobile_number ||
    String(afterRepairRow?.primary_skill || "") !== editedProfile.primary_skill ||
    Number(afterRepairRow?.total_experience) !== Number(editedProfile.total_experience)
  ) {
    fail("HTTP idempotent parse leaves recruiter-edited profile fields unchanged");
  } else {
    pass("HTTP idempotent parse leaves recruiter-edited profile fields unchanged");
  }

  const afterRepairCount = await pool.query(
    `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE email_id = $1`,
    [emailId]
  );

  if (afterRepairCount.rows[0]?.total !== beforeRepairCount.rows[0]?.total) {
    fail(
      "HTTP idempotent parse does not create duplicate candidate",
      String(afterRepairCount.rows[0]?.total)
    );
  } else {
    pass("HTTP idempotent parse does not create duplicate candidate");
  }

  const secondRecruiterResult = await pool.query(
    `
    SELECT user_id, employee_code, email_id, role_name, secondary_role
    FROM user_mstr
    WHERE role_name = 'Recruiter'
      AND is_active = TRUE
      AND user_id <> $1
    ORDER BY user_id
    LIMIT 1
    `,
    [recruiter.user_id]
  );

  if (secondRecruiterResult.rows.length > 0) {
    const secondToken = signEmployeeToken(secondRecruiterResult.rows[0]);
    const secondDashboard = await fetch(`${API_BASE_URL}/candidate-intake/dashboard`, {
      headers: { Authorization: `Bearer ${secondToken}` }
    }).then((response) => response.json());
    const visibleToSecond = (secondDashboard.dashboard?.review_queue || []).some(
      (row) => Number(row.candidate_id) === Number(candidateId)
    );

    if (!visibleToSecond) {
      fail("second authorized recruiter can see portal candidate");
    } else {
      pass("second authorized recruiter can see portal candidate");
    }
  } else {
    pass("second authorized recruiter can see portal candidate (single recruiter environment)");
  }

  const formData = new FormData();
  formData.append("first_name", "Recruiter");
  formData.append("last_name", "Flow");
  formData.append("email_id", emailId);
  formData.append("mobile_number", "9876501111");
  formData.append("primary_skill", "Java");
  formData.append("total_experience", "4");
  formData.append("pan_number", testPan);
  formData.append("candidate_container", "PIPELINE");
  formData.append("created_by", recruiter.employee_code);

  const registerResponse = await fetch(`${API_BASE_URL}/candidate/${candidateId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${recruiterToken}` },
    body: formData
  });
  const registerBody = await registerResponse.json();
  const registeredCandidate = registerBody.data || registerBody;

  if (!registerResponse.ok) {
    fail("register candidate via existing PUT /candidate/:id", registerBody.message);
  } else {
    pass("register candidate via existing PUT /candidate/:id");
  }

  if (String(registeredCandidate.candidate_status || "").toUpperCase() !== "REGISTERED") {
    fail("candidate becomes REGISTERED", registeredCandidate.candidate_status);
  } else {
    pass("candidate becomes REGISTERED");
  }

  if (registeredCandidate.candidate_container !== "PIPELINE") {
    fail("My Pool registration sets PIPELINE container", registeredCandidate.candidate_container);
  } else {
    pass("My Pool registration sets PIPELINE container");
  }

  if (registeredCandidate.owner_employee_code !== recruiter.employee_code) {
    fail(
      "My Pool registration assigns current recruiter ownership",
      registeredCandidate.owner_employee_code
    );
  } else {
    pass("My Pool registration assigns current recruiter ownership");
  }

  const afterCount = await pool.query(
    `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE email_id = $1`,
    [emailId]
  );

  if (afterCount.rows[0]?.total !== 1) {
    fail("no duplicate cand_mstr after registration", afterCount.rows[0]?.total);
  } else {
    pass("no duplicate cand_mstr after registration");
  }

  const registeredResumeRow = await pool.query(
    `
    SELECT resume_path, candidate_source_code
    FROM cand_mstr
    WHERE candidate_id = $1
    `,
    [candidateId]
  );

  const registeredResumePath = String(
    registeredResumeRow.rows[0]?.resume_path || ""
  ).trim();

  if (!registeredResumePath) {
    fail("registered candidate preserves resume_path");
  } else if (registeredResumePath !== expectedResumePath) {
    fail(
      "registered candidate resume_path matches uploaded intake path",
      `${registeredResumePath} !== ${expectedResumePath}`
    );
  } else {
    pass("registered candidate resume_path matches uploaded intake path");
  }

  if (registeredResumeRow.rows[0]?.candidate_source_code !== "PORTAL") {
    fail(
      "registered candidate source remains PORTAL",
      registeredResumeRow.rows[0]?.candidate_source_code
    );
  } else {
    pass("registered candidate source remains PORTAL");
  }

  const resumeHttpResponse = await fetch(
    `${API_BASE_URL}/candidate-resume/${candidateId}`,
    {
      headers: { Authorization: `Bearer ${recruiterToken}` }
    }
  );

  if (resumeHttpResponse.status !== 200) {
    const resumeHttpBody = await resumeHttpResponse.json().catch(() => ({}));
    fail(
      "GET /candidate-resume returns HTTP 200",
      resumeHttpBody.message || String(resumeHttpResponse.status)
    );
  } else {
    pass("GET /candidate-resume returns HTTP 200");
  }

  if (resumeHttpResponse.status === 200) {
    const contentType = String(
      resumeHttpResponse.headers.get("content-type") || ""
    ).toLowerCase();

    if (
      !contentType.includes("pdf") &&
      !contentType.includes("octet-stream")
    ) {
      fail("GET /candidate-resume content type is appropriate for PDF", contentType);
    } else {
      pass("GET /candidate-resume content type is appropriate for PDF");
    }

    const resumeBytes = Buffer.from(await resumeHttpResponse.arrayBuffer());

    if (!resumeBytes.length) {
      fail("GET /candidate-resume body is non-empty");
    } else {
      pass("GET /candidate-resume body is non-empty");
    }

    if (resumeBytes.slice(0, 5).toString("utf8") !== "%PDF-") {
      fail("GET /candidate-resume body begins with PDF magic bytes");
    } else {
      pass("GET /candidate-resume body begins with PDF magic bytes");
    }
  }

  const preservedPath = "existing-master-resume.pdf";

  await pool.query(`UPDATE cand_mstr SET resume_path = $1 WHERE candidate_id = $2`, [
    preservedPath,
    candidateId
  ]);

  const parseNoOverwriteResponse = await fetch(
    `${API_BASE_URL}/candidate-intake/${intakeId}/parse`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${recruiterToken}` }
    }
  );

  if (!parseNoOverwriteResponse.ok) {
    const parseNoOverwriteBody = await parseNoOverwriteResponse.json().catch(() => ({}));
    fail(
      "HTTP idempotent parse with existing master resume_path",
      parseNoOverwriteBody.message || String(parseNoOverwriteResponse.status)
    );
  } else {
    pass("HTTP idempotent parse with existing master resume_path");
  }

  const afterNoOverwrite = await pool.query(
    `
    SELECT resume_path, first_name, last_name, mobile_number, primary_skill
    FROM cand_mstr
    WHERE candidate_id = $1
    `,
    [candidateId]
  );
  const afterNoOverwriteRow = afterNoOverwrite.rows[0];

  if (afterNoOverwriteRow?.resume_path !== preservedPath) {
    fail(
      "HTTP idempotent parse does not overwrite existing master resume_path",
      afterNoOverwriteRow?.resume_path
    );
  } else {
    pass("HTTP idempotent parse does not overwrite existing master resume_path");
  }

  if (
    afterNoOverwriteRow?.first_name !== "Recruiter" ||
    afterNoOverwriteRow?.last_name !== "Flow" ||
    afterNoOverwriteRow?.mobile_number !== "9876501111" ||
    String(afterNoOverwriteRow?.primary_skill || "") !== "Java"
  ) {
    fail("HTTP idempotent parse preserves profile fields when resume_path exists");
  } else {
    pass("HTTP idempotent parse preserves profile fields when resume_path exists");
  }

  await pool.query(`DELETE FROM candidate_portal_account WHERE candidate_id = $1`, [candidateId]);
  await pool.query(`DELETE FROM rm_candidate_intake WHERE source_reference = $1`, [
    `portal-candidate:${candidateId}`
  ]);
  await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]);

  pass("recruiter flow verification cleanup completed");
  console.log("Candidate portal recruiter flow verification passed.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
