const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

const OFFER_HISTORY_EVENT = "AdminOfferTalentPoolRelease";
const PIPELINE_HISTORY_EVENT = "AdminOfferTalentPoolRelease";

const PERMITTED_TERMINAL_OFFER_STATUSES = Object.freeze(
  new Set(["Declined", "Withdrawn"])
);

const PROHIBITED_OFFER_STATUSES = Object.freeze(
  new Set(["Draft", "Pending Approval", "Approved", "Released"])
);

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeReleaseReason(reason) {
  const text = String(reason ?? "").trim();
  if (!text || !/\S/.test(text)) {
    return "";
  }
  return text;
}

function assertAdminUser(req) {
  if (String(req?.user?.role_name || "").trim() !== "Admin") {
    throw httpError("Access Denied - Admin Only", 403);
  }
}

function assertEligibleOfferStatus(offerStatus) {
  const status = String(offerStatus || "").trim();

  if (PERMITTED_TERMINAL_OFFER_STATUSES.has(status)) {
    return status;
  }

  if (status === "Released") {
    throw httpError(
      "Cannot release to Talent Pool while the offer is awaiting candidate response.",
      400
    );
  }

  if (status === "Pending Approval") {
    throw httpError(
      "Cannot release to Talent Pool while offer approval is pending.",
      400
    );
  }

  if (status === "Approved") {
    throw httpError(
      "Cannot release to Talent Pool while the offer is approved but not in a terminal state.",
      400
    );
  }

  if (status === "Draft") {
    throw httpError("Cannot release to Talent Pool for a draft offer.", 400);
  }

  if (status === "Accepted") {
    throw httpError(
      "Accepted offers cannot be released to the Talent Pool until onboarding rules are approved.",
      400
    );
  }

  throw httpError(
    `Offer status ${status || "unknown"} is not eligible for Talent Pool release.`,
    400
  );
}

function canAdminReleaseOfferToTalentPool(offerStatus, alreadyReleased = false) {
  if (alreadyReleased) {
    return false;
  }
  return PERMITTED_TERMINAL_OFFER_STATUSES.has(String(offerStatus || "").trim());
}

const UNRELATED_ACTIVE_MAPPING_MESSAGE =
  "Candidate has an active assignment on another requisition. Resolve that assignment before releasing this offer to the Talent Pool.";

function normalizeOfferMappingContext(offerRow) {
  const candidateId = Number(offerRow?.candidate_id);
  const requisitionCode = String(offerRow?.requisition_code ?? "").trim();
  const rawMappingId = offerRow?.mapping_id;
  const mappingId =
    rawMappingId != null && rawMappingId !== "" ? Number(rawMappingId) : null;

  return {
    candidateId: Number.isFinite(candidateId) ? candidateId : null,
    requisitionCode,
    mappingId: Number.isFinite(mappingId) ? mappingId : null
  };
}

function enterpriseMappingMatchesOfferContext(mappingRow, context) {
  if (!mappingRow || !context) {
    return false;
  }

  const rowReq = String(mappingRow.requisition_code ?? "").trim();
  const rowMappingId =
    mappingRow.mapping_id != null ? Number(mappingRow.mapping_id) : null;
  const rowMapId = mappingRow.map_id != null ? Number(mappingRow.map_id) : null;

  if (context.mappingId != null) {
    if (rowMappingId === context.mappingId || rowMapId === context.mappingId) {
      return true;
    }
  }

  if (context.requisitionCode && rowReq === context.requisitionCode) {
    return true;
  }

  return false;
}

function legacyMappingMatchesOfferContext(legacyRow, context, offerReqId) {
  if (!legacyRow || !context) {
    return false;
  }

  const rowMapId = legacyRow.map_id != null ? Number(legacyRow.map_id) : null;
  if (context.mappingId != null && rowMapId === context.mappingId) {
    return true;
  }

  if (
    offerReqId != null &&
    legacyRow.req_id != null &&
    Number(legacyRow.req_id) === Number(offerReqId)
  ) {
    return true;
  }

  return false;
}

async function resolveRequisitionReqId(client, requisitionCode) {
  const code = String(requisitionCode || "").trim();
  if (!code) {
    return null;
  }

  const result = await client.query(
    `SELECT req_id
     FROM rm_requisitions
     WHERE requisition_code = $1
     LIMIT 1`,
    [code]
  );

  const reqId = result.rows[0]?.req_id;
  return reqId != null ? Number(reqId) : null;
}

