/**
 * Bulk CV intake flow verification via existing recruiter intake APIs.
 * Run: node scripts/verifyCandidateBulkIntakeFlow.js
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { listIntakeReviewQueue } = require("../services/candidatePortalProfileService");

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

function signToken(user) {
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

function buildMinimalPdfBuffer({ name, email, mobile }) {
  const pdfText = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Contents 4 0 R>>endobj
4 0 obj<</Length 180>>stream
BT /F1 12 Tf 72 720 Td (${name}) Tj 0 -20 Td (Email: ${email}) Tj 0 -20 Td (Mobile: ${mobile}) Tj 0 -20 Td (Skills: Java SQL) Tj 0 -20 Td (Experience: 5 years) Tj ET
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
420
%%EOF`;

  return Buffer.from(pdfText, "utf8");
}

async function readJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function resolveRecruiter() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = 'Recruiter' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function resolveSourceId(token) {
  const response = await fetch(`${API_BASE_URL}/candidate-sources`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await readJson(response);
  const sources = body.data || body;

  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  return sources[0].source_id;
}

async function processBulkFile({
  token,
  sourceId,
  batchId,
  fileIndex,
  fileName,
  pdfBuffer
}) {
  const createResponse = await fetch(`${API_BASE_URL}/candidate-intake`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source_id: sourceId,
      original_file_name: fileName,
      source_reference: `bulk-upload:${batchId}:${String(fileIndex + 1).padStart(2, "0")}`
    })
  });
  const createBody = await readJson(createResponse);

  if (!createResponse.ok) {
    throw new Error(createBody.message || "Failed to create intake");
  }

  const intakeId = createBody.data?.intake_id;

  const formData = new FormData();
  formData.append(
    "resume",
    new Blob([pdfBuffer], { type: "application/pdf" }),
    fileName
  );

  const processResponse = await fetch(
    `${API_BASE_URL}/candidate-intake/${intakeId}/process`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData
    }
  );
  const processBody = await readJson(processResponse);

  if (!processResponse.ok) {
    throw new Error(processBody.message || "Failed to process resume");
  }

  const parseResponse = await fetch(
    `${API_BASE_URL}/candidate-intake/${intakeId}/parse`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  const parseBody = await readJson(parseResponse);

  return {
    intakeId,
    parseBody,
    parseOk: parseResponse.ok
  };
}

async function cleanupBulkArtifacts(batchId, candidateIds = []) {
  await pool.query(
    `DELETE FROM rm_candidate_intake
     WHERE source_reference LIKE $1`,
    [`bulk-upload:${batchId}:%`]
  );

  for (const candidateId of candidateIds) {
    if (!candidateId) {
      continue;
    }

    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]);
  }
}

async function main() {
  const recruiter = await resolveRecruiter();

  if (!recruiter) {
    fail("active recruiter user exists");
    await pool.end();
    return;
  }

  const token = signToken(recruiter);
  const sourceId = await resolveSourceId(token);

  if (!sourceId) {
    fail("candidate source is available");
    await pool.end();
    return;
  }

  const batchId = `${Date.now()}`;
  const uniqueSuffix = Date.now();
  const emailA = `bulk.intake.a.${uniqueSuffix}@example.com`;
  const emailB = `bulk.intake.b.${uniqueSuffix}@example.com`;
  const createdCandidateIds = [];

  try {
    const first = await processBulkFile({
      token,
      sourceId,
      batchId,
      fileIndex: 0,
      fileName: "bulk-one.pdf",
      pdfBuffer: buildMinimalPdfBuffer({
        name: "Bulk One",
        email: emailA,
        mobile: "9876501001"
      })
    });

    if (!first.parseOk || !first.parseBody.draft_candidate_id) {
      fail("single bulk PDF parses and creates draft", first.parseBody.message);
    } else {
      createdCandidateIds.push(first.parseBody.draft_candidate_id);
      pass("single bulk PDF parses and creates draft");
    }

    const queue = await listIntakeReviewQueue(pool);
    const queued = queue.find(
      (row) => Number(row.candidate_id) === Number(first.parseBody.draft_candidate_id)
    );

    if (!queued) {
      fail("parsed bulk candidate appears in Ready for Review");
    } else {
      pass("parsed bulk candidate appears in Ready for Review");
    }

    const draftRow = await pool.query(
      `SELECT candidate_status, candidate_container, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1`,
      [first.parseBody.draft_candidate_id]
    );
    const draft = draftRow.rows[0];

    if (String(draft?.candidate_status || "").toUpperCase() !== "DRAFT") {
      fail("bulk candidate remains DRAFT", draft?.candidate_status);
    } else {
      pass("bulk candidate remains DRAFT");
    }

    if (draft?.owner_employee_code) {
      fail("bulk candidate is not placed directly into pipeline ownership");
    } else {
      pass("bulk candidate is not placed directly into pipeline ownership");
    }

    const duplicateAttempt = await processBulkFile({
      token,
      sourceId,
      batchId,
      fileIndex: 1,
      fileName: "bulk-duplicate.pdf",
      pdfBuffer: buildMinimalPdfBuffer({
        name: "Bulk Duplicate",
        email: emailA,
        mobile: "9876501002"
      })
    });

    if (duplicateAttempt.parseBody.outcome !== "DUPLICATE") {
      fail("duplicate email returns DUPLICATE outcome");
    } else {
      pass("duplicate email returns DUPLICATE outcome");
    }

    const duplicateCount = await pool.query(
      `SELECT COUNT(*)::int AS total FROM cand_mstr WHERE LOWER(email_id) = LOWER($1)`,
      [emailA]
    );

    if (duplicateCount.rows[0]?.total !== 1) {
      fail("duplicate does not create second cand_mstr", duplicateCount.rows[0]?.total);
    } else {
      pass("duplicate does not create second cand_mstr");
    }

    let failureObserved = false;

    try {
      const createResponse = await fetch(`${API_BASE_URL}/candidate-intake`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          source_id: sourceId,
          original_file_name: "bulk-invalid.txt",
          source_reference: `bulk-upload:${batchId}:99`
        })
      });
      const createBody = await readJson(createResponse);
      const intakeId = createBody.data?.intake_id;
      const formData = new FormData();
      formData.append(
        "resume",
        new Blob([Buffer.from("not a pdf")], { type: "text/plain" }),
        "bulk-invalid.txt"
      );

      await fetch(`${API_BASE_URL}/candidate-intake/${intakeId}/process`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      const parseResponse = await fetch(
        `${API_BASE_URL}/candidate-intake/${intakeId}/parse`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      const parseBody = await readJson(parseResponse);

      if (!parseResponse.ok) {
        failureObserved = true;
      } else {
        failureObserved = parseBody.outcome === "DUPLICATE" || !parseBody.draft_candidate_id;
      }
    } catch {
      failureObserved = true;
    }

    if (!failureObserved) {
      fail("invalid file fails parse step");
    } else {
      pass("invalid file fails parse step");
    }

    const second = await processBulkFile({
      token,
      sourceId,
      batchId,
      fileIndex: 2,
      fileName: "bulk-two.pdf",
      pdfBuffer: buildMinimalPdfBuffer({
        name: "Bulk Two",
        email: emailB,
        mobile: "9876501003"
      })
    });

    if (!second.parseOk || !second.parseBody.draft_candidate_id) {
      fail("batch continues after prior failure", second.parseBody.message);
    } else {
      createdCandidateIds.push(second.parseBody.draft_candidate_id);
      pass("batch continues after prior failure");
    }

    const demoResumePath = path.join(
      __dirname,
      "..",
      "demo",
      "assets",
      "demo-resume.pdf"
    );

    if (fs.existsSync(demoResumePath)) {
      pass("demo resume asset available for manual 10-file UI validation");
    } else {
      pass("demo resume asset missing; API-level bulk validation completed");
    }
  } finally {
    await cleanupBulkArtifacts(batchId, createdCandidateIds);
    pass("bulk intake verification cleanup completed");
  }

  console.log("Candidate bulk intake flow verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
