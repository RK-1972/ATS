const { getDatasetDefinition } = require("./reportBuilderDatasetRegistry");

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function buildFilterPredicate(filter, params, paramIndexRef) {
  const expression = filter.field.sql_expression;
  const operator = filter.operator;
  const dataType = filter.field.data_type;

  if (dataType === "enum" && filter.field.code === "is_active") {
    const boolValue = filter.value === true || filter.value === "true";
    const paramIndex = paramIndexRef.value;
    params.push(boolValue);
    paramIndexRef.value += 1;
    return `${expression} = $${paramIndex}`;
  }

  if (operator === "equals") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;

    if (dataType === "text" || dataType === "enum" || dataType === "reference") {
      return `LOWER((${expression})::text) = LOWER($${paramIndex}::text)`;
    }

    return `${expression} = $${paramIndex}`;
  }

  if (operator === "contains") {
    const paramIndex = paramIndexRef.value;
    params.push(`%${filter.value}%`);
    paramIndexRef.value += 1;
    return `(${expression})::text ILIKE $${paramIndex}`;
  }

  if (operator === "starts_with") {
    const paramIndex = paramIndexRef.value;
    params.push(`${filter.value}%`);
    paramIndexRef.value += 1;
    return `(${expression})::text ILIKE $${paramIndex}`;
  }

  if (operator === "ends_with") {
    const paramIndex = paramIndexRef.value;
    params.push(`%${filter.value}`);
    paramIndexRef.value += 1;
    return `(${expression})::text ILIKE $${paramIndex}`;
  }

  if (operator === "in") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `(${expression})::text = ANY($${paramIndex}::text[])`;
  }

  if (operator === "greater_than") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} > $${paramIndex}`;
  }

  if (operator === "greater_than_or_equal") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} >= $${paramIndex}`;
  }

  if (operator === "less_than") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} < $${paramIndex}`;
  }

  if (operator === "less_than_or_equal") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} <= $${paramIndex}`;
  }

  if (operator === "before") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} < $${paramIndex}::timestamptz`;
  }

  if (operator === "after") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} > $${paramIndex}::timestamptz`;
  }

  if (operator === "between") {
    const startIndex = paramIndexRef.value;
    params.push(filter.value[0]);
    paramIndexRef.value += 1;
    const endIndex = paramIndexRef.value;
    params.push(filter.value[1]);
    paramIndexRef.value += 1;

    if (dataType === "date") {
      return `${expression} BETWEEN $${startIndex}::timestamptz AND $${endIndex}::timestamptz`;
    }

    return `${expression} BETWEEN $${startIndex} AND $${endIndex}`;
  }

  throw new Error("Unsupported filter operator.");
}

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

  // Always tie-break on dataset grain for stable pagination (unless grouping).
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
    columns: validatedRequest.selectedFields.map((field) => ({
      code: field.code,
      label: field.label,
      data_type: field.data_type
    }))
  };
}

module.exports = {
  buildReportQueryPlan
};
