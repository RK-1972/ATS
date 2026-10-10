/**
 * Phase 2 — merged interview schedule list ordering (created_on DESC, schedule_id DESC).
 * Run: node scripts/verifyInterviewScheduleCreatedOnSort.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const { sortInterviewScheduleRows } = require("../services/legacyOperationalAdapter");
const { isEnterpriseOperationalSor } = require("../config/operationalCutover");

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

function assertOrder(rows, expectedIds, label) {
  const ids = rows.map((row) => Number(row.schedule_id));
  const match =
    ids.length === expectedIds.length && ids.every((id, index) => id === expectedIds[index]);
  if (match) {
    pass(label);
  } else {
    fail(label, `expected [${expectedIds.join(", ")}], got [${ids.join(", ")}]`);
  }
}

async function main() {
  console.log("=== Interview schedule created_on sort verification ===\n");

  const sample = sortInterviewScheduleRows([
    { schedule_id: 10, created_on: "2024-01-15T08:00:00.000Z" },
    { schedule_id: 30, created_on: "2025-03-01T12:00:00.000Z" },
    { schedule_id: 20, created_on: "2025-03-01T12:00:00.000Z" },
    { schedule_id: 5, created_on: null }
  ]);
  assertOrder(sample, [30, 20, 10, 5], "Unit: newest created_on first with schedule_id tie-break");

  const missingTs = sortInterviewScheduleRows([
    { schedule_id: 2, created_on: undefined },
    { schedule_id: 99, created_on: "2025-01-01T00:00:00.000Z" }
  ]);
  assertOrder(missingTs, [99, 2], "Unit: missing created_on sorts after dated rows");

  if (!isEnterpriseOperationalSor()) {
    console.log("SKIP: DB created_on column check — legacy-only SoR");
    await pool.end();
    return;
  }

  const enterpriseCol = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(created_on)::int AS with_created_on
     FROM im_interviews
     WHERE schedule_id IS NOT NULL`
  );
  const legacyCol = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(created_on)::int AS with_created_on
     FROM interview_schedule_trn`
  );

  const ent = enterpriseCol.rows[0];
  const leg = legacyCol.rows[0];

  if (ent.total > 0 && ent.with_created_on === ent.total) {
    pass(`DB: im_interviews created_on populated (${ent.with_created_on}/${ent.total})`);
  } else if (ent.total === 0) {
    console.log("SKIP: no enterprise interview rows for created_on audit");
  } else {
    fail(
      "DB: im_interviews created_on coverage",
      `${ent.with_created_on}/${ent.total} rows populated`
    );
  }

  if (leg.total > 0 && leg.with_created_on === leg.total) {
    pass(`DB: interview_schedule_trn created_on populated (${leg.with_created_on}/${leg.total})`);
  } else if (leg.total === 0) {
    console.log("SKIP: no legacy schedule rows for created_on audit");
  } else {
    fail(
      "DB: interview_schedule_trn created_on coverage",
      `${leg.with_created_on}/${leg.total} rows populated`
    );
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nInterview schedule sort verification completed with failures.");
  } else {
    console.log("\nAll interview schedule sort checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
