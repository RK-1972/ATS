require("dotenv").config();

const { Pool } = require("pg");
const candidateRegistrationValidation = require("../services/candidateRegistrationValidation");

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

async function main() {
  const panOk = candidateRegistrationValidation.validatePanFormat("abcde1234f");
  if (!panOk.valid || panOk.pan !== "ABCDE1234F") {
    fail("PAN normalization", JSON.stringify(panOk));
  } else {
    pass("PAN normalization (trim + uppercase)");
  }

  const panBad = candidateRegistrationValidation.validatePanFormat("ABC1234F");
  if (panBad.valid) {
    fail("PAN format rejects invalid value");
  } else {
    pass("PAN format validation");
  }

  const contactErrors = candidateRegistrationValidation.validateRegisteredContactFields({
    email_id: "",
    mobile_number: ""
  });
  if (contactErrors.length < 2) {
    fail("REGISTERED requires email and mobile", contactErrors.join("; "));
  } else {
    pass("REGISTERED contact requirements");
  }

  try {
    candidateRegistrationValidation.assertPanImmutable("ABCDE1234F", "FGHIJ5678K");
    fail("PAN immutability should throw");
  } catch (error) {
    if (error.message.includes("cannot be changed")) {
      pass("PAN immutability after registration");
    } else {
      fail("PAN immutability message", error.message);
    }
  }

  const dupGroups = await pool.query(`
    SELECT UPPER(TRIM(pan_number)) AS pan_key, COUNT(*)::int AS cnt,
           array_agg(candidate_id ORDER BY candidate_id) AS ids
    FROM cand_mstr
    WHERE UPPER(TRIM(candidate_status)) = 'REGISTERED'
      AND pan_number IS NOT NULL
      AND TRIM(pan_number) <> ''
    GROUP BY UPPER(TRIM(pan_number))
    HAVING COUNT(*) > 1
  `);

  if (dupGroups.rows.length > 0) {
    fail("existing REGISTERED duplicate PAN groups", JSON.stringify(dupGroups.rows));
  } else {
    pass("no REGISTERED duplicate PAN rows in database");
  }

  const indexCheck = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE indexname = 'uq_cand_mstr_registered_pan_upper'
  `);

  if (indexCheck.rows.length === 0) {
    console.log("INFO: unique index uq_cand_mstr_registered_pan_upper not applied yet");
  } else {
    pass("partial unique PAN index present");
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
