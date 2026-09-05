const reportBuilderQueryRepository = require("../repositories/reportBuilderQueryRepository");
const { buildReportQueryPlan } = require("./reportBuilderQueryEngine");
const { buildAggregateReportQueryPlan } = require("./reportBuilderAggregateQueryEngine");
const {
  validateReportQueryRequest
} = require("./reportBuilderQueryValidator");
const { QUERY_LIMITS } = require("./reportBuilderQueryConstants");
const { RESULT_MODES } = require("./reportBuilderSemanticConstants");
const { prepareAuthorizedReportContext } = require("./reportBuilderRequestContext");

function mapRowToBusinessFields(row, columns) {
  const mappedRow = {};

  for (const column of columns) {
    mappedRow[column.code] = row[column.code];
  }

  return mappedRow;
}

function buildVisualizationHint(validatedRequest, queryPlan) {
  if (validatedRequest.resultMode !== RESULT_MODES.AGGREGATE) {
    return null;
  }

  const categoryField = validatedRequest.dimensions[0]?.outputCode || null;
  const valueField = validatedRequest.measures[0]?.outputCode || null;

  if (!valueField) {
    return null;
  }

  return {
    category_field: categoryField,
    value_field: valueField,
    secondary_category_field:
      validatedRequest.dimensions[1]?.outputCode || null
  };
}

async function executeReportQuery(pool, req, body) {
  const { dataset, datasetCode, queryFields } = await prepareAuthorizedReportContext(
    pool,
    req,
    body
  );

  const validatedRequest = validateReportQueryRequest(body, queryFields, datasetCode);

  const queryPlan =
    validatedRequest.resultMode === RESULT_MODES.AGGREGATE
      ? buildAggregateReportQueryPlan(datasetCode, validatedRequest)
      : buildReportQueryPlan(datasetCode, validatedRequest);

  const executionResult = await reportBuilderQueryRepository.executeReportQuery(
    pool,
    queryPlan
  );

  const response = {
    dataset: {
      code: dataset.code,
      name: dataset.name
    },
    result_type: validatedRequest.resultMode,
    columns: queryPlan.columns,
    rows: executionResult.rows.map((row) =>
      mapRowToBusinessFields(row, queryPlan.columns)
    ),
    pagination: {
      page: validatedRequest.pagination.page,
      page_size: validatedRequest.pagination.pageSize,
      total_count: executionResult.totalCount
    },
    limits: {
      max_page_size: QUERY_LIMITS.max_page_size,
      max_export_rows: QUERY_LIMITS.max_export_rows,
      max_fields: QUERY_LIMITS.max_fields,
      max_filters: QUERY_LIMITS.max_filters,
      max_sorts: QUERY_LIMITS.max_sorts,
      max_groups: QUERY_LIMITS.max_groups
    },
    row_level_authorization: {
      applied: false,
      note:
        "No dataset-specific row-level authorization rules are defined for V1.0. Access is governed by dataset and field permissions only."
    }
  };

  if (validatedRequest.resultMode === RESULT_MODES.AGGREGATE) {
    response.dimensions = queryPlan.dimensions;
    response.measures = queryPlan.measures;
    response.visualization = buildVisualizationHint(validatedRequest, queryPlan);
  }

  return response;
}

module.exports = {
  executeReportQuery
};
