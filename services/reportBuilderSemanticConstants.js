/**
 * Report Builder V1.2 — semantic reporting constants.
 */

const QUERY_LIMITS = Object.freeze({
  max_dimensions: 10,
  max_measures: 10
});

const RESULT_MODES = Object.freeze({
  DETAIL: "detail",
  AGGREGATE: "aggregate"
});

const AGGREGATIONS = Object.freeze([
  "COUNT",
  "COUNT_DISTINCT",
  "SUM",
  "AVG",
  "MIN",
  "MAX"
]);

const AGGREGATION_SQL = Object.freeze({
  COUNT: (expression) => `COUNT(${expression})`,
  COUNT_DISTINCT: (expression) => `COUNT(DISTINCT ${expression})`,
  SUM: (expression) => `SUM(${expression})`,
  AVG: (expression) => `AVG(${expression})`,
  MIN: (expression) => `MIN(${expression})`,
  MAX: (expression) => `MAX(${expression})`
});

const DATE_GRAINS = Object.freeze(["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"]);

const DATE_GRAIN_SQL = Object.freeze({
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  QUARTER: "quarter",
  YEAR: "year"
});

const MEASURE_ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/;

const STAGE_DIMENSION_ORDER = Object.freeze([
  "Applied",
  "Screening",
  "L1 Interview",
  "L2 Interview",
  "Client Interview",
  "Offer",
  "Joined"
]);

function isSupportedAggregation(value) {
  return AGGREGATIONS.includes(String(value || "").trim().toUpperCase());
}

function isSupportedDateGrain(value) {
  return DATE_GRAINS.includes(String(value || "").trim().toUpperCase());
}

function normalizeAggregation(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDateGrain(value) {
  return String(value || "").trim().toUpperCase();
}

module.exports = {
  QUERY_LIMITS: QUERY_LIMITS,
  RESULT_MODES,
  AGGREGATIONS,
  AGGREGATION_SQL,
  DATE_GRAINS,
  DATE_GRAIN_SQL,
  MEASURE_ALIAS_PATTERN,
  STAGE_DIMENSION_ORDER,
  isSupportedAggregation,
  isSupportedDateGrain,
  normalizeAggregation,
  normalizeDateGrain
};
