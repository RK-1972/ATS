const {
  QUERY_LIMITS,
  FIELD_CODE_PATTERN,
  SORT_DIRECTIONS,
  isAllowedOperator
} = require("./reportBuilderQueryConstants");
const { RESULT_MODES } = require("./reportBuilderSemanticConstants");
const {
  detectResultMode,
  validateSemanticDimensions,
  validateSemanticMeasures,
  validateAggregateSort
} = require("./reportBuilderSemanticValidator");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertFieldCode(fieldCode, label = "Report field") {
  const code = String(fieldCode || "").trim();

  if (!code || !FIELD_CODE_PATTERN.test(code)) {
    throw httpError(`${label} is invalid.`, 400);
  }

  return code;
}

function assertOperator(operator) {
  const value = String(operator || "").trim();

  if (!value || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw httpError("Report operator is not supported for this field.", 400);
  }

  return value;
}

function normalizePagination(body = {}) {
  const page = Math.max(parseInt(body.page, 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(parseInt(body.pageSize ?? body.page_size, 10) || QUERY_LIMITS.default_page_size, 1),
    QUERY_LIMITS.max_page_size
  );

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
}

function validateFilterValue(fieldMeta, operator, rawValue) {
  const dataType = fieldMeta.data_type;

  if (operator === "between") {
    if (!Array.isArray(rawValue) || rawValue.length !== 2) {
      throw httpError("Report filter value is invalid.", 400);
    }

    return rawValue.map((item) => coerceScalarValue(fieldMeta, item));
  }

  if (operator === "in") {
    if (!Array.isArray(rawValue) || rawValue.length === 0) {
      throw httpError("Report filter value is invalid.", 400);
    }

    return rawValue.map((item) => coerceScalarValue(fieldMeta, item));
  }

  return coerceScalarValue(fieldMeta, rawValue);
}

function coerceScalarValue(fieldMeta, rawValue) {
  const dataType = fieldMeta.data_type;

  if (rawValue === null || rawValue === undefined) {
    throw httpError("Report filter value is invalid.", 400);
  }

  if (dataType === "number") {
    const numericValue = Number(rawValue);

    if (!Number.isFinite(numericValue)) {
      throw httpError("Report filter value is invalid.", 400);
    }

    return numericValue;
  }

  if (dataType === "date") {
    const dateValue = new Date(rawValue);

    if (Number.isNaN(dateValue.getTime())) {
      throw httpError("Report filter value is invalid.", 400);
    }

    return dateValue.toISOString();
  }

  if (dataType === "enum") {
    const textValue = String(rawValue).trim();

    if (!textValue) {
      throw httpError("Report filter value is invalid.", 400);
    }

    if (Array.isArray(fieldMeta.enum_values) && fieldMeta.enum_values.length > 0) {
      const allowed = fieldMeta.enum_values.map((item) => String(item));
      if (!allowed.includes(textValue)) {
        throw httpError("Report filter value is invalid.", 400);
      }
    }

    if (fieldMeta.code === "is_active") {
      if (textValue !== "true" && textValue !== "false") {
        throw httpError("Report filter value is invalid.", 400);
      }

      return textValue === "true";
    }

    return textValue;
  }

  const textValue = String(rawValue).trim();

  if (!textValue) {
    throw httpError("Report filter value is invalid.", 400);
  }

  return textValue;
}

function buildFieldMap(queryFields) {
  const fieldMap = new Map();

  for (const field of queryFields) {
    fieldMap.set(field.code, field);
  }

  return fieldMap;
}

function validateDetailFilters(rawFilters, fieldMap) {
  if (!Array.isArray(rawFilters)) {
    return [];
  }

  if (rawFilters.length > QUERY_LIMITS.max_filters) {
    throw httpError("Too many report filters requested.", 400);
  }

  return rawFilters.map((filter) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      throw httpError("Report filter value is invalid.", 400);
    }

    const fieldCode = assertFieldCode(filter.field, "Report field");
    const fieldMeta = fieldMap.get(fieldCode);

    if (!fieldMeta || !fieldMeta.filterable) {
      throw httpError("Report field is invalid.", 400);
    }

    const operator = assertOperator(filter.operator);

    if (!isAllowedOperator(fieldMeta.data_type, operator)) {
      throw httpError("Report operator is not supported for this field.", 400);
    }

    const value = validateFilterValue(fieldMeta, operator, filter.value);

    return {
      field: fieldMeta,
      operator,
      value
    };
  });
}