async function assertNoUnrelatedActiveMappings(client, candidateId, offerContext) {
  const activeEnterprise = await client.query(
    `SELECT mapping_id, candidate_id, requisition_code, map_id
     FROM rm_candidate_mappings
     WHERE candidate_id = $1
       AND is_active = true
     ORDER BY applied_on DESC`,
    [candidateId]
  );

  const unrelatedEnterprise = activeEnterprise.rows.filter(
    (row) => !enterpriseMappingMatchesOfferContext(row, offerContext)
  );

  if (unrelatedEnterprise.length > 0) {
    throw httpError(UNRELATED_ACTIVE_MAPPING_MESSAGE, 409);
  }

  let unrelatedLegacy = [];

  if (await legacyMapTableExists(client)) {
    const offerReqId = await resolveRequisitionReqId(
      client,
      offerContext.requisitionCode
    );

    const activeLegacy = await client.query(
      `SELECT map_id, candidate_id, req_id
       FROM candidate_req_map
       WHERE candidate_id = $1
         AND is_active = true`,
      [candidateId]
    );

    unrelatedLegacy = activeLegacy.rows.filter(
      (row) => !legacyMappingMatchesOfferContext(row, offerContext, offerReqId)
    );

    if (unrelatedLegacy.length > 0) {
      throw httpError(UNRELATED_ACTIVE_MAPPING_MESSAGE, 409);
    }
  }

  return {
    activeEnterpriseMappings: activeEnterprise.rows,
    offerContext
  };
}

async function deactivateOfferScopedEnterpriseMappings(client, candidateId, offerContext) {
  const requisitionCode = offerContext.requisitionCode;
  const mappingId = offerContext.mappingId;

  if (mappingId != null && requisitionCode) {
    await client.query(
      `UPDATE rm_candidate_mappings
       SET is_active = false,
           modified_on = NOW()
       WHERE candidate_id = $1
         AND is_active = true
         AND (
           mapping_id = $2
           OR map_id = $2
           OR requisition_code = $3
         )`,
      [candidateId, mappingId, requisitionCode]
    );
    return;
  }

  if (mappingId != null) {
    await client.query(
      `UPDATE rm_candidate_mappings
       SET is_active = false,
           modified_on = NOW()
       WHERE candidate_id = $1
         AND is_active = true
         AND (mapping_id = $2 OR map_id = $2)`,
      [candidateId, mappingId]
    );
    return;
  }

  if (requisitionCode) {
    await client.query(
      `UPDATE rm_candidate_mappings
       SET is_active = false,
           modified_on = NOW()
       WHERE candidate_id = $1
         AND is_active = true
         AND requisition_code = $2`,
      [candidateId, requisitionCode]
    );
  }
}

async function deactivateOfferScopedLegacyMappings(client, candidateId, offerContext) {
  if (!(await legacyMapTableExists(client))) {
    return;
  }

  const offerReqId = await resolveRequisitionReqId(client, offerContext.requisitionCode);
  const mappingId = offerContext.mappingId;

  if (mappingId != null && offerReqId != null) {
    await client.query(
      `UPDATE candidate_req_map
       SET is_active = false
       WHERE candidate_id = $1
         AND is_active = true
         AND (map_id = $2 OR req_id = $3)`,
      [candidateId, mappingId, offerReqId]
    );
    return;
  }

  if (mappingId != null) {
    await client.query(
      `UPDATE candidate_req_map
       SET is_active = false
       WHERE candidate_id = $1
         AND is_active = true
         AND map_id = $2`,
      [candidateId, mappingId]
    );
    return;
  }

  if (offerReqId != null) {
    await client.query(
      `UPDATE candidate_req_map
       SET is_active = false
       WHERE candidate_id = $1
         AND is_active = true
         AND req_id = $2`,
      [candidateId, offerReqId]
    );
  }
}

async function legacyMapTableExists(queryable) {
  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'candidate_req_map'
     ) AS exists`
  );
  return Boolean(result.rows[0]?.exists);
}

async function findOfferIdsWithAdminTalentPoolRelease(pool, offerIds = []) {
  if (!offerIds.length) {
    return new Set();
  }

  const result = await pool.query(
    `SELECT DISTINCT offer_id
     FROM om_offer_history
     WHERE event_type = $1
       AND offer_id = ANY($2::varchar[])`,
    [OFFER_HISTORY_EVENT, offerIds]
  );

  return new Set(result.rows.map((row) => String(row.offer_id)));
}

async function insertOfferHistory(client, offerId, offerStatus, reason, user, req) {
  await client.query(
    `INSERT INTO om_offer_history (
      offer_id, event_type, from_status, to_status, actor, actor_role, comments, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      offerId,
      OFFER_HISTORY_EVENT,
      offerStatus,
      offerStatus,
      user.name,
      user.role,
      reason,
      JSON.stringify({
        actorEmployeeCode: req.user?.employee_code || null,
        candidateContainerTarget: "TALENT_POOL"
      })
    ]
  );
}

