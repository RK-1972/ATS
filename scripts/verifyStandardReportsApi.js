/**
 * Verify Report Center V1.1 standard report definitions and PostgreSQL execution.
 * Uses direct service calls (no HTTP server required).
 *
 * Usage: node scripts/verifyStandardReportsApi.js
 */

require("dotenv").config();

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const {
  listStandardReportDefinitions,
  getStandardReportDefinition
} = require("../services/standardReportRegistry");
const standardReportService = require("../services/standardReportService");
const reportBuilderQueryService = require("../services/reportBuilderQueryService");

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

function buildAdminReq() {
  return {
    user: {
      role_name: "Admin"
    }
  };
}

function buildQueryPayload(definition) {
  const config = definition.definition;

  return {
    dataset: definition.dataset_code,
    fields: config.fields,
    filters: config.filters || [],
    sort: config.sort || [],
    groupBy: config.group_by || [],
    page: 1,
    pageSize: 25
  };
}

async function main() {
  console.log("=== Report Center V1.1 — Standard Reports Verification ===\n");

  const registryReports = listStandardReportDefinitions();
  if (registryReports.length === 6) {
    pass("Registry contains exactly 6 standard reports");
  } else {
    fail("Registry report count", `expected 6, got ${registryReports.length}`);
  }

  const req = buildAdminReq();
  const listData = await standardReportService.listAuthorizedStandardReports(pool, req);
  const listedReports = listData?.reports || [];

  if (listedReports.length >= 6) {
    pass(`listAuthorizedStandardReports returned ${listedReports.length} report(s) for Admin`);
  } else {
    fail("Authorized standard reports list", `expected >= 6, got ${listedReports.length}`);
  }

  for (const summary of registryReports) {
    const reportCode = summary.report_code;
    console.log(`\n--- ${reportCode} ---`);

    const definition = getStandardReportDefinition(reportCode);
    if (!definition) {
      fail(`${reportCode} registry lookup`);
      continue;
    }

    pass(`${reportCode} registry definition present`);

    try {
      const authorizedDefinition = await standardReportService.getAuthorizedStandardReport(
        pool,
        req,
        reportCode
      );

      if (authorizedDefinition.report_code === reportCode) {
        pass(`${reportCode} authorized definition service`);
      } else {
        fail(`${reportCode} authorized definition service`, "report_code mismatch");
      }
    } catch (error) {
      fail(`${reportCode} authorized definition service`, error.message);
      continue;
    }

    const queryPayload = buildQueryPayload(definition);

    try {
      const queryResult = await reportBuilderQueryService.executeReportQuery(
        pool,
        req,
        queryPayload
      );

      const rowCount = queryResult.rows?.length ?? 0;
      const totalCount = queryResult.pagination?.total_count ?? 0;

      if (Array.isArray(queryResult.rows) && Array.isArray(queryResult.columns)) {
        pass(`${reportCode} PostgreSQL query (${rowCount} rows, ${totalCount} total)`);
      } else {
        fail(`${reportCode} PostgreSQL query`, "invalid result shape");
      }
    } catch (error) {
      fail(`${reportCode} PostgreSQL query`, error.message);
    }
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
