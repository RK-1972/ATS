/**
 * OTI recruiter actions — explicit human-in-the-loop only (no auto map/register).
 */

const { writeEnterpriseAudit, userContext } = require("../enterpriseAuditService");
const otiCapabilityAuth = require("./otiCapabilityAuth");

const ALLOWED_ACTIONS = new Set(["shortlist", "dismiss", "request_map"]);

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loadResultContext(pool, resultId) {
  const result = await pool.query(
    `SELECT
        r.result_id,
        r.run_id,
        r.candidate_id,
        s.run_uuid,
        s.requisition_code,
        s.initiated_by
     FROM oti_sourcing_result r
     INNER JOIN oti_sourcing_run s ON s.run_id = r.run_id
     WHERE r.result_id = $1
     LIMIT 1`,
    [resultId]
  );

  return result.rows[0] || null;
}

async function writeActionAudit(pool, req, payload) {
  const actor = userContext(req);

  try {
    await writeEnterpriseAudit(pool, {
      eventType: "OtiRecruiterAction",
      module: "recruitment",
      entity: "candidate",
      entityId: String(payload.candidate_id),
      action: payload.action_type,
      userName: actor.name,
      userRole: actor.role,
      metadata: {
        run_id: payload.run_uuid,
        result_id: payload.result_id,
        requisition_code: payload.requisition_code,
        note: payload.note || null,
        auto_mapping: false
      }
    });
  } catch (auditError) {
    console.error("OTI recruiter action audit failed:", auditError.message);
  }
}

async function recordRecruiterAction(pool, resultId, req, body = {}) {
  const numericResultId = Number(resultId);
  if (!Number.isFinite(numericResultId) || numericResultId <= 0) {
    throw httpError("Valid resultId is required.", 400);
  }

  const actionType = String(body.action_type || "").trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(actionType)) {
    throw httpError("Unsupported action_type.", 400);
  }

  const context = await loadResultContext(pool, numericResultId);
  if (!context) {
    throw httpError("Sourcing result not found.", 404);
  }

  const runResult = await pool.query(
    "SELECT * FROM oti_sourcing_run WHERE run_id = $1 LIMIT 1",
    [context.run_id]
  );
  const runRow = runResult.rows[0];

  await otiCapabilityAuth.assertCanPostOtiAction(pool, req, runRow);

  const note = String(body.note || "").trim() || null;
  const actorCode = String(req.user?.employee_code || "").trim();

  const insert = await pool.query(
    `INSERT INTO oti_recruiter_action (
       result_id, run_id, action_type, note, actor_employee_code
     ) VALUES ($1,$2,$3,$4,$5)
     RETURNING action_id, action_type, note, actor_employee_code, created_on`,
    [numericResultId, context.run_id, actionType, note, actorCode]
  );

  await writeActionAudit(pool, req, {
    action_type: actionType,
    candidate_id: context.candidate_id,
    run_uuid: context.run_uuid,
    result_id: numericResultId,
    requisition_code: context.requisition_code,
    note
  });

  const response = {
    action: insert.rows[0],
    intent_only: actionType === "request_map",
    mapping_instructions:
      actionType === "request_map"
        ? "Confirm mapping in the recruiter UI using the existing candidate mapping workflow."
        : null,
    requisition_code: context.requisition_code,
    candidate_id: context.candidate_id
  };

  return response;
}

module.exports = {
  ALLOWED_ACTIONS,
  recordRecruiterAction
};
