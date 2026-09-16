/**
 * Candidate code generator verification.
 * Run: node scripts/verifyCandidateCodeGenerator.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const {
  createCandidatePortalService
} = require("../services/candidatePortalService");
const {
  buildCandidateCodeDatePrefix,
  allocateNextCandidateCode
} = require("../utils/candidateCodeGenerator");

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

async function cleanupCandidate(candidateId) {
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
     WHERE candidate_id = $1`,
    [candidateId]
  );
}

async function registerCandidate(emailId) {
  const portalService = createCandidatePortalService(pool);
  const password = "TestPass1!";

  const registerResult = await portalService.registerCandidateAccount({
    full_name: "Code Gen Candidate",
    mobile_number: "9876501111",
    email_id: emailId,
    password,
    confirm_password: password
  });

  if (!registerResult.ok) {
    throw new Error(registerResult.message || "registration failed");
  }

  return {
    candidateId: registerResult.data.account.candidate_id,
    candidateCode: (
      await pool.query(
        `SELECT candidate_code
         FROM cand_mstr
         WHERE candidate_id = $1`,
        [registerResult.data.account.candidate_id]
      )
    ).rows[0].candidate_code
  };
}

async function verifyGapScenario(datePrefix) {
  const gapEmail = `codegen.gap.${Date.now()}@example.com`;
  const client = await pool.connect();
  let gapCandidateId = null;

  try {
    await client.query("BEGIN");

    const nextCode = await allocateNextCandidateCode(client);
    const suffix = Number(String(nextCode).slice(datePrefix.length));
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM cand_mstr
       WHERE TO_CHAR(created_on, 'DDMMYY') = $1`,
      [datePrefix]
    );
    const countBasedNext = `${datePrefix}${countResult.rows[0].total + 1}`;

    const insertResult = await client.query(
      `
      INSERT INTO cand_mstr (
        candidate_code,
        first_name,
        last_name,
        email_id,
        mobile_number,
        candidate_status,
        remarks,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING candidate_id, candidate_code
      `,
      [
        nextCode,
        "Gap",
        "Candidate",
        gapEmail,
        "9876501112",
        "DRAFT",
        "candidate code generator gap test",
        "VERIFY_CODEGEN"
      ]
    );

    await client.query("COMMIT");

    gapCandidateId = insertResult.rows[0].candidate_id;
    const allocatedCode = insertResult.rows[0].candidate_code;

    if (allocatedCode !== nextCode) {
      fail("gap scenario allocates expected code", allocatedCode);
      return;
    }

    if (allocatedCode === countBasedNext && suffix !== countResult.rows[0].total + 1) {
      fail(
        "gap scenario avoids COUNT+1 when suffix gaps exist",
        `allocated=${allocatedCode} countBased=${countBasedNext}`
      );
      return;
    }

    const maxSuffixResult = await pool.query(
      `
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(candidate_code FROM LENGTH($1) + 1) AS BIGINT)),
        0
      ) AS max_suffix
      FROM cand_mstr
      WHERE candidate_code LIKE $1 || '%'
        AND SUBSTRING(candidate_code FROM LENGTH($1) + 1) ~ '^[0-9]+$'
      `,
      [datePrefix]
    );
    const maxSuffix = Number(maxSuffixResult.rows[0].max_suffix);

    if (suffix !== maxSuffix) {
      fail(
        "gap scenario uses MAX suffix + 1",
        `allocated suffix=${suffix} max suffix=${maxSuffix}`
      );
      return;
    }

    pass(
      `gap scenario uses MAX+1 (${allocatedCode}) not COUNT+1 (${countBasedNext})`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    fail("gap scenario", error.message);
  } finally {
    client.release();
    if (gapCandidateId) {
      await cleanupCandidate(gapCandidateId);
    }
  }
}

async function verifyConcurrentRegistrations(datePrefix) {
  const uniqueSuffix = Date.now();
  const registrations = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      registerCandidate(`codegen.concurrent.${uniqueSuffix}.${index}@example.com`)
    )
  );

  const codes = registrations.map((row) => row.candidateCode);
  const uniqueCodes = new Set(codes);

  if (uniqueCodes.size !== codes.length) {
    fail(
      "10 concurrent registrations produce unique codes",
      codes.join(", ")
    );
  } else {
    pass("10 concurrent registrations produce unique codes");
  }

  for (const code of codes) {
    if (!String(code).startsWith(datePrefix)) {
      fail("concurrent codes use today's prefix", code);
      return;
    }
  }

  pass("concurrent codes use today's DDMMYY prefix");

  for (const row of registrations) {
    await cleanupCandidate(row.candidateId);
  }
}

async function verifyNormalRegistration() {
  const emailId = `codegen.normal.${Date.now()}@example.com`;
  const { candidateId, candidateCode } = await registerCandidate(emailId);

  if (!candidateCode) {
    fail("normal registration assigns candidate_code");
  } else {
    pass(`normal registration succeeds (${candidateCode})`);
  }

  await cleanupCandidate(candidateId);
}

async function verifyNoDuplicateCodes() {
  const dupResult = await pool.query(
    `
    SELECT candidate_code, COUNT(*)::int AS c
    FROM cand_mstr
    WHERE candidate_code IS NOT NULL
    GROUP BY candidate_code
    HAVING COUNT(*) > 1
    `
  );

  if (dupResult.rows.length > 0) {
    fail(
      "no duplicate candidate_code values exist",
      JSON.stringify(dupResult.rows)
    );
  } else {
    pass("no duplicate candidate_code values exist");
  }
}

async function main() {
  const datePrefix = buildCandidateCodeDatePrefix();
  console.log(`Candidate code generator verification (${datePrefix})`);

  await verifyNormalRegistration();
  await verifyGapScenario(datePrefix);
  await verifyConcurrentRegistrations(datePrefix);
  await verifyNoDuplicateCodes();

  console.log("Candidate code generator verification finished.");
  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
