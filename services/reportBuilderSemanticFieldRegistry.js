/**
 * Backend-only semantic field defaults for Report Builder V1.2.
 * Merged with rb_field metadata; DB migration 045 is authoritative when applied.
 */

const DATASET_FIELD_SEMANTICS = Object.freeze({
  CANDIDATE_PIPELINE: Object.freeze({
    candidate_id: {
      is_dimension: false,
      is_measure: true,
      supported_aggregations: ["COUNT", "COUNT_DISTINCT"],
      default_aggregation: "COUNT_DISTINCT"
    },
    mapping_id: {
      is_measure: true,
      supported_aggregations: ["COUNT", "COUNT_DISTINCT"],
      default_aggregation: "COUNT"
    },
    candidate_code: {
      is_measure: true,
      supported_aggregations: ["COUNT", "COUNT_DISTINCT"],
      default_aggregation: "COUNT_DISTINCT"
    },
    requisition_code: {
      is_dimension: true,
      is_measure: true,
      supported_aggregations: ["COUNT", "COUNT_DISTINCT"],
      default_aggregation: "COUNT_DISTINCT"
    },
    stage_name: {
      is_dimension: true,
      dimension_order: 10
    },
    applied_on: {
      is_dimension: true,
      supports_date_grain: true,
      dimension_order: 20
    },
    department: {
      is_dimension: true,
      dimension_order: 30
    },
    assigned_recruiter_name: {
      is_dimension: true,
      null_display_label: "Unassigned",
      dimension_order: 40
    },
    source_type: {
      is_dimension: true,
      dimension_order: 50
    },
    total_experience: {
      is_dimension: false,
      is_measure: true,
      supported_aggregations: ["AVG", "MIN", "MAX", "COUNT"],
      default_aggregation: "AVG"
    }
  }),
  REQUISITION_SUMMARY: Object.freeze({
    requisition_code: {
      is_dimension: true,
      is_measure: true,
      supported_aggregations: ["COUNT", "COUNT_DISTINCT"],
      default_aggregation: "COUNT_DISTINCT"
    },
    req_status: {
      is_dimension: true,
      dimension_order: 30
    },
    department: {
      is_dimension: true,
      dimension_order: 30
    },
    created_on: {
      is_dimension: true,
      supports_date_grain: true,
      dimension_order: 20
    },
    assigned_recruiter_name: {
      is_dimension: true,
      null_display_label: "Unassigned",
      dimension_order: 40
    },
    headcount: {
      is_measure: true,
      supported_aggregations: ["SUM", "AVG", "MIN", "MAX", "COUNT"],
      default_aggregation: "SUM"
    }
  })
});

function enrichQueryField(datasetCode, fieldRow) {
  const defaults = DATASET_FIELD_SEMANTICS[datasetCode]?.[fieldRow.code] || {};
  const isDimension =
    fieldRow.is_dimension !== undefined && fieldRow.is_dimension !== null
      ? Boolean(fieldRow.is_dimension)
      : Boolean(defaults.is_dimension || fieldRow.is_groupable);

  const isMeasure =
    fieldRow.is_measure !== undefined && fieldRow.is_measure !== null
      ? Boolean(fieldRow.is_measure)
      : Boolean(defaults.is_measure);

  return {
    ...fieldRow,
    is_dimension: isDimension,
    is_measure: isMeasure,
    supported_aggregations:
      fieldRow.supported_aggregations || defaults.supported_aggregations || null,
    default_aggregation:
      fieldRow.default_aggregation || defaults.default_aggregation || null,
    null_display_label:
      fieldRow.null_display_label || defaults.null_display_label || null,
    supports_date_grain:
      fieldRow.supports_date_grain !== undefined &&
      fieldRow.supports_date_grain !== null
        ? Boolean(fieldRow.supports_date_grain)
        : Boolean(defaults.supports_date_grain || fieldRow.data_type === "date"),
    dimension_order:
      fieldRow.dimension_order !== undefined && fieldRow.dimension_order !== null
        ? fieldRow.dimension_order
        : defaults.dimension_order ?? null
  };
}

function enrichQueryFields(datasetCode, fieldRows) {
  return fieldRows.map((row) => enrichQueryField(datasetCode, row));
}

function enrichPublicField(datasetCode, fieldRow) {
  const enriched = enrichQueryField(datasetCode, fieldRow);
  return {
    ...fieldRow,
    dimension_eligible: Boolean(enriched.is_dimension),
    measure_eligible: Boolean(enriched.is_measure),
    supports_date_grain: Boolean(enriched.supports_date_grain),
    supported_aggregations: enriched.supported_aggregations,
    default_aggregation: enriched.default_aggregation,
    null_display_label: enriched.null_display_label,
    dimension_order: enriched.dimension_order
  };
}

module.exports = {
  DATASET_FIELD_SEMANTICS,
  enrichQueryFields,
  enrichPublicField
};
