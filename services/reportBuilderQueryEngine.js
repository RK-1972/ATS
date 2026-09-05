const { getDatasetDefinition } = require("./reportBuilderDatasetRegistry");
const { buildFilterPredicate, quoteIdentifier } = require("./reportBuilderQueryEngineShared");

function buildReportQueryPlan(datasetCode, validatedRequest, options = {}) {
  const datasetDefinition = getDatasetDefinition(datasetCode);
  const exportMode = options.mode === "export";

  if (!datasetDefinition) {
    throw new Error("Unsupported dataset.");
  }

  const params = [];
  const paramIndexRef = { value: 1 };
  const whereParts = [datasetDefinition.base_where_sql];

  for (const filter of validatedRequest.filters) {
    whereParts.push(buildFilterPredicate(filter, params, paramIndexRef));
  }

  const selectParts = validatedRequest.selectedFields.map(
    (field) => `${field.sql_expression} AS ${quoteIdentifier(field.code)}`
  );

  const groupByParts = validatedRequest.groupBy.map(
    (field) => field.sql_expression
  );

  const orderParts = validatedRequest.sort.map((sortItem) => {
    const direction = sortItem.direction === "desc" ? "DESC" : "ASC";
    return `${sortItem.field.sql_expression} ${direction}`;
  });

  if (validatedRequest.groupBy.length === 0) {
    orderParts.push(`${datasetDefinition.grain_expression} ASC`);
  }

  const whereSql = whereParts.map((part) => `(${part})`).join(" AND ");
  const groupSql =
    groupByParts.length > 0 ? `GROUP BY ${groupByParts.join(", ")}` : "";
  const orderSql =
    orderParts.length > 0 ? `ORDER BY ${orderParts.join(", ")}` : "";

  const countSql = `
SELECT COUNT(*)::int AS total_count
FROM (
  SELECT ${datasetDefinition.grain_expression}
  ${datasetDefinition.from_sql}
  WHERE ${whereSql}
  ${groupSql}
) report_grain`.trim();

  let dataSql;
  let countParamCount = params.length;

  if (exportMode) {
    const exportLimit = options.exportLimit;
    const limitParamIndex = paramIndexRef.value;
    params.push(exportLimit);
    paramIndexRef.value += 1;

    dataSql = `
SELECT ${selectParts.join(", ")}
${datasetDefinition.from_sql}
WHERE ${whereSql}
${groupSql}
${orderSql}
LIMIT $${limitParamIndex}`.trim();
  } else {
    const limitParamIndex = paramIndexRef.value;
    params.push(validatedRequest.pagination.pageSize);
    paramIndexRef.value += 1;

    const offsetParamIndex = paramIndexRef.value;
    params.push(validatedRequest.pagination.offset);
    paramIndexRef.value += 1;

    dataSql = `
SELECT ${selectParts.join(", ")}
${datasetDefinition.from_sql}
WHERE ${whereSql}
${groupSql}
${orderSql}
LIMIT $${limitParamIndex}
OFFSET $${offsetParamIndex}`.trim();
  }

  return {
    dataSql,
    countSql,
    params,
    countParamCount,
    exportMode,
    resultMode: "detail",
    columns: validatedRequest.selectedFields.map((field) => ({
      code: field.code,
      label: field.label,
      data_type: field.data_type,
      role: "field"
    }))
  };
}

module.exports = {
  buildReportQueryPlan,
  buildFilterPredicate,
  quoteIdentifier
};
