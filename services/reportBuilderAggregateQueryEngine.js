const { getDatasetDefinition } = require("./reportBuilderDatasetRegistry");
const { AGGREGATION_SQL, DATE_GRAIN_SQL } = require("./reportBuilderSemanticConstants");
const { buildFilterPredicate } = require("./reportBuilderQueryEngineShared");

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function escapeLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function buildDimensionSqlExpression(dimension) {
  const fieldMeta = dimension.field;
  const baseExpression = fieldMeta.sql_expression;

  if (dimension.grain) {
    const grainUnit = DATE_GRAIN_SQL[dimension.grain];
    return `DATE_TRUNC('${grainUnit}', ${baseExpression})`;
  }

  if (fieldMeta.null_display_label) {
    return `COALESCE((${baseExpression})::text, '${escapeLiteral(fieldMeta.null_display_label)}')`;
  }

  return baseExpression;
}

function buildMeasureSqlExpression(measure) {
  const builder = AGGREGATION_SQL[measure.aggregation];

  if (!builder) {
    throw new Error("Unsupported aggregation.");
  }

  return builder(measure.field.sql_expression);
}

function buildAggregateReportQueryPlan(datasetCode, validatedRequest, options = {}) {
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

  const dimensionSelectParts = validatedRequest.dimensions.map((dimension) => {
    const expression = buildDimensionSqlExpression(dimension);
    return `${expression} AS ${quoteIdentifier(dimension.outputCode)}`;
  });

  const dimensionGroupParts = validatedRequest.dimensions.map((dimension) =>
    buildDimensionSqlExpression(dimension)
  );

  const measureSelectParts = validatedRequest.measures.map((measure) => {
    const expression = buildMeasureSqlExpression(measure);
    return `${expression} AS ${quoteIdentifier(measure.outputCode)}`;
  });

  const selectParts = [...dimensionSelectParts, ...measureSelectParts];

  const orderParts = validatedRequest.sort.map((sortItem) => {
    const direction = sortItem.direction === "desc" ? "DESC" : "ASC";
    return `${quoteIdentifier(sortItem.outputCode)} ${direction}`;
  });

  if (orderParts.length === 0 && validatedRequest.dimensions.length > 0) {
    orderParts.push(`${quoteIdentifier(validatedRequest.dimensions[0].outputCode)} ASC`);
  } else if (orderParts.length === 0 && validatedRequest.measures.length > 0) {
    orderParts.push(`${quoteIdentifier(validatedRequest.measures[0].outputCode)} DESC`);
  }

  const whereSql = whereParts.map((part) => `(${part})`).join(" AND ");
  const groupSql =
    dimensionGroupParts.length > 0 ? `GROUP BY ${dimensionGroupParts.join(", ")}` : "";
  const orderSql =
    orderParts.length > 0 ? `ORDER BY ${orderParts.join(", ")}` : "";

  const innerSelectParts =
    dimensionGroupParts.length > 0
      ? dimensionGroupParts.map((expression, index) => {
          const dimension = validatedRequest.dimensions[index];
          return `${expression} AS ${quoteIdentifier(dimension.outputCode)}`;
        })
      : ["1 AS aggregate_row"];

  const countSql = `
SELECT COUNT(*)::int AS total_count
FROM (
  SELECT ${innerSelectParts.join(", ")}
  ${datasetDefinition.from_sql}
  WHERE ${whereSql}
  ${groupSql}
) aggregate_grain`.trim();

  let dataSql;
  const countParamCount = params.length;

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

  const columns = [
    ...validatedRequest.dimensions.map((dimension) => ({
      code: dimension.outputCode,
      label: dimension.grain
        ? `${dimension.field.label} (${dimension.grain})`
        : dimension.field.label,
      data_type: dimension.grain ? "date" : dimension.field.data_type,
      role: "dimension"
    })),
    ...validatedRequest.measures.map((measure) => ({
      code: measure.outputCode,
      label: measure.alias
        ? measure.alias.replace(/_/g, " ")
        : `${measure.field.label} (${measure.aggregation})`,
      data_type: "number",
      role: "measure",
      aggregation: measure.aggregation
    }))
  ];

  return {
    dataSql,
    countSql,
    params,
    countParamCount,
    exportMode,
    resultMode: "aggregate",
    columns,
    dimensions: validatedRequest.dimensions.map((dimension) => ({
      field: dimension.field.code,
      output_code: dimension.outputCode,
      grain: dimension.grain || null
    })),
    measures: validatedRequest.measures.map((measure) => ({
      field: measure.field.code,
      aggregation: measure.aggregation,
      output_code: measure.outputCode,
      alias: measure.alias
    }))
  };
}

module.exports = {
  buildAggregateReportQueryPlan,
  buildDimensionSqlExpression
};
