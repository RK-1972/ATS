const reportBuilderMetadataRepository = require("../repositories/reportBuilderMetadataRepository");
const { OPERATOR_WHITELIST } = require("./reportBuilderQueryConstants");
const { DATE_GRAINS } = require("./reportBuilderSemanticConstants");
const { enrichPublicField } = require("./reportBuilderSemanticFieldRegistry");

const SEMANTIC_OPERATORS = OPERATOR_WHITELIST;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function resolveRoleName(req) {
  const roleName = String(req.user?.role_name || "").trim();

  if (!roleName) {
    throw httpError("Authenticated user role is required.", 401);
  }

  return roleName;
}

function normalizeDatasetCode(datasetCode) {
  return String(datasetCode || "").trim();
}

function mapDatasetSummary(row) {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    display_order: row.display_order
  };
}

function mapField(row, datasetCode) {
  const field = {
    code: row.code,
    label: row.label,
    data_type: row.data_type,
    filterable: row.filterable,
    sortable: row.sortable,
    groupable: row.groupable,
    default_visible: row.default_visible,
    display_order: row.display_order
  };

  if (row.enum_values) {
    field.enum_values = row.enum_values;
  }

  return enrichPublicField(datasetCode, {
    ...field,
    is_dimension: row.is_dimension,
    is_measure: row.is_measure,
    supported_aggregations: row.supported_aggregations,
    default_aggregation: row.default_aggregation,
    null_display_label: row.null_display_label,
    supports_date_grain: row.supports_date_grain,
    dimension_order: row.dimension_order
  });
}

function mapFilter(row) {
  const operatorType = row.operator_type;
  const supportedOperators = SEMANTIC_OPERATORS[operatorType] || [];

  return {
    code: row.code,
    field_code: row.field_code,
    label: row.label,
    operator_type: operatorType,
    supported_operators: supportedOperators,
    is_required: row.is_required,
    display_order: row.display_order
  };
}

async function listAuthorizedDatasets(pool, req) {
  const roleName = resolveRoleName(req);
  const rows = await reportBuilderMetadataRepository.listAuthorizedDatasets(
    pool,
    roleName
  );

  return {
    datasets: rows.map(mapDatasetSummary)
  };
}

async function listFilterRecruiters(pool, req) {
  const roleName = resolveRoleName(req);

  const canAccess = await reportBuilderMetadataRepository.hasRecruiterFilterPermission(
    pool,
    roleName
  );

  if (!canAccess) {
    throw httpError("Report filter options not found.", 404);
  }

  const rows = await reportBuilderMetadataRepository.listActiveRecruiters(pool);

  return {
    recruiters: rows.map((row) => ({
      employee_code: row.employee_code,
      full_name: row.full_name
    }))
  };
}

async function listFilterHiringManagers(pool, req) {
  const roleName = resolveRoleName(req);

  const canAccess = await reportBuilderMetadataRepository.hasHiringManagerFilterPermission(
    pool,
    roleName
  );

  if (!canAccess) {
    throw httpError("Report filter options not found.", 404);
  }

  const rows = await reportBuilderMetadataRepository.listActiveHiringManagers(pool);

  return {
    hiring_managers: rows.map((row) => ({
      hiring_manager_id: row.hiring_manager_id,
      hiring_manager_code: row.hiring_manager_code,
      hiring_manager_name: row.hiring_manager_name
    }))
  };
}

async function getDatasetMetadata(pool, req, datasetCodeRaw) {
  const roleName = resolveRoleName(req);
  const datasetCode = normalizeDatasetCode(datasetCodeRaw);

  if (!datasetCode) {
    throw httpError("Report dataset code is required.", 400);
  }

  const dataset = await reportBuilderMetadataRepository.getActiveDatasetByCode(
    pool,
    datasetCode
  );

  if (!dataset) {
    throw httpError("Report dataset not found.", 404);
  }

  const canView = await reportBuilderMetadataRepository.hasDatasetViewPermission(
    pool,
    roleName,
    dataset.dataset_id
  );

  if (!canView) {
    throw httpError("Report dataset not found.", 404);
  }

  const [fields, filters] = await Promise.all([
    reportBuilderMetadataRepository.listAuthorizedFields(
      pool,
      roleName,
      dataset.dataset_id
    ),
    reportBuilderMetadataRepository.listAuthorizedFilters(
      pool,
      roleName,
      dataset.dataset_id
    )
  ]);

  return {
    dataset: mapDatasetSummary(dataset),
    fields: fields.map((row) => mapField(row, datasetCode)),
    filters: filters.map(mapFilter),
    semantic: {
      date_grains: DATE_GRAINS,
      result_modes: ["detail", "aggregate"]
    }
  };
}

module.exports = {
  listAuthorizedDatasets,
  listFilterRecruiters,
  listFilterHiringManagers,
  getDatasetMetadata,
  SEMANTIC_OPERATORS
};
