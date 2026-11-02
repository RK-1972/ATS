/**
 * Talent Intelligence (OTI) — feature and workspace authorization.
 */

const workAssignmentService = require("../workAssignmentService");
const { resolveWorkspaceFlagsFromAssignments } = require("../workspaceResolverService");
const resumeMatchService = require("../resumeMatchService");
const legacyOperationalAdapter = require("../legacyOperationalAdapter");
const { REQUISITION_STATUS } = require("../../constants/requisitionStatus");
const { describeConnectorCatalog } = require("./connectors/otiConnectorRegistry");
const { listProviders } = require("./embeddings/otiEmbeddingProviderRegistry");
const otiEmbeddingService = require("./otiEmbeddingService");
const otiAiGovernanceService = require("./otiAiGovernanceService");
const { inspectPgVectorCapability } = require("./otiPgVectorCapability");
const { listProviders: listAiProviders } = require("./ai/otiAiProviderRegistry");

const FEATURE_KEY = "talent_intelligence";
const WORKSPACE_FLAG = "showTalentIntelligenceWorkspace";
const WORKSPACE_DENIED =
  "Enterprise Access Denied. You are not authorized to access Talent Intelligence.";

function authError(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isAdminUser(req) {
  return String(req.user?.role_name || "").trim() === "Admin";
}

function isTaLeadRole(req) {
  const role = String(req.user?.role_name || "").trim();
  return role === "TA Lead" || role === "TA Leader";
}

function isRecruiterRole(req) {
  return String(req.user?.role_name || "").trim() === "Recruiter";
}

async function recruiterHasAssignedRequisitions(pool, employeeCode) {
  const rows = await legacyOperationalAdapter.getMyRequisitions(
    pool,
    String(employeeCode || "").trim()
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function loadPlatformConfig(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );
  return result.rows[0]?.published_payload || null;
}

function isAiModuleEnabled(platformConfig) {
  const aiModule = platformConfig?.modules?.find((item) => item.key === "ai");
  return Boolean(aiModule?.enabled);
}

function isOtiFeatureEnabled(platformConfig) {
  if (!isAiModuleEnabled(platformConfig)) {
    return false;
  }

  const features = platformConfig?.ai_features || [];
  const feature = features.find((item) => item.key === FEATURE_KEY);
  return Boolean(feature?.enabled);
}

async function getOtiAvailability(pool) {
  const platformConfig = await loadPlatformConfig(pool);
  const featureEnabled = isOtiFeatureEnabled(platformConfig);
  let connectors = [];

  if (featureEnabled) {
    try {
      connectors = await describeConnectorCatalog({ publicView: true });
    } catch {
      connectors = [];
    }
  }

  const configuredConnectors = connectors.filter((item) => item.configuration?.configured);
  let pgvectorCapability = null;

  if (featureEnabled) {
    try {
      pgvectorCapability = await inspectPgVectorCapability(pool);
    } catch {
      pgvectorCapability = null;
    }
  }

  let aiAssist = {
    feature_enabled: false,
    provider_configured: false,
    available: false,
    limits: null
  };

  if (featureEnabled) {
    try {
      aiAssist = await otiAiGovernanceService.getAiAssistAvailability(pool);
    } catch {
      aiAssist = {
        feature_enabled: false,
        provider_configured: false,
        available: false,
        limits: null
      };
    }
  }

  return {
    ai_module_enabled: isAiModuleEnabled(platformConfig),
    feature_enabled: featureEnabled,
    available: featureEnabled,
    resume_indexing_enabled: featureEnabled,
    external_discovery_enabled: featureEnabled,
    connectors,
    configured_connector_count: configuredConnectors.length,
    semantic_search_enabled: featureEnabled && otiEmbeddingService.isEmbeddingConfigured(),
    embedding_providers: listProviders(),
    pgvector_capability: pgvectorCapability,
    ai_assist_enabled: aiAssist.available,
    ai_assist: aiAssist,
    ai_reasoning_providers: listAiProviders()
  };
}

async function assertOtiFeatureEnabled(pool) {
  const platformConfig = await loadPlatformConfig(pool);

  if (!isOtiFeatureEnabled(platformConfig)) {
    throw authError("Talent Intelligence is disabled.", 403);
  }
}

async function assertCanAccessOtiWorkspace(pool, req) {
  if (isAdminUser(req)) {
    return;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  if (!employeeCode) {
    throw authError(WORKSPACE_DENIED);
  }

  const assignments = await workAssignmentService.getEmployeeWorkAssignments(
    pool,
    employeeCode
  );
  const workspace = resolveWorkspaceFlagsFromAssignments(assignments);

  if (workspace[WORKSPACE_FLAG]) {
    if (isTaLeadRole(req)) {
      const { assertCanAssignRecruiters } = require("../requisitionCapabilityAuth");
      await assertCanAssignRecruiters(pool, req);
    }
    return;
  }

  if (isRecruiterRole(req) && (await recruiterHasAssignedRequisitions(pool, employeeCode))) {
    return;
  }

  throw authError(WORKSPACE_DENIED);
}

async function resolveOtiWorkspaceNavEligibility(pool, req) {
  try {
    await assertOtiFeatureEnabled(pool);
  } catch {
    return false;
  }

  if (isAdminUser(req)) {
    return true;
  }

  try {
    await assertCanAccessOtiWorkspace(pool, req);
    return true;
  } catch {
    return false;
  }
}

async function assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisition) {
  await assertOtiFeatureEnabled(pool);
  await resumeMatchService.assertResumeMatchAccess(pool, req, requisition);
}

async function assertCanExecuteOtiWorkspaceSourcingRun(pool, req, requisition) {
  await assertCanAccessOtiWorkspace(pool, req);
  await assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisition);
}

/** Requisition sourcing panel — feature gate + requisition resume-match access (no workspace assignment). */
async function assertCanExecuteOtiRun(pool, req, requisition) {
  return assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisition);
}

