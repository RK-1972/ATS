/**
 * Focused verification for resolveMappingContext map_id / mapping_id collision handling.
 * Run: node scripts/verifyMappingContextResolution.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");

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

function skip(label, reason) {
  console.log(`SKIP: ${label} — ${reason}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function mockReq(user) {
  return { user };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function findMapIdMappingIdCollision() {
  const result = await pool.query(
    `SELECT target.map_id,
            target.mapping_id AS expected_mapping_id,
            target.candidate_id AS expected_candidate_id,
            target.stage_name AS expected_stage_name,
            collider.mapping_id AS colliding_mapping_id,
            collider.map_id AS colliding_map_id,
            collider.stage_name AS colliding_stage_name
     FROM rm_candidate_mappings target
     INNER JOIN rm_candidate_mappings collider
       ON collider.mapping_id = target.map_id
      AND collider.mapping_id <> target.mapping_id
     WHERE target.is_active = TRUE
       AND target.map_id IS NOT NULL
     ORDER BY target.modified_on DESC NULLS LAST
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function countHistory(mappingId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM rm_pipeline_history
     WHERE mapping_id = $1`,
    [mappingId]
  );
  return result.rows[0].total;
}

async function loadMapping(mappingId) {
  const result = await pool.query(
    `SELECT mapping_id, map_id, candidate_id, stage_name, is_active, modified_on
     FROM rm_candidate_mappings
     WHERE mapping_id = $1`,
    [mappingId]
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Mapping Context Resolution Collision Verification ===\n");

  const collision = await findMapIdMappingIdCollision();
  if (!collision) {
    skip("collision fixture", "no map_id / mapping_id collision row in database");
    await pool.end();
    return;
  }

  const admin = await resolveUserByRole("Admin");
  if (!admin) {
    fail("fixtures", "Admin user required");
    await pool.end();
    return;
  }

  const assignedRecruiter = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM rm_recruiter_assignments a
     INNER JOIN user_mstr u ON u.employee_code = a.recruiter_code
     INNER JOIN rm_candidate_mappings m
       ON m.requisition_code = a.requisition_code
      AND m.map_id = $1
     WHERE a.is_active = true
       AND u.role_name = 'Recruiter'
     LIMIT 1`,
    [collision.map_id]
  );
  const actor = assignedRecruiter.rows[0] || admin;

  const beforeTarget = await loadMapping(collision.expected_mapping_id);
  const beforeCollider = await loadMapping(collision.colliding_mapping_id);
  const beforeTargetHistory = await countHistory(collision.expected_mapping_id);
  const beforeColliderHistory = await countHistory(collision.colliding_mapping_id);

  const currentStage = String(beforeTarget?.stage_name || "Applied").trim();
  const nextStage = currentStage === "Screening" ? "Applied" : "Screening";

  console.log("Collision fixture:", collision);
  console.log("Stage transition:", { currentStage, nextStage });

  const result = await recruitmentService.updateCandidateStage(
    pool,
    collision.map_id,
    nextStage,
    "mapping context resolution verification",
    mockReq(actor)
  );

  const afterTarget = await loadMapping(collision.expected_mapping_id);
  const afterCollider = await loadMapping(collision.colliding_mapping_id);
  const afterTargetHistory = await countHistory(collision.expected_mapping_id);
  const afterColliderHistory = await countHistory(collision.colliding_mapping_id);

  if (String(result.mapping?.mapping_id) === String(collision.expected_mapping_id)) {
    pass("input map_id resolves to expected mapping_id");
  } else {
    fail(
      "input map_id resolves to expected mapping_id",
      `got mapping_id=${result.mapping?.mapping_id}`
    );
  }

  if (String(result.mapping?.candidate_id) === String(collision.expected_candidate_id)) {
    pass("resolved mapping targets expected candidate");
  } else {
    fail(
      "resolved mapping targets expected candidate",
      `got candidate_id=${result.mapping?.candidate_id}`
    );
  }

  if (afterTarget?.stage_name === nextStage) {
    pass("stage update affects expected active map_id row");
  } else {
    fail(
      "stage update affects expected active map_id row",
      `expected ${nextStage}, got ${afterTarget?.stage_name}`
    );
  }

  if (afterTargetHistory > beforeTargetHistory) {
    pass("pipeline history written against expected mapping_id");
  } else {
    fail(
      "pipeline history written against expected mapping_id",
      `before=${beforeTargetHistory}, after=${afterTargetHistory}`
    );
  }

  if (
    afterCollider?.stage_name === beforeCollider?.stage_name &&
    afterColliderHistory === beforeColliderHistory
  ) {
    pass("unrelated colliding mapping_id row remains untouched");
  } else {
    fail(
      "unrelated colliding mapping_id row remains untouched",
      `stage ${beforeCollider?.stage_name} -> ${afterCollider?.stage_name}, history ${beforeColliderHistory} -> ${afterColliderHistory}`
    );
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nMapping context resolution verification completed with failures.");
  } else {
    console.log("\nAll mapping context resolution checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
