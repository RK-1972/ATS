const {
  FIELD_CODE_PATTERN,
  SORT_DIRECTIONS,
  QUERY_LIMITS,
  isAllowedOperator
} = require("./reportBuilderQueryConstants");
const {
  RESULT_MODES,
  QUERY_LIMITS: SEMANTIC_LIMITS,
  MEASURE_ALIAS_PATTERN,
  isSupportedAggregation,
  isSupportedDateGrain,
  normalizeAggregation,
  normalizeDateGrain
} = require("./reportBuilderSemanticConstants");

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

function assertMeasureAlias(alias) {
  const value = String(alias || "").trim();

  if (!value || !MEASURE_ALIAS_PATTERN.test(value)) {
    throw httpError("Report measure alias is invalid.", 400);
  }

  return value;
}

function buildFieldMap(queryFields) {
  const fieldMap = new Map();

  for (const field of queryFields) {
    fieldMap.set(field.code, field);
  }

  return fieldMap;
}

function detectResultMode(body) {
  const hasFields = Array.isArray(body?.fields) && body.fields.length > 0;
  const hasDimensions =
    Array.isArray(body?.dimensions) && body.dimensions.length > 0;
  const hasMeasures = Array.isArray(body?.measures) && body.measures.length > 0;

  if (hasFields && (hasDimensions || hasMeasures)) {
    throw httpError(
      "Report query cannot combine detail fields with dimensions or measures.",
      400
    );
  }

  if (hasDimensions || hasMeasures) {
    return RESULT_MODES.AGGREGATE;
  }

  return RESULT_MODES.DETAIL;
}

function resolveMeasureOutputCode(measure, fieldMeta) {
  if (measure.alias) {
    return measure.alias;
  }

  return `${fieldMeta.code}__${measure.aggregation.toLowerCase()}`;
}

function resolveDimensionOutputCode(dimension, fieldMeta) {
  if (dimension.grain) {
    return `${fieldMeta.code}__${dimension.grain.toLowerCase()}`;
  }

  return fieldMeta.code;
}

function validateSemanticDimensions(rawDimensions, fieldMap) {
  if (!Array.isArray(rawDimensions)) {
    return [];
  }

  if (rawDimensions.length > SEMANTIC_LIMITS.max_dimensions) {
    throw httpError("Too many report dimensions requested.", 400);
  }

  return rawDimensions.map((dimensionItem) => {
    if (!dimensionItem || typeof dimensionItem !== "object" || Array.isArray(dimensionItem)) {
      throw httpError("Report dimension is invalid.", 400);
    }

    const fieldCode = assertFieldCode(dimensionItem.field, "Report dimension");
    const fieldMeta = fieldMap.get(fieldCode);

    if (!fieldMeta || !fieldMeta.is_dimension) {
      throw httpError("Report dimension is invalid.", 400);
    }

    let grain = null;

    if (dimensionItem.grain !== undefined && dimensionItem.grain !== null && dimensionItem.grain !== "") {
      grain = normalizeDateGrain(dimensionItem.grain);

      if (!isSupportedDateGrain(grain)) {
        throw httpError("Report date grain is invalid.", 400);
      }

      if (fieldMeta.data_type !== "date" || !fieldMeta.supports_date_grain) {
        throw httpError("Report dimension cannot use date grain.", 400);
      }
    }

    return {
      field: fieldMeta,
      grain,
      outputCode: resolveDimensionOutputCode({ grain }, fieldMeta)
    };
  });
}

function validateSemanticMeasures(rawMeasures, fieldMap) {
  if (!Array.isArray(rawMeasures) || rawMeasures.length === 0) {
    throw httpError("At least one report measure is required for aggregate mode.", 400);
  }

  if (rawMeasures.length > SEMANTIC_LIMITS.max_measures) {
    throw httpError("Too many report measures requested.", 400);
  }

  const usedAliases = new Set();

  return rawMeasures.map((measureItem) => {
    if (!measureItem || typeof measureItem !== "object" || Array.isArray(measureItem)) {
      throw httpError("Report measure is invalid.", 400);
    }

    const fieldCode = assertFieldCode(measureItem.field, "Report measure");
    const fieldMeta = fieldMap.get(fieldCode);

    if (!fieldMeta || !fieldMeta.is_measure) {
      throw httpError("Report measure is invalid.", 400);
    }

    const aggregation = normalizeAggregation(
      measureItem.aggregation || fieldMeta.default_aggregation
    );

    if (!isSupportedAggregation(aggregation)) {
      throw httpError("Report aggregation is not supported.", 400);
    }

    const supported = Array.isArray(fieldMeta.supported_aggregations)
      ? fieldMeta.supported_aggregations.map((item) => normalizeAggregation(item))
      : [];

    if (!supported.includes(aggregation)) {
      throw httpError("Report aggregation is not supported for this field.", 400);
    }

    const alias = measureItem.alias
      ? assertMeasureAlias(measureItem.alias)
      : resolveMeasureOutputCode({ aggregation }, fieldMeta);

    if (usedAliases.has(alias)) {
      throw httpError("Report measure alias must be unique.", 400);
    }

    usedAliases.add(alias);

    return {
      field: fieldMeta,
      aggregation,
      alias,
      outputCode: alias
    };
  });
}

function validateAggregateSort(rawSort, dimensionOutputs, measureOutputs) {
  const sortableCodes = new Map();

  for (const dimension of dimensionOutputs) {
    sortableCodes.set(dimension.outputCode, dimension);
  }

  for (const measure of measureOutputs) {
    sortableCodes.set(measure.outputCode, measure);
  }

  if (!Array.isArray(rawSort)) {
    return [];
  }

  if (rawSort.length > QUERY_LIMITS.max_sorts) {
    throw httpError("Too many report sort fields requested.", 400);
  }

  return rawSort.map((sortItem) => {
    if (!sortItem || typeof sortItem !== "object" || Array.isArray(sortItem)) {
      throw httpError("Report field cannot be sorted.", 400);
    }

    const sortField = assertFieldCode(sortItem.field, "Report sort field");
    const sortTarget = sortableCodes.get(sortField);

    if (!sortTarget) {
      throw httpError("Report field cannot be sorted.", 400);
    }

    const direction = String(sortItem.direction || "asc")
      .trim()
      .toLowerCase();

    if (!SORT_DIRECTIONS.includes(direction)) {
      throw httpError("Report field cannot be sorted.", 400);
    }

    return {
      outputCode: sortField,
      direction
    };
  });
}

module.exports = {
  detectResultMode,
  resolveMeasureOutputCode,
  resolveDimensionOutputCode,
  validateSemanticDimensions,
  validateSemanticMeasures,
  validateAggregateSort,
  buildFieldMap,
  httpError
};
