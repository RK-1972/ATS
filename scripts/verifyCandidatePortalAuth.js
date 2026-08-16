require("dotenv").config();

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const {
  isPasswordStrong,
  getPasswordStrengthLabel,
  PASSWORD_REGEX
} = require("../utils/passwordPolicy");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");

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
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [tableName]
  );
  return result.rowCount > 0;
}

async function columnExists(tableName, columnName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2`,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

function verifyPasswordPolicy() {
  if (!PASSWORD_REGEX.test("Abcdef1!")) {
    fail("password policy accepts valid password");
    return;
  }

  pass("password policy accepts valid password");

  if (PASSWORD_REGEX.test("weakpass")) {
    fail("password policy rejects weak password");
    return;
  }

  pass("password policy rejects weak password");

  if (getPasswordStrengthLabel("Abcdef1!") !== "Strong") {
    fail("password strength label for valid password");
    return;
  }

  pass("password strength label for valid password");

  if (!isPasswordStrong("Abcdef1!")) {
    fail("isPasswordStrong helper");
    return;
  }

  pass("isPasswordStrong helper");
}

async function verifySchema() {
  if (!(await tableExists("candidate_portal_account"))) {
    fail("candidate_portal_account table exists");
    return;
  }

  pass("candidate_portal_account table exists");

  const requiredColumns = [
    "portal_account_id",
    "candidate_id",
    "email_id",
    "password_hash",
    "full_name",
    "mobile_number",
    "is_active",
    "created_on",
    "updated_on",
    "last_login_on"
  ];

  for (const columnName of requiredColumns) {
    if (!(await columnExists("candidate_portal_account", columnName))) {
      fail(`candidate_portal_account.${columnName} exists`);
      return;
    }
  }

  pass("candidate_portal_account required columns exist");
}

async function verifyRegistrationFlow() {
  if (!process.env.JWT_SECRET) {
    fail("JWT_SECRET configured for auth flow test");
    return;
  }

  const service = createCandidatePortalService(pool);
  const uniqueSuffix = Date.now();
  const emailId = `portal.verify.${uniqueSuffix}@example.com`;
  const password = "Verify1!Pass";

  const registerResult = await service.registerCandidateAccount({
    full_name: "Portal Verify User",
    mobile_number: "9876543210",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    fail("candidate registration succeeds", registerResult.message);
    return;
  }

  pass("candidate registration succeeds");

  const accountRow = await pool.query(
    `SELECT password_hash, candidate_id
     FROM candidate_portal_account
     WHERE LOWER(email_id) = LOWER($1)`,
    [emailId]
  );

  if (accountRow.rowCount !== 1) {
    fail("portal account persisted");
    return;
  }

  pass("portal account persisted");

  const storedHash = accountRow.rows[0].password_hash;

  if (storedHash === password) {
    fail("password stored hashed, never plaintext");
    return;
  }

  pass("password stored hashed, never plaintext");

  const candidateRow = await pool.query(
    `SELECT candidate_status
     FROM cand_mstr
     WHERE candidate_id = $1`,
    [accountRow.rows[0].candidate_id]
  );

  if (candidateRow.rows[0]?.candidate_status !== "DRAFT") {
    fail(
      "registration keeps candidate in DRAFT",
      candidateRow.rows[0]?.candidate_status
    );
    return;
  }

  pass("registration keeps candidate in DRAFT");

  const duplicateResult = await service.registerCandidateAccount({
    full_name: "Portal Verify User",
    mobile_number: "9876543210",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (duplicateResult.ok || duplicateResult.status !== 409) {
    fail("duplicate portal email rejected");
    return;
  }

  pass("duplicate portal email rejected");

  const loginResult = await service.loginCandidateAccount({
    email_id: emailId,
    password: "WrongPass1!"
  });

  if (loginResult.ok) {
    fail("wrong password rejected");
    return;
  }

  pass("wrong password rejected");

  const validLogin = await service.loginCandidateAccount({
    email_id: emailId,
    password
  });

  if (!validLogin.ok || !validLogin.data?.token) {
    fail("candidate login succeeds with JWT");
    return;
  }

  pass("candidate login succeeds with JWT");

  const payload = jwt.verify(
    validLogin.data.token,
    process.env.JWT_SECRET
  );

  if (payload.account_type !== "candidate") {
    fail("candidate JWT includes account_type=candidate");
    return;
  }

  pass("candidate JWT includes account_type=candidate");

  if (payload.candidate_id !== accountRow.rows[0].candidate_id) {
    fail("candidate JWT includes candidate_id");
    return;
  }

  pass("candidate JWT includes candidate_id");

  const employeeToken = jwt.sign(
    {
      user_id: 1,
      employee_code: "EMP001",
      email_id: "employee@example.com",
      role_name: "Recruiter"
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" }
  );

  const employeePayload = jwt.verify(
    employeeToken,
    process.env.JWT_SECRET
  );

  if (employeePayload.account_type === "candidate") {
    fail("employee JWT is not candidate token");
    return;
  }

  pass("employee JWT is not candidate token");

  await pool.query(
    `DELETE FROM candidate_portal_account WHERE LOWER(email_id) = LOWER($1)`,
    [emailId]
  );
  await pool.query(
    `DELETE FROM cand_mstr WHERE candidate_id = $1`,
    [accountRow.rows[0].candidate_id]
  );

  pass("verification cleanup completed");
}

async function main() {
  try {
    verifyPasswordPolicy();
    await verifySchema();
    await verifyRegistrationFlow();
  } catch (error) {
    fail("unexpected verification error", error.message);
  } finally {
    await pool.end();
  }

  if (process.exitCode) {
    console.error("Candidate portal auth verification failed.");
  } else {
    console.log("Candidate portal auth verification passed.");
  }
}

main();
