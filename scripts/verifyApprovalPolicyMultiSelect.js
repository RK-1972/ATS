/**
 * Verifies multi-select designation/grade approval policy matching:
 * - Legacy single-value policies still match
 * - Multi-value membership matching (cross-product semantics)
 * - Wildcard (empty/null) criteria
 * - Overlap validation on save
 */
require("dotenv").config();

const { Pool } = require("pg");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");
const approvalRouteResolverService = require("../services/approvalRouteResolverService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const TEST_PREFIX = "VERIFY-MULTI-POLICY";
const failures = [];
const checks = [];

function pass(label) {
  checks.push(`PASS: ${label}`);
}

function fail(label, detail = "") {
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

async function ensureMigrationApplied(client) {
  const columns = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'approval_route_policy'
       AND column_name IN ('designations', 'grades')`
  );

  if (columns.rows.length < 2) {
    throw new Error(
      "Migration 042 not applied. Run: node scripts/apply042Migration.js"
    );
  }
}

async function findBudgetRoute(client) {
  const result = await client.query(
    `SELECT route_id, route_name
     FROM approval_route_mstr
     WHERE LOWER(status) = 'active'
       AND (
         LOWER(applies_to) LIKE '%budget%'
         OR UPPER(applies_to) = 'BUDGET'
       )
     ORDER BY route_id
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function createTestRoute(client, suffix) {
  const result = await client.query(
    `INSERT INTO approval_route_mstr (
       route_name,
       description,
       applies_to,
       status,
       effective_from,
       max_approval_days,
       created_by,
       created_on,
       updated_by,
       updated_on
     ) VALUES ($1, $2, 'Budget Approval', 'Active', CURRENT_DATE, 3, $3, NOW(), $3, NOW())
     RETURNING route_id`,
    [
      `${TEST_PREFIX}-Route-${suffix}`,
      "Verification route",
      TEST_PREFIX
    ]
  );

  return result.rows[0].route_id;
}

async function cleanupTestData(client) {
  await client.query(
    `DELETE FROM approval_route_policy
     WHERE created_by = $1
        OR route_id IN (
          SELECT route_id
          FROM approval_route_mstr
          WHERE route_name LIKE $2
        )`,
    [TEST_PREFIX, `${TEST_PREFIX}%`]
  );

  await client.query(
    `DELETE FROM approval_route_mstr
     WHERE route_name LIKE $1`,
    [`${TEST_PREFIX}%`]
  );
}

async function assertMatch(documentType, criteria, expectedRouteId, label) {
  const matches = await approvalRouteRepository.findMatchingActiveRoutes(
    pool,
    documentType,
    criteria
  );

  const routeIds = matches.map((row) => Number(row.route_id));

  if (expectedRouteId === null) {
    if (routeIds.length === 0) {
      pass(label);
    } else {
      fail(label, `expected no match, got routes ${routeIds.join(", ")}`);
    }
    return;
  }

  if (routeIds.includes(Number(expectedRouteId))) {
    pass(label);
  } else {
    fail(
      label,
      `expected route ${expectedRouteId}, got ${routeIds.join(", ") || "none"}`
    );
  }
}

async function assertNoMatchForRoute(documentType, criteria, excludedRouteId, label) {
  const matches = await approvalRouteRepository.findMatchingActiveRoutes(
    pool,
    documentType,
    criteria
  );

  const includesExcluded = matches.some(
    (row) => Number(row.route_id) === Number(excludedRouteId)
  );

  if (!includesExcluded) {
    pass(label);
  } else {
    fail(label, `route ${excludedRouteId} unexpectedly matched`);
  }
}

async function assertResolve(documentType, criteria, expectedRouteId, label) {
  try {
    const routeId = await approvalRouteResolverService.resolveApprovalRoute(
      pool,
      documentType,
      criteria
    );

    if (Number(routeId) === Number(expectedRouteId)) {
      pass(label);
    } else {
      fail(label, `expected ${expectedRouteId}, got ${routeId}`);
    }
  } catch (error) {
    if (expectedRouteId === null) {
      pass(label);
    } else {
      fail(label, error.message);
    }
  }
}

async function main() {
  const client = await pool.connect();

  try {
    await ensureMigrationApplied(client);
    await cleanupTestData(client);

    const routeA = await createTestRoute(client, "A");
    const routeB = await createTestRoute(client, "B");

    const testDepartment = `${TEST_PREFIX}-Testing`;

    const multiPolicy = await approvalRouteRepository.createApprovalRoutePolicy(
      pool,
      {
        route_id: routeA,
        department: testDepartment,
        designations: [
          "Automation Engineer",
          "Senior Automation Engineer",
          "Test Lead"
        ],
        grades: ["G4", "G5", "G6"],
        min_amount: 0,
        max_amount: null,
        is_active: true,
        effective_from: "2020-01-01",
        effective_to: null,
        created_by: TEST_PREFIX
      }
    );

    await assertMatch(
      "BUDGET",
      {
        department: testDepartment,
        designation: "Automation Engineer",
        grade: "G4",
        amount: 1000000
      },
      routeA,
      "TEST 1: Testing + Automation Engineer + G4"
    );

    await assertMatch(
      "BUDGET",
      {
        department: testDepartment,
        designation: "Senior Automation Engineer",
        grade: "G5",
        amount: 1200000
      },
      routeA,
      "TEST 2: Testing + Senior Automation Engineer + G5"
    );

    await assertMatch(
      "BUDGET",
      {
        department: testDepartment,
        designation: "Test Lead",
        grade: "G6",
        amount: 1500000
      },
      routeA,
      "TEST 3: Testing + Test Lead + G6"
    );

    await assertNoMatchForRoute(
      "BUDGET",
      {
        department: testDepartment,
        designation: "Developer",
        grade: "G5",
        amount: 1000000
      },
      routeA,
      "TEST 4: Testing + Developer + G5 (no match)"
    );

    await assertNoMatchForRoute(
      "BUDGET",
      {
        department: "Engineering",
        designation: "Test Lead",
        grade: "G5",
        amount: 1000000
      },
      routeA,
      "TEST 5: Engineering + Test Lead + G5 (no match)"
    );

    await assertNoMatchForRoute(
      "BUDGET",
      {
        department: testDepartment,
        designation: "Test Lead",
        grade: "G7",
        amount: 1000000
      },
      routeA,
      "TEST 6: Testing + Test Lead + G7 (no match)"
    );

    const legacyDepartment = `${TEST_PREFIX}-Legacy`;
    const legacyPolicy = await approvalRouteRepository.createApprovalRoutePolicy(
      pool,
      {
        route_id: routeB,
        department: legacyDepartment,
        designation: "Legacy Test Lead",
        grade: "G5",
        is_active: true,
        effective_from: "2020-01-01",
        created_by: TEST_PREFIX
      }
    );

    await assertResolve(
      "BUDGET",
      {
        department: legacyDepartment,
        designation: "Legacy Test Lead",
        grade: "G5",
        amount: 900000
      },
      routeB,
      "Legacy single designation/grade policy still matches"
    );

    const legacyRead = await approvalRouteRepository.getApprovalRoutePolicy(
      pool,
      legacyPolicy.policy_id
    );

    if (
      Array.isArray(legacyRead.designations)
      && legacyRead.designations.includes("Legacy Test Lead")
      && Array.isArray(legacyRead.grades)
      && legacyRead.grades.includes("G5")
    ) {
      pass("Legacy policy migrated to arrays on read");
    } else {
      fail(
        "Legacy policy migrated to arrays on read",
        JSON.stringify({
          designations: legacyRead.designations,
          grades: legacyRead.grades
        })
      );
    }

    const wildcardPolicy = await approvalRouteRepository.createApprovalRoutePolicy(
      pool,
      {
        route_id: routeB,
        department: "Wildcard Dept",
        designations: null,
        grades: ["G4", "G5"],
        is_active: true,
        effective_from: "2020-01-01",
        created_by: TEST_PREFIX
      }
    );

    await assertMatch(
      "BUDGET",
      {
        department: "Wildcard Dept",
        designation: "Any Role",
        grade: "G4",
        amount: 500000
      },
      routeB,
      "Wildcard designations with specific grades"
    );

    void wildcardPolicy;

    let overlapBlocked = false;
    try {
      await approvalRouteRepository.createApprovalRoutePolicy(pool, {
        route_id: routeB,
        department: testDepartment,
        designations: ["Senior Automation Engineer", "QA Manager"],
        grades: ["G5", "G6"],
        is_active: true,
        effective_from: "2020-01-01",
        created_by: TEST_PREFIX
      });
    } catch (error) {
      if (error.status === 400 && /overlap/i.test(error.message)) {
        overlapBlocked = true;
      }
    }

    if (overlapBlocked) {
      pass("Overlap validation blocks conflicting active policy");
    } else {
      fail("Overlap validation blocks conflicting active policy");
    }

    if (multiPolicy.designations?.length === 3 && multiPolicy.grades?.length === 3) {
      pass("Single policy stores multiple designations and grades");
    } else {
      fail(
        "Single policy stores multiple designations and grades",
        JSON.stringify({
          designations: multiPolicy.designations,
          grades: multiPolicy.grades
        })
      );
    }

    await cleanupTestData(client);

    console.log("\n--- Approval Policy Multi-Select Verification ---\n");
    checks.forEach((line) => console.log(line));

    if (failures.length) {
      console.log("\nFailures:");
      failures.forEach((line) => console.log(`FAIL: ${line}`));
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${checks.length} checks passed.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
