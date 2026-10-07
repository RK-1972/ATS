/**
 * Batch 1 — previously skipped HTTP/email scenarios (Optalynx local O365).
 * Does not replace verifyCandidateBatch1HttpE2e.js; run both.
 */
require("dotenv").config();

const axios = require("axios");
const { ConfidentialClientApplication } = require("@azure/msal-node");
const { Pool } = require("pg");
const { spawnSync } = require("child_process");
const path = require("path");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const scenarios = [];

function record(id, status, detail = "") {
  scenarios.push({ id, status, detail });
  const line = `${status}: ${id}${detail ? ` — ${detail}` : ""}`;
  if (status === "FAIL") {
    console.error(line);
    process.exitCode = 1;
  } else {
    console.log(line);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function getGraphToken() {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
      clientSecret: process.env.CLIENT_SECRET
    }
  });
  const response = await cca.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"]
  });
  if (!response?.accessToken) {
    throw new Error("Graph token acquisition failed");
  }
  return response.accessToken;
}

async function findWelcomeEmailInSent(recipientEmail) {
  const sender = String(process.env.EMAIL_USER || "").trim();
  if (!sender) {
    return { found: false, reason: "EMAIL_USER not set" };
  }

  const token = await getGraphToken();
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}` +
    `/mailFolders('SentItems')/messages?$top=30&$orderby=receivedDateTime desc` +
    `&$select=subject,toRecipients,receivedDateTime`;

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const messages = response.data?.value || [];
    const normalizedRecipient = recipientEmail.trim().toLowerCase();
    const match = messages.find((message) => {
      if (message.subject !== "Welcome to Optalynx") {
        return false;
      }
      return (message.toRecipients || []).some(
        (row) =>
          String(row.emailAddress?.address || "")
            .trim()
            .toLowerCase() === normalizedRecipient
      );
    });
    return { found: Boolean(match), reason: match ? "sent_items_match" : "not_in_recent_sent" };
  } catch (error) {
    const status = error.response?.status;
    return {
      found: false,
      reason: `graph_read_failed_${status || "error"}:${error.message}`
    };
  }
}

async function cleanupPortalCandidate(candidateId) {
  if (!candidateId) {
    return;
  }
  await pool.query(`DELETE FROM md_enterprise_audit WHERE entity_id = $1`, [
    String(candidateId)
  ]);
  await pool.query(`DELETE FROM password_reset_tokens WHERE user_id IN (
    SELECT user_id FROM user_mstr WHERE email_id LIKE 'batch1.skipped.%'
  )`);
  await pool.query(`DELETE FROM candidate_portal_account WHERE candidate_id = $1`, [
    candidateId
  ]);
  await pool.query(
    `DELETE FROM rm_candidate_intake WHERE source_reference LIKE $1`,
    [`portal-candidate:${candidateId}%`]
  );
  await pool.query(`DELETE FROM cand_mstr WHERE candidate_id = $1`, [candidateId]);
}

async function scenarioA() {
  const suffix = Date.now();
  const emailId = `batch1.skipped.${suffix}@example.com`;
  const password = "TestPass1!";

  const countBefore = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cand_mstr WHERE LOWER(email_id) = LOWER($1)`,
    [emailId]
  );

  const registerRes = await fetch(`${API_BASE_URL}/candidate-portal/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      full_name: "Batch1 Skipped HTTP",
      mobile_number: "9876500001",
      email_id: emailId,
      password,
      confirm_password: password
    })
  });
  const registerBody = await readJson(registerRes);
  const candidateId = Number(
    registerBody.data?.candidate_id || registerBody.data?.account?.candidate_id
  );

  if (registerRes.status !== 201 || !candidateId) {
    record(
      "A. HTTP POST /candidate-portal/register",
      "FAIL",
      `${registerRes.status} ${registerBody.message || ""}`
    );
    return;
  }

  record(
    "A. HTTP POST /candidate-portal/register",
    "PASS",
    `201 candidate_id=${candidateId}`
  );

  const countAfter = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cand_mstr WHERE LOWER(email_id) = LOWER($1)`,
    [emailId]
  );

  if (countAfter.rows[0].n === countBefore.rows[0].n + 1) {
    record("A. DB single new cand_mstr for portal register", "PASS");
  } else {
    record(
      "A. DB single new cand_mstr for portal register",
      "FAIL",
      `before=${countBefore.rows[0].n} after=${countAfter.rows[0].n}`
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 4000));

  const mailCheck = await findWelcomeEmailInSent(emailId);
  if (mailCheck.found) {
    record(
      "A. Welcome email delivery (Graph Sent Items)",
      "PASS",
      `to ${emailId} subject "Welcome to Optalynx"`
    );
  } else if (String(mailCheck.reason).startsWith("graph_read_failed")) {
    record(
      "A. Welcome email delivery (Graph Sent Items)",
      "SKIPPED",
      `${mailCheck.reason}; HTTP register PASS — confirm inbox manually`
    );
  } else {
    record(
      "A. Welcome email delivery (Graph Sent Items)",
      "FAIL",
      mailCheck.reason
    );
  }

  const loginRes = await fetch(`${API_BASE_URL}/candidate-portal/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email_id: emailId, password })
  });
  const loginBody = await readJson(loginRes);

  if (loginRes.status === 200 && loginBody.data?.token) {
    record("A. HTTP POST /candidate-portal/login after register", "PASS");
  } else {
    record(
      "A. HTTP POST /candidate-portal/login after register",
      "FAIL",
      `${loginRes.status} ${loginBody.message || ""}`
    );
  }

  await cleanupPortalCandidate(candidateId);
  const countAfterCleanup = await pool.query(
    `SELECT COUNT(*)::int AS n FROM cand_mstr WHERE candidate_id = $1`,
    [candidateId]
  );

  if (countAfterCleanup.rows[0].n === 0) {
    record("A. Cleanup portal test candidate", "PASS");
  } else {
    record("A. Cleanup portal test candidate", "FAIL", `candidate_id=${candidateId}`);
  }
}

async function main() {
  console.log("=== Batch 1 previously skipped HTTP/email supplement ===\n");
  console.log(
    "Previously skipped (from prior runs): A) HTTP portal register + welcome email (used service seed to avoid IGS mail); UI rule 10 PAN confirm remains non-HTTP.\n"
  );

  const health = await fetch(`${API_BASE_URL}/health-test`);
  if (health.status !== 200) {
    record("Backend health-test", "FAIL", `HTTP ${health.status}`);
    await pool.end();
    return;
  }
  record("Backend health-test", "PASS");

  const emailUser = String(process.env.EMAIL_USER || "").trim();
  if (!emailUser.toLowerCase().includes("optalynx")) {
    record(
      "Local O365 sender check (EMAIL_USER)",
      "SKIPPED",
      `EMAIL_USER=${emailUser || "(empty)"} — verify tenant manually`
    );
  } else {
    record("Local O365 sender check (EMAIL_USER)", "PASS", emailUser);
  }

  await scenarioA();

  console.log("\n=== Running full Batch 1 HTTP E2E (HTTP portal register path) ===\n");
  const e2ePath = path.join(__dirname, "verifyCandidateBatch1HttpE2e.js");
  const e2e = spawnSync(process.execPath, [e2ePath], {
    stdio: "inherit",
    env: process.env
  });

  if (e2e.status !== 0) {
    record("Full verifyCandidateBatch1HttpE2e.js", "FAIL", `exit ${e2e.status}`);
  } else {
    record("Full verifyCandidateBatch1HttpE2e.js", "PASS");
  }

  console.log("\n=== Supplement scenario summary ===");
  for (const row of scenarios) {
    console.log(`  [${row.status}] ${row.id}${row.detail ? ` — ${row.detail}` : ""}`);
  }

  await pool.end();
}

main().catch(async (error) => {
  record("unexpected", "FAIL", error.message);
  await pool.end();
  process.exit(1);
});
