const reportBuilderQueryRepository = require("../repositories/reportBuilderQueryRepository");
const { buildReportQueryPlan } = require("./reportBuilderQueryEngine");
const {
  validateReportExportRequest,
  httpError
} = require("./reportBuilderQueryValidator");
const { QUERY_LIMITS, EXPORT_FORMATS } = require("./reportBuilderQueryConstants");
const { generateReportExportFile } = require("./reportBuilderExportGenerators");
const { prepareAuthorizedReportContext } = require("./reportBuilderRequestContext");

function normalizeExportFormat(rawValue) {
  const format = String(rawValue || "")
    .trim()
    .toLowerCase();

  if (!EXPORT_FORMATS.includes(format)) {
    throw httpError("Report export format is invalid.", 400);
  }

  return format;
}

function mapRowToBusinessFields(row, columns) {
  const mappedRow = {};

  for (const column of columns) {
    mappedRow[column.code] = row[column.code];
  }

  return mappedRow;
}

async function exportReport(pool, req, body) {
  const format = normalizeExportFormat(body?.format);
  const { dataset, datasetCode, queryFields } = await prepareAuthorizedReportContext(
    pool,
    req,
    body
  );

  const validatedRequest = validateReportExportRequest(body, queryFields, datasetCode);
  const queryPlan = buildReportQueryPlan(datasetCode, validatedRequest, {
    mode: "export",
    exportLimit: QUERY_LIMITS.max_export_rows
  });

  const executionResult = await reportBuilderQueryRepository.executeReportExportQuery(
    pool,
    queryPlan
  );

  if (executionResult.totalCount > QUERY_LIMITS.max_export_rows) {
    throw httpError(
      `Export exceeds the maximum of ${QUERY_LIMITS.max_export_rows.toLocaleString()} records. Refine filters and try again.`,
      400
    );
  }

  const rows = executionResult.rows.map((row) =>
    mapRowToBusinessFields(row, queryPlan.columns)
  );

  const exportContext = {
    dataset: {
      code: dataset.code,
      name: dataset.name
    },
    columns: queryPlan.columns,
    rows,
    filters: validatedRequest.filters,
    totalCount: executionResult.totalCount
  };

  return generateReportExportFile(format, exportContext);
}

module.exports = {
  exportReport
};
