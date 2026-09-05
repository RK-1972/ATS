/**
 * Report Builder V1.2 — semantic aggregation verification.
 * Usage: node scripts/verifyReportBuilderSemanticApi.js
 */

require("dotenv").config();

const { Pool } = require("pg");
const reportBuilderQueryService = require("../services/reportBuilderQueryService");
const { getStandardReportDefinition } = require("../services/standardReportRegistry");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

let passed = 0;
let failed = 0;

function pass(label) {
  passed += 1;
  console.log(`PASS: ${label}`);
}

function fail(label, detail = "") {
  failed += 1;
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

function adminReq() {
  return { user: { role_name: "Admin" } };
}

function printAggregateTable(title, rows, dimensionCode, measureCode) {
  console.log(`\n${title}`);
  console.log(`${dimensionCode}\t${measureCode}`);
  for (const row of rows) {
    console.log(`${row[dimensionCode] ?? "—"}\t${row[measureCode] ?? 0}`);
  }
}

async function runAggregateQuery(label, payload) {
  const result = await reportBuilderQueryService.executeReportQuery(pool, adminReq(), payload);

  if (result.result_type !== "aggregate") {
    fail(`${label} result_type`, `expected aggregate, got ${result.result_type}`);
    return null;
  }

  if (!Array.isArray(result.rows)) {
    fail(`${label} rows`);
    return null;
  }

  pass(`${label} (${result.rows.length} rows, total ${result.pagination.total_count})`);
  return result;
}

async function expectQueryError(label, payload) {
  try {
    await reportBuilderQueryService.executeReportQuery(pool, adminReq(), payload);
    fail(`${label}`, "expected error");
  } catch (error) {
    pass(`${label} rejected — ${error.message}`);
  }
}

async function main() {
  console.log("=== Report Builder V1.2 Semantic Verification ===\n");

  const detailResult = await reportBuilderQueryService.executeReportQuery(pool, adminReq(), {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name", "stage_name", "applied_on"],
    filters: [],
    sort: [{ field: "applied_on", direction: "desc" }],
    page: 1,
    pageSize: 10
  });

  if (detailResult.result_type === "detail") {
    pass("Detail mode regression");
  } else {
    fail("Detail mode regression", detailResult.result_type);
  }

  await runAggregateQuery("COUNT_DISTINCT by stage", {
    dataset: "CANDIDATE_PIPELINE",
    dimensions: [{ field: "stage_name" }],
    measures: [
      { field: "candidate_id", aggregation: "COUNT_DISTINCT", alias: "candidate_count" }
    ],
    filters: [],
    sort: [{ field: "stage_name", direction: "asc" }],
    page: 1,
    pageSize: 100
  });

  const trendResult = await runAggregateQuery("Date grain MONTH trend", {
    dataset: "CANDIDATE_PIPELINE",
    dimensions: [{ field: "applied_on", grain: "MONTH" }],
    measures: [
      { field: "candidate_id", aggregation: "COUNT_DISTINCT", alias: "candidate_count" }
    ],
    filters: [],
    sort: [{ field: "applied_on__month", direction: "asc" }],
    page: 1,
    pageSize: 100
  });

  await runAggregateQuery("Recruiter workload with NULL label", {
    dataset: "CANDIDATE_PIPELINE",
    dimensions: [{ field: "assigned_recruiter_name" }],
    measures: [
      { field: "candidate_id", aggregation: "COUNT_DISTINCT", alias: "candidate_count" }
    ],
    filters: [],
    sort: [{ field: "candidate_count", direction: "desc" }],
    page: 1,
    pageSize: 100
  });

  await runAggregateQuery("Requisitions by department", {
    dataset: "REQUISITION_SUMMARY",
    dimensions: [{ field: "department" }],
    measures: [
      {
        field: "requisition_code",
        aggregation: "COUNT_DISTINCT",
        alias: "requisition_count"
      }
    ],
    filters: [],
    sort: [{ field: "requisition_count", direction: "desc" }],
    page: 1,
    pageSize: 100
  });

  await expectQueryError("Invalid aggregation SUM on text", {
    dataset: "CANDIDATE_PIPELINE",
    dimensions: [{ field: "stage_name" }],
    measures: [{ field: "stage_name", aggregation: "SUM" }],
    page: 1,
    pageSize: 25
  });

  await expectQueryError("SQL injection in dimension field", {
    dataset: "CANDIDATE_PIPELINE",
    dimensions: [{ field: "stage_name; DROP TABLE rb_field" }],
    measures: [
      { field: "candidate_id", aggregation: "COUNT_DISTINCT", alias: "candidate_count" }
    ],
    page: 1,
    pageSize: 25
  });

  await expectQueryError("Invalid date grain", {
    dataset: "CANDIDATE_PIPELINE",
    dimensions: [{ field: "applied_on", grain: "FORTNIGHT" }],
    measures: [
      { field: "candidate_id", aggregation: "COUNT_DISTINCT", alias: "candidate_count" }
    ],
    page: 1,
    pageSize: 25
  });

  console.log("\n=== Standard Reports (aggregate) ===");

  for (const reportCode of [
    "CANDIDATE_PIPELINE",
    "REQUISITION_OVERVIEW",
    "HIRING_TREND",
    "RECRUITMENT_FUNNEL",
    "RECRUITER_WORKLOAD",
    "DEPARTMENT_HIRING"
  ]) {
    const definition = getStandardReportDefinition(reportCode);
    const config = definition.definition;

    const payload = {
      dataset: definition.dataset_code,
      dimensions: config.dimensions,
      measures: config.measures,
      filters: config.filters || [],
      sort: config.sort || [],
      page: 1,
      pageSize: 100
    };

    const result = await runAggregateQuery(reportCode, payload);

    if (!result) {
      continue;
    }

    const dimensionCode =
      config.dimensions[0]?.grain && config.dimensions[0]?.field
        ? `${config.dimensions[0].field}__${config.dimensions[0].grain.toLowerCase()}`
        : config.dimensions[0]?.field;

    const measureCode = config.measures[0]?.alias || `${config.measures[0]?.field}__count_distinct`;

    printAggregateTable(definition.name, result.rows.slice(0, 12), dimensionCode, measureCode);
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