async function assertCanAccessOtiRunRecord(pool, req, runRow) {
  await assertOtiFeatureEnabled(pool);

  if (!runRow) {
    throw authError("Sourcing run not found.", 404);
  }

  if (isAdminUser(req)) {
    return;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  if (!employeeCode) {
    throw authError("Enterprise Access Denied.", 403);
  }

  if (String(runRow.initiated_by || "").trim() === employeeCode) {
    return;
  }

  const requisitionResult = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
    [runRow.requisition_code]
  );
  const requisition = requisitionResult.rows[0] || null;

  try {
    await resumeMatchService.assertResumeMatchAccess(pool, req, requisition);
    return;
  } catch (_error) {
    // fall through
  }

  throw authError("Enterprise Access Denied. You are not authorized to view this sourcing run.", 403);
}

async function assertCanPostOtiAction(pool, req, runRow) {
  await assertCanAccessOtiRunRecord(pool, req, runRow);
}

function extractOtiOperationContext(req, payload = {}) {
  const merged = { ...(req.query || {}), ...(payload || {}) };
  return {
    run_id: String(merged.run_id || "").trim() || null,
    requisition_code: String(merged.requisition_code || "").trim() || null
  };
}

async function assertExternalLeadAccessible(pool, req, externalLeadId, context = {}) {
  await assertOtiFeatureEnabled(pool);

  const numericLeadId = Number(externalLeadId);
  if (!Number.isFinite(numericLeadId) || numericLeadId <= 0) {
    throw authError("Valid external lead id is required.", 400);
  }

  const runPublicId = context.run_id;
  const requisitionCode = context.requisition_code;

  if (!runPublicId && !requisitionCode) {
    throw authError("run_id or requisition_code is required.", 403);
  }

  if (runPublicId) {
    const runResult = await pool.query(
      "SELECT * FROM oti_sourcing_run WHERE run_uuid = $1 LIMIT 1",
      [runPublicId]
    );
    const runRow = runResult.rows[0];
    if (!runRow) {
      throw authError("Sourcing run not found.", 404);
    }

    await assertCanAccessOtiRunRecord(pool, req, runRow);

    const linkResult = await pool.query(
      `SELECT 1 FROM oti_external_run_lead
       WHERE run_id = $1 AND external_lead_id = $2
       LIMIT 1`,
      [runRow.run_id, numericLeadId]
    );

    if (!linkResult.rows[0]) {
      throw authError("External lead is not part of this sourcing run.", 403);
    }

    return { runRow };
  }

  const requisitionResult = await pool.query(
    "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
    [requisitionCode]
  );
  const requisition = requisitionResult.rows[0] || null;

  await assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisition);

  const linkResult = await pool.query(
    `SELECT 1
     FROM oti_external_run_lead rl
     INNER JOIN oti_sourcing_run s ON s.run_id = rl.run_id
     WHERE rl.external_lead_id = $1 AND s.requisition_code = $2
     LIMIT 1`,
    [numericLeadId, requisitionCode]
  );

  if (!linkResult.rows[0]) {
    throw authError("External lead is not associated with this requisition.", 403);
  }

  return { requisition };
}

