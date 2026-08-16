/**
 * Report Builder query engine — limits and semantic operator whitelist.
 */

const QUERY_LIMITS = Object.freeze({
  default_page_size: 25,
  max_page_size: 500,
  max_export_rows: 5000,
  max_fields: 50,
  max_filters: 20,
  max_sorts: 5,
  max_groups: 10
});

const EXPORT_FORMATS = Object.freeze(["xlsx", "csv", "pdf"]);

const FIELD_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

const SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);

const OPERATOR_WHITELIST = Object.freeze({
  text: Object.freeze([
    "equals",
    "contains",
    "starts_with",
    "ends_with",
    "in"
  ]),
  number: Object.freeze([
    "equals",
    "greater_than",
    "greater_than_or_equal",
    "less_than",
    "less_than_or_equal",
    "between"
  ]),
  date: Object.freeze(["equals", "before", "after", "between"]),
  enum: Object.freeze(["equals", "in"]),
  reference: Object.freeze(["equals", "in"])
});

function isAllowedOperator(dataType, operator) {
  const allowed = OPERATOR_WHITELIST[dataType] || [];
  return allowed.includes(operator);
}

module.exports = {
  QUERY_LIMITS,
  FIELD_CODE_PATTERN,
  SORT_DIRECTIONS,
  OPERATOR_WHITELIST,
  EXPORT_FORMATS,
  isAllowedOperator
};