async function adminReleaseOfferToTalentPool(pool, offerId, reasonInput, req) {
  assertAdminUser(req);
  const reason = normalizeReleaseReason(reasonInput);
  if (!reason) {
    throw httpError("Release reason is required.", 400);
  }

  const user = userContext(req);
  const normalizedOfferId = String(offerId || "").trim();
  if (!normalizedOfferId) {
    throw httpError("Offer id is required.", 400);
  }

  const client = await pool.connect();
  let offerRow = null;
  let candidateId = null;
  let priorContainer = null;
  let primaryMapping = null;
  let idempotent = false;

  try {
    await client.query("BEGIN");

    const offerLock = await client.query(
      `SELECT offer_id, offer_status, candidate_id, mapping_id, requisition_code
       FROM om_offers
       WHERE offer_id = $1
       FOR UPDATE`,
      [normalizedOfferId]
    );
    offerRow = offerLock.rows[0];

    if (!offerRow) {
      throw httpError("Offer not found.", 404);
    }

    const offerStatus = assertEligibleOfferStatus(offerRow.offer_status);
    candidateId = Number(offerRow.candidate_id);

    if (!Number.isFinite(candidateId)) {
      throw httpError("Offer is missing candidate context.", 400);
    }

    const priorRelease = await client.query(
      `SELECT history_id
       FROM om_offer_history
       WHERE offer_id = $1
         AND event_type = $2
       LIMIT 1`,
      [normalizedOfferId, OFFER_HISTORY_EVENT]
    );

    if (priorRelease.rows.length > 0) {
      idempotent = true;
      await client.query("COMMIT");
      return {
        message: "Candidate was already released to the Talent Pool for this offer.",
        offerId: normalizedOfferId,
        candidateId,
        idempotent: true,
        alreadyReleased: true
      };
    }

    const candLock = await client.query(
      `SELECT candidate_id, candidate_container, owner_employee_code
       FROM cand_mstr
       WHERE candidate_id = $1
       FOR UPDATE`,
      [candidateId]
    );
    const candRow = candLock.rows[0];
    if (!candRow) {
      throw httpError("Candidate not found.", 404);
    }

    priorContainer = String(candRow.candidate_container || "").trim() || null;

    const offerContext = normalizeOfferMappingContext(offerRow);
    const { activeEnterpriseMappings } = await assertNoUnrelatedActiveMappings(
      client,
      candidateId,
      offerContext
    );

    primaryMapping =
      activeEnterpriseMappings.find((row) =>
        enterpriseMappingMatchesOfferContext(row, offerContext)
      ) || null;

    await deactivateOfferScopedEnterpriseMappings(client, candidateId, offerContext);
    await deactivateOfferScopedLegacyMappings(client, candidateId, offerContext);

    await client.query(
      `UPDATE cand_mstr
       SET candidate_container = 'TALENT_POOL',
           owner_employee_code = NULL
       WHERE candidate_id = $1`,
      [candidateId]
    );

    const mappingForHistory =
      primaryMapping ||
      (offerRow.mapping_id
        ? {
            mapping_id: offerRow.mapping_id,
            candidate_id: candidateId,
            requisition_code: offerRow.requisition_code
          }
        : null);

    if (mappingForHistory) {
      await client.query(
        `INSERT INTO rm_pipeline_history (
          requisition_code, mapping_id, candidate_id, event_type,
          actor, actor_role, comments, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          mappingForHistory.requisition_code || offerRow.requisition_code || null,
          mappingForHistory.mapping_id || offerRow.mapping_id || null,
          candidateId,
          PIPELINE_HISTORY_EVENT,
          user.name,
          user.role,
          reason,
          JSON.stringify({
            offerId: normalizedOfferId,
            offerStatus,
            actorEmployeeCode: req.user?.employee_code || null,
            requisitionCode: offerRow.requisition_code || null
          })
        ]
      );
    }

    await insertOfferHistory(client, normalizedOfferId, offerStatus, reason, user, req);

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // ignore rollback failures
    }
    throw error;
  } finally {
    client.release();
  }

  await writeEnterpriseAudit(pool, {
    eventType: OFFER_HISTORY_EVENT,
    module: "Offer Management",
    entity: "Candidate",
    entityId: String(candidateId),
    action: `Admin released candidate to Talent Pool after offer ${normalizedOfferId}`,
    previousValue: priorContainer || "PIPELINE",
    newValue: "TALENT_POOL",
    userName: user.name,
    userRole: user.role,
    employeeCode: req.user?.employee_code || null,
    metadata: {
      offerId: normalizedOfferId,
      offerStatus: offerRow.offer_status,
      requisitionCode: offerRow.requisition_code || null,
      mappingId: offerRow.mapping_id || null,
      reason
    }
  });

  return {
    message: "Candidate released to the Talent Pool. Historical offer records are unchanged.",
    offerId: normalizedOfferId,
    candidateId,
    requisitionCode: offerRow.requisition_code || null,
    idempotent: false,
    alreadyReleased: false
  };
}

module.exports = {
  OFFER_HISTORY_EVENT,
  PERMITTED_TERMINAL_OFFER_STATUSES,
  PROHIBITED_OFFER_STATUSES,
  UNRELATED_ACTIVE_MAPPING_MESSAGE,
  normalizeReleaseReason,
  normalizeOfferMappingContext,
  enterpriseMappingMatchesOfferContext,
  legacyMappingMatchesOfferContext,
  assertEligibleOfferStatus,
  canAdminReleaseOfferToTalentPool,
  assertAdminUser,
  findOfferIdsWithAdminTalentPoolRelease,
  adminReleaseOfferToTalentPool
};
