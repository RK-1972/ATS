/**
 * Batch 1 — HTTP + DB verification (locked rules).
 * Run after backend restart on current code.
 */
require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const PORTAL_RESUBMISSION_LABEL = "Updated profile from candidate";
const { listIntakeReviewQueue } = require("../services/candidatePortalProfileService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const results = [];

function pass(id, detail = "") {
  results.push({ id, status: "PASS", detail });
  console.log(`PASS: ${id}${detail ? ` — ${detail}` : ""}`);
}

function fail(id, detail = "") {
  results.push({ id, status: "FAIL", detail });
  console.error(`FAIL: ${id}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function skip(id, detail = "") {
  results.push({ id, status: "SKIP", detail });
  console.log(`SKIP: ${id}${detail ? ` — ${detail}` : ""}`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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

async function getEmployeeToken(roleName = "Recruiter") {
  const userResult = await pool.query(
    `
    SELECT user_id, employee_code, email_id, role_name, secondary_role
    FROM user_mstr
    WHERE role_name = $1
      AND COALESCE(is_active, TRUE) = TRUE
    ORDER BY user_id
    LIMIT 1
    `,
    [roleName]
  );

  if (!userResult.rows[0]) {
    throw new Error(`No active ${roleName} in user_mstr`);
  }

  return {
    token: signEmployeeToken(userResult.rows[0]),
    user: userResult.rows[0]
  };
}

async function httpPortalRegisterAndLogin(emailId, password) {
  const registerResponse = await fetch(`${API_BASE_URL}/candidate-portal/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Batch1 HTTP Test",
      mobile_number: "9876512345",
      email_id: emailId,
      password,
      confirm_password: password
    })
  });
  const registerBody = await readJson(registerResponse);

  if (registerResponse.status !== 201) {
    throw new Error(
      `portal HTTP register: ${registerBody.message || registerResponse.status}`
    );
  }

  const candidateId = Number(
    registerBody.data?.candidate_id || registerBody.data?.account?.candidate_id
  );

  if (!candidateId) {
    throw new Error("portal HTTP register: missing candidate_id");
  }

  pass("HTTP POST /candidate-portal/register (welcome email path)");

  const loginResponse = await fetch(`${API_BASE_URL}/candidate-portal/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email_id: emailId, password })
  });
  const loginBody = await readJson(loginResponse);

  if (!loginResponse.ok || !loginBody.data?.token) {
    throw new Error(`portal login: ${loginBody.message || loginResponse.status}`);
  }

  return {
    portalToken: loginBody.data.token,
    candidateId
  };
}

async function main() {
  const suffix = Date.now();
  const emailId = `batch1.http.${suffix}@example.com`;
  const password = "TestPass1!";
  const panDigits = String(suffix).slice(-4).padStart(4, "0");
  const panA = `BATCH${panDigits}X`;
  const panB = `BATCH${panDigits}Y`;

  const health = await fetch(`${API_BASE_URL}/health-test`);
  if (health.status !== 200) {
    fail("backend health-test", `HTTP ${health.status}`);
    await pool.end();
    return;
  }
  pass("backend reachable (health-test)");

  const { token: recruiterToken, user: recruiter } = await getEmployeeToken(
    "Recruiter"
  );
  const { token: adminToken, user: adminUser } = await getEmployeeToken("Admin");
  pass("recruiter and admin JWT issued");

  // Rule 2/3: REGISTERED POST without PAN
  const noPanForm = new FormData();
  noPanForm.append("first_name", "No");
  noPanForm.append("last_name", "Pan");
  noPanForm.append("email_id", `nopan.${suffix}@example.com`);
  noPanForm.append("mobile_number", "+91 9876543210");
  noPanForm.append("candidate_status", "REGISTERED");
  noPanForm.append("primary_skill", "Java");
  noPanForm.append("total_experience", "3");

  const noPanRes = await fetch(`${API_BASE_URL}/candidate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${recruiterToken}` },
    body: noPanForm
  });
  const noPanBody = await readJson(noPanRes);

  if (noPanRes.status === 400 && /pan/i.test(noPanBody.message || "")) {
    pass("verify #2 missing PAN rejected (POST /candidate REGISTERED)");
  } else {
    fail("verify #2 missing PAN", `${noPanRes.status} ${noPanBody.message}`);
  }

  // Verify #1: valid REGISTERED create (employee API)
  const validForm = new FormData();
  validForm.append("first_name", "Valid");
  validForm.append("last_name", "Reg");
  validForm.append("email_id", `valid.reg.${suffix}@example.com`);
  validForm.append("mobile_number", "+91 9876543200");
  validForm.append("pan_number", panB);
  validForm.append("candidate_status", "REGISTERED");
  validForm.append("primary_skill", "Java");
  validForm.append("total_experience", "2");

  const validRes = await fetch(`${API_BASE_URL}/candidate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: validForm
  });
  const validBody = await readJson(validRes);
  const validCandidateId = validBody.data?.candidate_id;

  if (validRes.status === 201 && validCandidateId && String(validBody.data?.pan_number || "").toUpperCase() === panB) {
    pass("verify #1 valid REGISTERED candidate with PAN succeeds");
  } else {
    fail("verify #1 valid REGISTERED", `${validRes.status} ${validBody.message}`);
  }

  // Verify #3: invalid PAN format
  const badPanForm = new FormData();
  badPanForm.append("first_name", "Bad");
  badPanForm.append("last_name", "Pan");
  badPanForm.append("email_id", `badpan.${suffix}@example.com`);
  badPanForm.append("mobile_number", "+91 9876543211");
  badPanForm.append("pan_number", "ABC1234");
  badPanForm.append("candidate_status", "REGISTERED");
  badPanForm.append("primary_skill", "Java");

  const badPanRes = await fetch(`${API_BASE_URL}/candidate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${recruiterToken}` },
    body: badPanForm
  });
  const badPanBody = await readJson(badPanRes);

  if (badPanRes.status === 400 && /invalid pan/i.test(badPanBody.message || "")) {
    pass("verify #3 invalid PAN rejected");
  } else {
    fail("verify #3 invalid PAN", `${badPanRes.status} ${badPanBody.message}`);
  }

  const { portalToken, candidateId: portalCandidateId } =
    await httpPortalRegisterAndLogin(emailId, password);

  const saveNoPanRes = await fetch(`${API_BASE_URL}/candidate-portal/profile`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${portalToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      first_name: "Batch",
      last_name: "One",
      email: emailId,
      mobile: "9876512345",
      skills: "Java"
    })
  });
  const saveNoPanBody = await readJson(saveNoPanRes);

  if (
    saveNoPanRes.status === 400 &&
    (saveNoPanBody.errors?.pan_number || /pan/i.test(saveNoPanBody.message || ""))
  ) {
    pass("verify #2 missing PAN rejected (portal profile save)");
  } else {
    fail(
      "rule 2 portal profile save requires PAN",
      `${saveNoPanRes.status} ${JSON.stringify(saveNoPanBody).slice(0, 200)}`
    );
  }

  const savePanRes = await fetch(`${API_BASE_URL}/candidate-portal/profile`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${portalToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      first_name: "Batch",
      last_name: "One",
      email: emailId,
      mobile: "9876512345",
      skills: "Java",
      pan_number: panA.toLowerCase()
    })
  });
  const savePanBody = await readJson(savePanRes);

  if (!savePanRes.ok) {
    fail("portal save with valid PAN", savePanBody.message);
  } else {
    pass("portal DRAFT save with PAN normalization");
  }

  const panRow = await pool.query(
    `SELECT pan_number FROM cand_mstr WHERE candidate_id = $1`,
    [portalCandidateId]
  );
  const storedPan = String(panRow.rows[0]?.pan_number || "").trim();

  if (storedPan === panA.toUpperCase()) {
    pass("PAN stored uppercase normalized");
  } else {
    fail("PAN normalization storage", `expected ${panA.toUpperCase()} got ${storedPan}`);
  }

  // Register via PUT (DRAFT -> REGISTERED)
  const regForm = new FormData();
  regForm.append("first_name", "Batch");
  regForm.append("last_name", "One");
  regForm.append("email_id", emailId);
  regForm.append("mobile_number", "9876512345");
  regForm.append("pan_number", panA);
  regForm.append("primary_skill", "Java");
  regForm.append("total_experience", "4");
  regForm.append("candidate_container", "PIPELINE");
  regForm.append("created_by", adminUser.employee_code);

  const resubmitOnDraftRes = await fetch(`${API_BASE_URL}/candidate-portal/profile`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${portalToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      resubmit: true,
      first_name: "Batch",
      last_name: "DraftOnly",
      email: emailId,
      mobile: "9876512345",
      skills: "Java",
      pan_number: panB
    })
  });
  const resubmitOnDraftBody = await readJson(resubmitOnDraftRes);

  if (resubmitOnDraftRes.status === 409) {
    pass("verify #6 non-REGISTERED resubmit rejected");
  } else {
    fail(
      "resubmit:true on DRAFT must not update PAN",
      `${resubmitOnDraftRes.status} ${resubmitOnDraftBody.message}`
    );
  }

  const panBeforeReg = await pool.query(
    `SELECT pan_number FROM cand_mstr WHERE candidate_id = $1`,
    [portalCandidateId]
  );

  const mappingBefore = await pool.query(
    `SELECT COUNT(*)::int AS n FROM candidate_req_map WHERE candidate_id = $1`,
    [portalCandidateId]
  );
  const ownerBefore = await pool.query(
    `SELECT owner_employee_code FROM cand_mstr WHERE candidate_id = $1`,
    [portalCandidateId]
  );

  const regRes = await fetch(`${API_BASE_URL}/candidate/${portalCandidateId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: regForm
  });
  const regBody = await readJson(regRes);
  const registered = regBody.data || regBody;

  if (!regRes.ok || String(registered.candidate_status || "").toUpperCase() !== "REGISTERED") {
    fail("DRAFT to REGISTERED via PUT", regBody.message || registered.candidate_status);
  } else {
    pass("valid registration DRAFT to REGISTERED");
  }

  const ownerAfterReg = registered.owner_employee_code;

  const dupForm = new FormData();
  dupForm.append("first_name", "Dup");
  dupForm.append("last_name", "Lic");
  dupForm.append("email_id", `dup.${suffix}@example.com`);
  dupForm.append("mobile_number", "+91 9876543299");
  dupForm.append("pan_number", panA);
  dupForm.append("candidate_status", "REGISTERED");
  dupForm.append("primary_skill", "Java");
  dupForm.append("total_experience", "2");

  const countBeforeDup = await pool.query(`SELECT COUNT(*)::int AS n FROM cand_mstr`);

  const dupRes = await fetch(`${API_BASE_URL}/candidate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: dupForm
  });
  const dupBody = await readJson(dupRes);
  const countAfterDup = await pool.query(`SELECT COUNT(*)::int AS n FROM cand_mstr`);

  if (
    dupRes.status === 409 &&
    /already exists/i.test(dupBody.message || "") &&
    countAfterDup.rows[0].n === countBeforeDup.rows[0].n
  ) {
    pass("verify #4 duplicate REGISTERED PAN returns 409, no new cand_mstr");
  } else {
    fail(
      "rule 6 duplicate PAN",
      `${dupRes.status} ${dupBody.message} countDelta=${countAfterDup.rows[0].n - countBeforeDup.rows[0].n}`
    );
  }

  // Rule 5: PAN change after REGISTERED
  const changePanForm = new FormData();
  changePanForm.append("pan_number", panB);

  const changePanRes = await fetch(`${API_BASE_URL}/candidate/${portalCandidateId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${adminToken}` },
    body: changePanForm
  });
  const changePanBody = await readJson(changePanRes);

  if (
    changePanRes.status === 400 &&
    /cannot be changed/i.test(changePanBody.message || "")
  ) {
    pass("verify #5 registered PAN change rejected");
  } else {
    fail("rule 5 PAN immutability", `${changePanRes.status} ${changePanBody.message}`);
  }

  const panAfterChange = await pool.query(
    `SELECT pan_number FROM cand_mstr WHERE candidate_id = $1`,
    [portalCandidateId]
  );

  if (String(panAfterChange.rows[0]?.pan_number || "") === storedPan) {
    pass("rule 5 original PAN preserved in DB");
  } else {
    fail("rule 5 PAN preserved", panAfterChange.rows[0]?.pan_number);
  }

  // Rule 7/8/9: portal resubmit same ID + label + ownership
  const resubmitRes = await fetch(`${API_BASE_URL}/candidate-portal/profile`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${portalToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      resubmit: true,
      first_name: "Batch",
      last_name: "Updated",
      email: emailId,
      mobile: "9876512345",
      skills: "Java, SQL",
      experience: "5"
    })
  });
  const resubmitBody = await readJson(resubmitRes);

  if (!resubmitRes.ok) {
    fail("portal resubmit", resubmitBody.message || JSON.stringify(resubmitBody.errors));
  } else {
    pass("portal resubmit HTTP 200");
  }

  const afterResubmit = await pool.query(
    `
    SELECT candidate_id, owner_employee_code, first_name, pan_number
    FROM cand_mstr WHERE candidate_id = $1
    `,
    [portalCandidateId]
  );

  if (Number(afterResubmit.rows[0]?.candidate_id) === Number(portalCandidateId)) {
    pass("verify #7 resubmit keeps same candidate_id");
  } else {
    fail("rule 7 same candidate_id");
  }

  const mappingAfter = await pool.query(
    `SELECT COUNT(*)::int AS n FROM candidate_req_map WHERE candidate_id = $1`,
    [portalCandidateId]
  );

  if (afterResubmit.rows[0]?.owner_employee_code === ownerAfterReg) {
    pass("verify #9 ownership unchanged after resubmit");
  } else {
    fail(
      "rule 9 ownership",
      `${ownerAfterReg} -> ${afterResubmit.rows[0]?.owner_employee_code}`
    );
  }

  if (String(afterResubmit.rows[0]?.pan_number || "") === storedPan) {
    pass("rule 5 portal resubmit did not change PAN");
  } else {
    fail("rule 5 portal resubmit PAN", afterResubmit.rows[0]?.pan_number);
  }

  const dashRes = await fetch(`${API_BASE_URL}/candidate-intake/dashboard`, {
    headers: { Authorization: `Bearer ${recruiterToken}` }
  });
  const dashBody = await readJson(dashRes);
  const dashQueueRow = (dashBody.dashboard?.review_queue || []).find(
    (row) => Number(row.candidate_id) === Number(portalCandidateId)
  );
  const dbQueue = await listIntakeReviewQueue(pool);
  const dbQueueRow = dbQueue.find(
    (row) => Number(row.candidate_id) === Number(portalCandidateId)
  );

  if (dbQueueRow?.submission_label === PORTAL_RESUBMISSION_LABEL) {
    pass('verify #8 submission_label "Updated profile from candidate" (DB queue)');
  } else {
    fail(
      "verify #8 submission_label",
      dbQueueRow?.submission_label || "not in listIntakeReviewQueue"
    );
  }

  if (dashQueueRow?.submission_label === PORTAL_RESUBMISSION_LABEL) {
    pass("verify #8 submission_label on candidate-intake/dashboard");
  } else if (!dashQueueRow) {
    fail("verify #8 dashboard review_queue row", "candidate missing from HTTP dashboard queue");
  } else {
    fail("verify #8 dashboard submission_label", dashQueueRow.submission_label);
  }

  const auditRes = await pool.query(
    `
    SELECT action, metadata
    FROM md_enterprise_audit
    WHERE entity = 'cand_mstr'
      AND entity_id = $1
      AND action = $2
    ORDER BY audit_id DESC
    LIMIT 1
    `,
    [String(portalCandidateId), PORTAL_RESUBMISSION_LABEL]
  );

  if (auditRes.rows[0]) {
    pass("verify #9 audit preserved for resubmit");
  } else {
    fail("verify #9 audit for resubmit", "not found");
  }

  if (mappingAfter.rows[0].n === mappingBefore.rows[0].n) {
    pass("verify #9 requisition mappings unchanged");
  } else {
    fail(
      "verify #9 mappings",
      `${mappingBefore.rows[0].n} -> ${mappingAfter.rows[0].n}`
    );
  }

  // Verify #10: unique index present
  const idx = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_cand_mstr_registered_pan_upper'`
  );
  if (idx.rows.length) {
    pass("verify #10 partial unique PAN index present");
  } else {
    fail("verify #10 DB unique index missing");
  }

  const dupPanGroups = await pool.query(
    `
    SELECT UPPER(TRIM(pan_number)) AS pan_key, COUNT(*)::int AS cnt
    FROM cand_mstr
    WHERE UPPER(TRIM(candidate_status)) = 'REGISTERED'
      AND pan_number IS NOT NULL AND TRIM(pan_number) <> ''
    GROUP BY UPPER(TRIM(pan_number))
    HAVING COUNT(*) > 1
    `
  );

  if (dupPanGroups.rows.length === 0) {
    pass("verify #10 no duplicate REGISTERED PAN in data");
  } else {
    fail("verify #10 duplicate PAN groups", JSON.stringify(dupPanGroups.rows));
  }

  // Cleanup test candidate
  await pool.query(`DELETE FROM md_enterprise_audit WHERE entity_id = $1`, [
    String(portalCandidateId)
  ]);
  await pool.query(`DELETE FROM candidate_portal_account WHERE candidate_id = $1`, [
    portalCandidateId
  ]);
  await pool.query(
    `DELETE FROM rm_candidate_intake WHERE source_reference LIKE $1`,
    [`portal-candidate:${portalCandidateId}%`]
  );
  await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [portalCandidateId]);
  if (validCandidateId) {
    await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [
      validCandidateId
    ]);
  }

  console.log("\n=== Batch 1 HTTP E2E summary ===");
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`Total: ${results.length}, FAIL: ${failed}`);
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected", error.message);
  await pool.end();
  process.exit(1);
});