async function assertCanAccessOtiFeatureMetadata(pool, req, context = {}) {
  await assertOtiFeatureEnabled(pool);

  if (isAdminUser(req)) {
    return;
  }

  try {
    await assertCanAccessOtiWorkspace(pool, req);
    return;
  } catch (_workspaceError) {
    // fall through
  }

  const requisitionCode = String(context.requisition_code || "").trim();
  if (requisitionCode) {
    const requisitionResult = await pool.query(
      "SELECT * FROM rm_requisitions WHERE requisition_code = $1 LIMIT 1",
      [requisitionCode]
    );
    await assertCanExecuteOtiRequisitionSourcingRun(pool, req, requisitionResult.rows[0]);
    return;
  }

  throw authError(
    "Enterprise Access Denied. Talent Intelligence metadata requires workspace access or an authorized requisition context.",
    403
  );
}

async function listTalentIntelligenceWorkspaceRequisitions(pool, req) {
  await assertOtiFeatureEnabled(pool);
  await assertCanAccessOtiWorkspace(pool, req);

  if (isAdminUser(req)) {
    const result = await pool.query(
      `SELECT r.req_id, r.requisition_code AS req_code,
              r.business_unit AS client_name, r.department AS project_name,
              r.position_title AS job_title, r.primary_skill, NULL AS secondary_skill,
              r.headcount AS openings_count, r.location AS work_location,
              'High' AS priority_level, r.req_status, NULL AS target_date,
              NULL AS recruiter_code, NULL AS assigned_on
       FROM rm_requisitions r
       WHERE r.req_status = $1
       ORDER BY r.requisition_code ASC`,
      [REQUISITION_STATUS.APPROVED]
    );

    return result.rows;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  if (!employeeCode) {
    throw authError("Authenticated employee_code is required.", 401);
  }

  return legacyOperationalAdapter.getMyRequisitions(pool, employeeCode);
}

const OTI_EXTERNAL_LEAD_SOURCE_PREFIX = "oti-external-lead:";

/**
 * DRAFT access for OTI external-lead intakes — mirrors run access without run_id context:
 * run initiator OR resume-match access on any requisition linked to the lead.
 */
async function canAccessOtiExternalLeadDraft(pool, req, externalLeadId) {
  if (isAdminUser(req)) {
    return true;
  }

  const numericLeadId = Number(externalLeadId);
  if (!Number.isFinite(numericLeadId) || numericLeadId <= 0) {
    return false;
  }

  try {
    await assertOtiFeatureEnabled(pool);
  } catch {
    return false;
  }

  const employeeCode = String(req.user?.employee_code || "").trim();
  if (!employeeCode) {
    return false;
  }

  const initiatorResult = await pool.query(
    `SELECT 1
     FROM oti_external_run_lead rl
     INNER JOIN oti_sourcing_run s ON s.run_id = rl.run_id
     WHERE rl.external_lead_id = $1
       AND TRIM(s.initiated_by) = $2
     LIMIT 1`,
    [numericLeadId, employeeCode]
  );

  if (initiatorResult.rowCount > 0) {
    return true;
  }

  const requisitionResult = await pool.query(
    `SELECT DISTINCT r.*
     FROM oti_external_run_lead rl
     INNER JOIN oti_sourcing_run s ON s.run_id = rl.run_id
     INNER JOIN rm_requisitions r ON r.requisition_code = s.requisition_code
     WHERE rl.external_lead_id = $1`,
    [numericLeadId]
  );

  for (const requisition of requisitionResult.rows) {
    try {
      await resumeMatchService.assertResumeMatchAccess(pool, req, requisition);
      return true;
    } catch (_error) {
      // try next linked requisition
    }
  }

  return false;
}

module.exports = {
  FEATURE_KEY,
  WORKSPACE_FLAG,
  getOtiAvailability,
  assertOtiFeatureEnabled,
  assertCanAccessOtiWorkspace,
  assertCanExecuteOtiRequisitionSourcingRun,
  assertCanExecuteOtiWorkspaceSourcingRun,
  assertCanExecuteOtiRun,
  assertCanAccessOtiRunRecord,
  assertCanPostOtiAction,
  extractOtiOperationContext,
  assertExternalLeadAccessible,
  assertCanAccessOtiFeatureMetadata,
  listTalentIntelligenceWorkspaceRequisitions,
  resolveOtiWorkspaceNavEligibility,
  isAdminUser,
  isTaLeadRole,
  isRecruiterRole,
  OTI_EXTERNAL_LEAD_SOURCE_PREFIX,
  canAccessOtiExternalLeadDraft
};
