/**
 * Report Builder export API verification (smoke checks).
 * Run: node scripts/verifyReportBuilderExportApi.js
 */

require("dotenv").config();

const { QUERY_LIMITS, EXPORT_FORMATS } = require("../services/reportBuilderQueryConstants");
const { validateReportExportRequest } = require("../services/reportBuilderQueryValidator");
const { buildReportQueryPlan } = require("../services/reportBuilderQueryEngine");
const {
  formatExportCellValue,
  buildExportFilename
} = require("../utils/reportExportFormatters");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runChecks() {
  assert(QUERY_LIMITS.max_export_rows === 5000, "Expected max_export_rows = 5000");
  assert(EXPORT_FORMATS.join(",") === "xlsx,csv,pdf", "Expected export formats");

  const queryFields = [
    {
      code: "applied_on",
      label: "Applied On",
      data_type: "date",
      sql_expression: "m.applied_on",
      filterable: true,
      sortable: true,
      groupable: false,
      enum_values: null
    }
  ];

  const validated = validateReportExportRequest(
    {
      dataset: "CANDIDATE_PIPELINE",
      fields: ["applied_on"],
      filters: [],
      sort: [],
      groupBy: []
    },
    queryFields,
    "CANDIDATE_PIPELINE"
  );

  const plan = buildReportQueryPlan("CANDIDATE_PIPELINE", validated, {
    mode: "export",
    exportLimit: QUERY_LIMITS.max_export_rows
  });

  assert(plan.exportMode === true, "Export plan must set exportMode");
  assert(!plan.dataSql.includes("OFFSET"), "Export plan must not include OFFSET");
  assert(plan.dataSql.includes("LIMIT"), "Export plan must include LIMIT");

  assert(
    formatExportCellValue("2026-05-26T14:06:03.000Z", "date").includes("/"),
    "Date export formatting must use DD/MM/YYYY"
  );

  assert(
    buildExportFilename("CANDIDATE_PIPELINE", "xlsx").endsWith(".xlsx"),
    "Filename must include extension"
  );

  console.log("Report Builder export verification passed.");
}

runChecks();
