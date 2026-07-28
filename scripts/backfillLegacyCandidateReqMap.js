/**
 * One-time backfill: ensure candidate_req_map rows exist for enterprise
 * rm_candidate_mappings (same bridge as mapCandidate).
 *
 * Usage (CLI only — not wired to any API/route):
 *   node scripts/backfillLegacyCandidateReqMap.js
 *
 * Idempotent: skips map_ids that already exist in candidate_req_map.
 */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function main() {
  const client = await pool.connect();
  let inserted = 0;
  let skippedNoReq = 0;
  let skippedNoReqMstr = 0;
  let alreadyPresent = 0;

  try {
    await client.query("BEGIN");

    const missing = await client.query(
      `
      SELECT
        rcm.map_id,
        rcm.candidate_id,
        rcm.req_id,
        rcm.recruiter_id,
        rcm.stage_name,
        rcm.source_type,
        rcm.remarks,
        rcm.is_active
      FROM rm_candidate_mappings rcm
      WHERE rcm.map_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM candidate_req_map crm
          WHERE crm.map_id = rcm.map_id
        )
      ORDER BY rcm.map_id ASC
      `
    );

    console.log(`Found ${missing.rows.length} enterprise mapping(s) missing legacy rows.`);

    for (const row of missing.rows) {
      if (!row.req_id) {
        skippedNoReq += 1;
        console.warn(`SKIP map_id=${row.map_id}: no req_id on enterprise mapping`);
        continue;
      }

      const reqExists = await client.query(
        `SELECT 1 FROM req_mstr WHERE req_id = $1`,
        [row.req_id]
      );

      if (!reqExists.rows.length) {
        skippedNoReqMstr += 1;
        console.warn(
          `SKIP map_id=${row.map_id}: req_id=${row.req_id} not found in req_mstr`
        );
        continue;
      }

      const result = await client.query(
        `
        INSERT INTO candidate_req_map (
          map_id, candidate_id, req_id, recruiter_id,
          stage_name, source_type, remarks, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (map_id) DO NOTHING
        RETURNING map_id
        `,
        [
          row.map_id,
          row.candidate_id,
          row.req_id,
          row.recruiter_id,
          row.stage_name || "Applied",
          row.source_type,
          row.remarks,
          row.is_active !== false
        ]
      );

      if (result.rows.length) {
        inserted += 1;
        console.log(`INSERTED map_id=${row.map_id} candidate_id=${row.candidate_id} req_id=${row.req_id}`);
      } else {
        alreadyPresent += 1;
      }
    }

    await client.query(
      `
      SELECT setval(
        'candidate_req_map_map_id_seq',
        (SELECT COALESCE(MAX(map_id), 1) FROM candidate_req_map)
      )
      `
    );

    await client.query("COMMIT");

    console.log("---");
    console.log(`Inserted: ${inserted}`);
    console.log(`Already present (race/conflict): ${alreadyPresent}`);
    console.log(`Skipped (no req_id): ${skippedNoReq}`);
    console.log(`Skipped (req_id not in req_mstr): ${skippedNoReqMstr}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Backfill failed:", error.message);
  process.exit(1);
});
