/**

 * External lead recruiter workflow — explicit actions only (no auto registration).

 */



const { writeEnterpriseAudit, userContext } = require("../enterpriseAuditService");

const otiCapabilityAuth = require("./otiCapabilityAuth");

const otiExternalLeadService = require("./otiExternalLeadService");

const otiExternalResumeRetrievalService = require("./otiExternalResumeRetrievalService");



const ALLOWED_ACTIONS = new Set([

  "shortlist",

  "dismiss",

  "request_import",

  "reject_import",

  "request_resume_retrieval"

]);



const IMPORT_STATUS_BY_ACTION = Object.freeze({

  shortlist: "shortlisted",

  dismiss: "dismissed",

  request_import: "import_requested",

  reject_import: "rejected"

});



function httpError(message, status = 400) {

  const error = new Error(message);

  error.status = status;

  return error;

}



async function loadRunContext(pool, runPublicId) {

  if (!runPublicId) {

    return null;

  }



  const result = await pool.query(

    "SELECT * FROM oti_sourcing_run WHERE run_uuid = $1 LIMIT 1",

    [String(runPublicId).trim()]

  );



  return result.rows[0] || null;

}



async function writeExternalActionAudit(pool, req, payload) {

  const actor = userContext(req);



  try {

    await writeEnterpriseAudit(pool, {

      eventType: "OtiExternalRecruiterAction",

      module: "recruitment",

      entity: "external_lead",

      entityId: String(payload.external_lead_id),

      action: payload.action_type,

      userName: actor.name,

      userRole: actor.role,

      metadata: {

        run_uuid: payload.run_uuid || null,

        note: payload.note || null,

        auto_registration: false,

        resume_downloaded: Boolean(payload.resume_downloaded)

      }

    });

  } catch (auditError) {

    console.error("OTI external recruiter action audit failed:", auditError.message);

  }

}



async function recordExternalLeadAction(pool, externalLeadId, req, body = {}) {

  const numericLeadId = Number(externalLeadId);

  if (!Number.isFinite(numericLeadId) || numericLeadId <= 0) {

    throw httpError("Valid externalLeadId is required.", 400);

  }



  const actionType = String(body.action_type || "").trim().toLowerCase();

  if (!ALLOWED_ACTIONS.has(actionType)) {

    throw httpError("Unsupported action_type.", 400);

  }



  const lead = await otiExternalLeadService.assertExternalLeadExists(pool, numericLeadId);

  const operationContext = otiCapabilityAuth.extractOtiOperationContext(req, body);
  const access = await otiCapabilityAuth.assertExternalLeadAccessible(
    pool,
    req,
    numericLeadId,
    operationContext
  );

  const runRow =
    access.runRow ||
    (operationContext.run_id ? await loadRunContext(pool, operationContext.run_id) : null);



  const note = String(body.note || "").trim() || null;

  const actorCode = String(req.user?.employee_code || "").trim();



  if (actionType === "request_resume_retrieval") {

    const retrieval = await otiExternalResumeRetrievalService.executeLicensedRetrieval(

      pool,

      numericLeadId,

      req,

      body

    );



    const insert = await pool.query(

      `INSERT INTO oti_external_recruiter_action (

         external_lead_id, run_id, action_type, note, actor_employee_code

       ) VALUES ($1,$2,$3,$4,$5)

       RETURNING action_id, action_type, note, actor_employee_code, created_on`,

      [numericLeadId, runRow?.run_id || null, actionType, note, actorCode]

    );



    await writeExternalActionAudit(pool, req, {

      action_type: actionType,

      external_lead_id: numericLeadId,

      run_uuid: runRow?.run_uuid || null,

      note,

      resume_downloaded: true

    });



    return {

      action: insert.rows[0],

      retrieval,

      auto_registration: false,

      import_status: lead.import_status

    };

  }



  const nextStatus = IMPORT_STATUS_BY_ACTION[actionType];



  if (nextStatus) {

    await pool.query(

      `UPDATE oti_external_lead SET import_status = $2, updated_on = NOW() WHERE external_lead_id = $1`,

      [numericLeadId, nextStatus]

    );

  }



  const insert = await pool.query(

    `INSERT INTO oti_external_recruiter_action (

       external_lead_id, run_id, action_type, note, actor_employee_code

     ) VALUES ($1,$2,$3,$4,$5)

     RETURNING action_id, action_type, note, actor_employee_code, created_on`,

    [numericLeadId, runRow?.run_id || null, actionType, note, actorCode]

  );



  await writeExternalActionAudit(pool, req, {

    action_type: actionType,

    external_lead_id: numericLeadId,

    run_uuid: runRow?.run_uuid || null,

    note

  });



  return {

    action: insert.rows[0],

    import_status: nextStatus || lead.import_status,

    auto_registration: false,

    registration_instructions:

      actionType === "request_import"

        ? "Import must be completed manually via the standard candidate registration workflow after compliance review."

        : null

  };

}



module.exports = {

  ALLOWED_ACTIONS,

  recordExternalLeadAction

};


