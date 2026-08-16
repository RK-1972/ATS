const reportBuilderMetadataRepository = require("../repositories/reportBuilderMetadataRepository");
const { getDatasetDefinition, isSupportedDatasetCode } = require("./reportBuilderDatasetRegistry");
const { httpError } = require("./reportBuilderQueryValidator");

function resolveRoleName(req) {
  const roleName = String(req.user?.role_name || "").trim();

  if (!roleName) {
    throw httpError("Authenticated user role is required.", 401);
  }

  return roleName;
}

function normalizeDatasetCode(rawValue) {
  return String(rawValue || "").trim();
}

async function prepareAuthorizedReportContext(pool, req, body) {
  const roleName = resolveRoleName(req);
  const datasetCode = normalizeDatasetCode(body?.dataset);

  if (!datasetCode || !isSupportedDatasetCode(datasetCode)) {
    throw httpError("Report dataset is invalid.", 400);
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

  const datasetDefinition = getDatasetDefinition(datasetCode);

  if (dataset.base_view_key !== datasetDefinition.base_view_key) {
    throw httpError("Report dataset is invalid.", 400);
  }

  const queryFields = await reportBuilderMetadataRepository.listAuthorizedQueryFields(
    pool,
    roleName,
    dataset.dataset_id
  );

  return {
    dataset,
    datasetCode,
    queryFields
  };
}

module.exports = {
  prepareAuthorizedReportContext
};
