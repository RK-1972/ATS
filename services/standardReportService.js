const reportBuilderMetadataRepository = require("../repositories/reportBuilderMetadataRepository");
const { httpError } = require("./reportBuilderQueryValidator");
const {
  listStandardReportDefinitions,
  getStandardReportDefinition
} = require("./standardReportRegistry");

function resolveRoleName(req) {
  const roleName = String(req.user?.role_name || "").trim();

  if (!roleName) {
    throw httpError("Authenticated user role is required.", 401);
  }

  return roleName;
}

function toPublicSummary(report) {
  return {
    report_code: report.report_code,
    name: report.name,
    description: report.description,
    category: report.category,
    dataset_code: report.dataset_code,
    display_order: report.display_order,
    icon: report.icon
  };
}

function toPublicDefinition(report) {
  return {
    report_code: report.report_code,
    name: report.name,
    description: report.description,
    category: report.category,
    dataset_code: report.dataset_code,
    display_order: report.display_order,
    icon: report.icon,
    definition: report.definition,
    visualization: report.visualization
  };
}

async function assertDatasetAccess(pool, roleName, datasetCode) {
  const dataset = await reportBuilderMetadataRepository.getActiveDatasetByCode(
    pool,
    datasetCode
  );

  if (!dataset) {
    return false;
  }

  return reportBuilderMetadataRepository.hasDatasetViewPermission(
    pool,
    roleName,
    dataset.dataset_id
  );
}

async function listAuthorizedStandardReports(pool, req) {
  const roleName = resolveRoleName(req);
  const reports = listStandardReportDefinitions();
  const authorized = [];

  for (const report of reports) {
    const canView = await assertDatasetAccess(pool, roleName, report.dataset_code);

    if (canView) {
      authorized.push(toPublicSummary(report));
    }
  }

  return {
    reports: authorized
  };
}

async function getAuthorizedStandardReport(pool, req, reportCode) {
  const roleName = resolveRoleName(req);
  const report = getStandardReportDefinition(reportCode);

  if (!report) {
    throw httpError("Standard report not found.", 404);
  }

  const canView = await assertDatasetAccess(pool, roleName, report.dataset_code);

  if (!canView) {
    throw httpError("Standard report not found.", 404);
  }

  return toPublicDefinition(report);
}

module.exports = {
  listAuthorizedStandardReports,
  getAuthorizedStandardReport
};