function validateDetailReportQueryRequest(body, queryFields, datasetCode) {
  const fieldMap = buildFieldMap(queryFields);
  const pagination = normalizePagination(body);

  const rawFields = body.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw httpError("At least one report field is required.", 400);
  }

  if (rawFields.length > QUERY_LIMITS.max_fields) {
    throw httpError("Too many report fields requested.", 400);
  }

  const selectedFields = [];
  const seenFields = new Set();

  for (const rawFieldCode of rawFields) {
    const fieldCode = assertFieldCode(rawFieldCode);
    const fieldMeta = fieldMap.get(fieldCode);

    if (!fieldMeta) {
      throw httpError("Report field is invalid.", 400);
    }

    if (seenFields.has(fieldCode)) {
      continue;
    }

    seenFields.add(fieldCode);
    selectedFields.push(fieldMeta);
  }

  const filters = validateDetailFilters(body.filters, fieldMap);

  const rawSort = Array.isArray(body.sort) ? body.sort : [];

  if (rawSort.length > QUERY_LIMITS.max_sorts) {
    throw httpError("Too many report sort fields requested.", 400);
  }

  const sort = rawSort.map((sortItem) => {
    if (!sortItem || typeof sortItem !== "object" || Array.isArray(sortItem)) {
      throw httpError("Report field cannot be sorted.", 400);
    }

    const fieldCode = assertFieldCode(sortItem.field, "Report field");
    const fieldMeta = fieldMap.get(fieldCode);

    if (!fieldMeta || !fieldMeta.sortable) {
      throw httpError("Report field cannot be sorted.", 400);
    }

    const direction = String(sortItem.direction || "asc")
      .trim()
      .toLowerCase();

    if (!SORT_DIRECTIONS.includes(direction)) {
      throw httpError("Report field cannot be sorted.", 400);
    }

    return {
      field: fieldMeta,
      direction
    };
  });

  const rawGroupBy = Array.isArray(body.groupBy)
    ? body.groupBy
    : Array.isArray(body.group_by)
      ? body.group_by
      : [];

  if (rawGroupBy.length > QUERY_LIMITS.max_groups) {
    throw httpError("Too many report group fields requested.", 400);
  }

  const groupBy = rawGroupBy.map((rawFieldCode) => {
    const fieldCode = assertFieldCode(rawFieldCode);
    const fieldMeta = fieldMap.get(fieldCode);

    if (!fieldMeta || !fieldMeta.groupable) {
      throw httpError("Report field cannot be grouped.", 400);
    }

    return fieldMeta;
  });

  if (groupBy.length > 0) {
    const groupCodes = new Set(groupBy.map((field) => field.code));

    for (const selectedField of selectedFields) {
      if (!groupCodes.has(selectedField.code)) {
        throw httpError(
          "Selected fields must be included in group_by when grouping is enabled.",
          400
        );
      }
    }
  }

  return {
    resultMode: RESULT_MODES.DETAIL,
    selectedFields,
    filters,
    sort,
    groupBy,
    pagination
  };
}

function validateAggregateReportQueryRequest(body, queryFields, datasetCode) {
  const fieldMap = buildFieldMap(queryFields);
  const pagination = normalizePagination(body);
  const dimensions = validateSemanticDimensions(body.dimensions, fieldMap);
  const measures = validateSemanticMeasures(body.measures, fieldMap);
  const filters = validateDetailFilters(body.filters, fieldMap);
  const sort = validateAggregateSort(body.sort, dimensions, measures);

  return {
    resultMode: RESULT_MODES.AGGREGATE,
    dimensions,
    measures,
    filters,
    sort,
    pagination
  };
}

function validateReportQueryRequest(body, queryFields, datasetCode) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError("Report query request is invalid.", 400);
  }

  const requestedDataset = String(body.dataset || "").trim();

  if (!requestedDataset || requestedDataset !== datasetCode) {
    throw httpError("Report dataset is invalid.", 400);
  }

  const resultMode = detectResultMode(body);

  if (resultMode === RESULT_MODES.AGGREGATE) {
    return validateAggregateReportQueryRequest(body, queryFields, datasetCode);
  }

  return validateDetailReportQueryRequest(body, queryFields, datasetCode);
}

function validateReportExportRequest(body, queryFields, datasetCode) {
  const resultMode = detectResultMode(body);

  if (resultMode === RESULT_MODES.AGGREGATE) {
    const validated = validateAggregateReportQueryRequest(body, queryFields, datasetCode);

    return {
      resultMode: validated.resultMode,
      dimensions: validated.dimensions,
      measures: validated.measures,
      filters: validated.filters,
      sort: validated.sort
    };
  }

  const validated = validateDetailReportQueryRequest(
    {
      ...body,
      page: 1,
      pageSize: 1
    },
    queryFields,
    datasetCode
  );

  return {
    resultMode: validated.resultMode,
    selectedFields: validated.selectedFields,
    filters: validated.filters,
    sort: validated.sort,
    groupBy: validated.groupBy
  };
}

module.exports = {
  validateReportQueryRequest,
  validateReportExportRequest,
  normalizePagination,
  httpError
};
