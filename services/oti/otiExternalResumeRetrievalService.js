/**
 * Licensed external resume retrieval workflow (Phase 4).
 */

const { writeEnterpriseAudit, userContext } = require("../enterpriseAuditService");
const otiCapabilityAuth = require("./otiCapabilityAuth");
const otiExternalLeadService = require("./otiExternalLeadService");
const { getConnector } = require("./connectors/otiConnectorRegistry");
const { assertResumeDownloadPermitted } = require("./connectors/otiConnectorPermissions");
const otiResumeRetrievalGrantService = require("./otiResumeRetrievalGrantService");
const { validateResumeDocument } = require("./otiResumeDocumentValidation");
const otiResumeStorageService = require("./otiResumeStorageService");
const otiExternalResumeIndexService = require("./otiExternalResumeIndexService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function tryDeleteOrphanRetrievalUpload(deps, storageKey) {
  const deleteFn =
    deps.deleteUploadedResumeObject || otiResumeStorageService.deleteUploadedResumeObject;

  if (typeof deleteFn !== "function" || !storageKey) {
    return;
  }

  try {
    await deleteFn(storageKey);
  } catch (cleanupError) {
    console.error("OTI orphaned retrieval upload cleanup failed:", cleanupError.message);
  }
}

async function findLinkedResumeDocument(pool, externalLeadId, contentHash, storageKey) {
  const result = await pool.query(
    `SELECT document_id, storage_key FROM oti_external_resume_document
     WHERE external_lead_id = $1
       AND (content_hash = $2 OR storage_key = $3)
     LIMIT 1`,
    [externalLeadId, contentHash, storageKey]
  );

  return result.rows[0] || null;
}

function resolveConnectorPermissions(connector) {
  if (typeof connector.getPermissionProfile === "function") {
    return connector.getPermissionProfile();
  }

  const config = connector.getConfigurationState?.() || {};

  return {
    provider_key: connector.providerKey,
    profile_search_permitted: true,
    profile_read_permitted: Boolean(config.configured),
    resume_download_permitted: Boolean(config.resume_retrieval_permitted),
    document_retrieval_method: config.resume_retrieval_permitted ? "licensed_api" : "none",
    license_required: true,
    license_configured: Boolean(config.configured),
    supported_document_formats: ["pdf"]
  };
}

async function loadPrimarySource(pool, externalLeadId) {
  const result = await pool.query(
    `SELECT provider_key, source_record_id, profile_url, resume_retrieval_permitted, source_attribution
     FROM oti_external_lead_source
     WHERE external_lead_id = $1
     ORDER BY is_primary DESC, discovered_on DESC
     LIMIT 1`,
    [externalLeadId]
  );

  return result.rows[0] || null;
}

async function assertRecruiterAuthorization(pool, req, externalLeadId, body = {}) {
  const context = otiCapabilityAuth.extractOtiOperationContext(req, body);
  await otiCapabilityAuth.assertExternalLeadAccessible(pool, req, externalLeadId, context);
}

async function getResumeRetrievalStatus(pool, externalLeadId, req) {
  await assertRecruiterAuthorization(pool, req, externalLeadId, req.query || {});
  await otiExternalLeadService.assertExternalLeadExists(pool, externalLeadId);

  const leadResult = await pool.query(
    `SELECT external_lead_id, resume_retrieval_status, resume_index_status, latest_document_id
     FROM oti_external_lead WHERE external_lead_id = $1`,
    [externalLeadId]
  );

  const lead = leadResult.rows[0];
  const source = await loadPrimarySource(pool, externalLeadId);
  const connector = source ? getConnector(source.provider_key) : null;
  const permissions = connector ? resolveConnectorPermissions(connector) : null;

  const indexStatus = await otiExternalResumeIndexService.getPublicExternalIndexStatus(
    pool,
    externalLeadId
  );

  const activeGrant = await pool.query(
    `SELECT grant_uuid, status, expires_on, consumed_on, revoked_on
     FROM oti_resume_retrieval_grant
     WHERE external_lead_id = $1
       AND status IN ('pending', 'retrieving', 'completed')
     ORDER BY created_on DESC
     LIMIT 1`,
    [externalLeadId]
  );

  return {
    external_lead_id: externalLeadId,
    resume_retrieval_status: lead.resume_retrieval_status,
    resume_index_status: lead.resume_index_status || indexStatus.extraction_status,
    permissions,
    source_attribution: source?.source_attribution || null,
    provider_key: source?.provider_key || null,
    active_grant: activeGrant.rows[0] || null,
    index: indexStatus,
    resume_retrieval_permitted: Boolean(permissions?.resume_download_permitted)
  };
}

async function persistDocumentIfNew(pool, externalLeadId, grant, providerKey, validation, storageKey, provenance) {
  const duplicate = await pool.query(
    `SELECT document_id, storage_key, content_hash, detected_format, byte_length
     FROM oti_external_resume_document
     WHERE external_lead_id = $1 AND content_hash = $2 LIMIT 1`,
    [externalLeadId, validation.content_hash]
  );

  if (duplicate.rows[0]) {
    return duplicate.rows[0];
  }

  const insert = await pool.query(
    `INSERT INTO oti_external_resume_document (
       external_lead_id, grant_id, provider_key, storage_key, content_hash,
       mime_type, detected_format, byte_length, provenance
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      externalLeadId,
      grant.grant_id,
      providerKey,
      storageKey,
      validation.content_hash,
      validation.mime,
      validation.format,
      validation.byte_length,
      JSON.stringify(provenance || {})
    ]
  );

  return insert.rows[0];
}

async function executeLicensedRetrieval(pool, externalLeadId, req, body = {}, deps = {}) {
  const numericLeadId = Number(externalLeadId);
  if (!Number.isFinite(numericLeadId) || numericLeadId <= 0) {
    throw httpError("Valid externalLeadId is required.", 400);
  }

  await assertRecruiterAuthorization(pool, req, numericLeadId, body);
  await otiExternalLeadService.assertExternalLeadExists(pool, numericLeadId);

  const actorCode = String(req.user?.employee_code || "").trim();
  const source = await loadPrimarySource(pool, numericLeadId);

  if (!source) {
    throw httpError("External lead source metadata not found.", 404);
  }

  const connector = getConnector(source.provider_key);
  if (!connector) {
    throw httpError("Provider connector is not registered.", 503);
  }

  const permissions = resolveConnectorPermissions(connector);
  assertResumeDownloadPermitted(permissions);

  if (typeof connector.downloadLicensedDocument !== "function") {
    throw httpError("Provider does not implement licensed document retrieval.", 403);
  }

  await pool.query(
    `UPDATE oti_external_lead SET resume_retrieval_status = 'requested', updated_on = NOW() WHERE external_lead_id = $1`,
    [numericLeadId]
  );

  const grant = await otiResumeRetrievalGrantService.createRetrievalGrant(pool, {
    externalLeadId: numericLeadId,
    providerKey: source.provider_key,
    requestedBy: actorCode,
    permissionSnapshot: permissions
  });

  await otiResumeRetrievalGrantService.recordRetrievalEvent(pool, {
    grant_id: grant.grant_id,
    external_lead_id: numericLeadId,
    event_type: "grant_created",
    status: "pending",
    actor_employee_code: actorCode
  });

  otiResumeRetrievalGrantService.assertGrantExecutable(grant, {
    requestedBy: actorCode,
    replayNonce: body.replay_nonce || grant.replay_nonce
  });

  await otiResumeRetrievalGrantService.markGrantStatus(
    pool,
    grant.grant_id,
    "retrieving",
    { increment_attempt: true },
    { requireStatuses: ["pending", "approved"] }
  );

  await pool.query(
    `UPDATE oti_external_lead SET resume_retrieval_status = 'in_progress', updated_on = NOW() WHERE external_lead_id = $1`,
    [numericLeadId]
  );

  let downloadResult;

  try {
    downloadResult = await connector.downloadLicensedDocument({
      sourceRecordId: source.source_record_id,
      profileUrl: source.profile_url,
      externalLeadId: numericLeadId
    });
  } catch (error) {
    await otiResumeRetrievalGrantService.markGrantStatus(
      pool,
      grant.grant_id,
      "failed",
      {
        failure_reason: error.message,
        increment_attempt: false
      },
      { requireStatuses: ["retrieving", "pending", "approved"] }
    ).catch(() => {});
    await pool.query(
      `UPDATE oti_external_lead SET resume_retrieval_status = 'failed', updated_on = NOW() WHERE external_lead_id = $1`,
      [numericLeadId]
    );
    await otiResumeRetrievalGrantService.recordRetrievalEvent(pool, {
      grant_id: grant.grant_id,
      external_lead_id: numericLeadId,
      event_type: "retrieval_failed",
      status: "failed",
      message: error.message,
      actor_employee_code: actorCode
    });
    throw error;
  }

  const validation = validateResumeDocument(downloadResult.buffer, {
    filenameHint: downloadResult.filename_hint,
    allowedFormats: permissions.supported_document_formats || ["pdf", "doc", "docx"]
  });

  if (!validation.ok) {
    await otiResumeRetrievalGrantService
      .markGrantStatus(
        pool,
        grant.grant_id,
        "failed",
        { failure_reason: validation.reason },
        { requireStatuses: ["retrieving", "pending", "approved"] }
      )
      .catch(() => {});
    await pool.query(
      `UPDATE oti_external_lead SET resume_retrieval_status = 'failed', updated_on = NOW() WHERE external_lead_id = $1`,
      [numericLeadId]
    );
    throw httpError(validation.reason, 400);
  }

  const storageKey = otiResumeStorageService.buildExternalResumeObjectKey(
    numericLeadId,
    validation.content_hash,
    validation.format
  );

  let linkedDocument = await findLinkedResumeDocument(
    pool,
    numericLeadId,
    validation.content_hash,
    storageKey
  );
  let uploadedNewObject = !linkedDocument;

  await otiResumeRetrievalGrantService.reloadAndAssertGrantExecutable(pool, grant.grant_id, {
    requestedBy: actorCode,
    replayNonce: body.replay_nonce || grant.replay_nonce
  });

  linkedDocument = await findLinkedResumeDocument(
    pool,
    numericLeadId,
    validation.content_hash,
    storageKey
  );
  uploadedNewObject = !linkedDocument;

  const upload = deps.uploadResumeBuffer || otiResumeStorageService.uploadResumeBuffer;
  let stagingCleanupKey = null;

  if (uploadedNewObject) {
    stagingCleanupKey = otiResumeStorageService.buildRetrievalGrantStagingObjectKey(
      numericLeadId,
      grant.grant_uuid,
      validation.content_hash,
      validation.format
    );
    await upload(stagingCleanupKey, downloadResult.buffer, validation.mime);
  } else {
    await upload(storageKey, downloadResult.buffer, validation.mime);
  }

  let documentRow;
  let grantMarkedCompleted = false;

  try {
    await otiResumeRetrievalGrantService.markGrantStatus(
      pool,
      grant.grant_id,
      "completed",
      { consumed_on: new Date() },
      { requireStatuses: ["retrieving"] }
    );
    grantMarkedCompleted = true;

    if (stagingCleanupKey) {
      const linkedAfterCompletion = await findLinkedResumeDocument(
        pool,
        numericLeadId,
        validation.content_hash,
        storageKey
      );

      if (linkedAfterCompletion) {
        documentRow = linkedAfterCompletion;
        await tryDeleteOrphanRetrievalUpload(deps, stagingCleanupKey);
        stagingCleanupKey = null;
      } else {
        await upload(storageKey, downloadResult.buffer, validation.mime);
        documentRow = await persistDocumentIfNew(
          pool,
          numericLeadId,
          grant,
          source.provider_key,
          validation,
          storageKey,
          downloadResult.provenance
        );
        await tryDeleteOrphanRetrievalUpload(deps, stagingCleanupKey);
        stagingCleanupKey = null;
      }
    } else {
      documentRow = await persistDocumentIfNew(
        pool,
        numericLeadId,
        grant,
        source.provider_key,
        validation,
        storageKey,
        downloadResult.provenance
      );
    }

    await pool.query(
      `UPDATE oti_resume_retrieval_grant
       SET document_id = $2, updated_on = NOW()
       WHERE grant_id = $1 AND status = 'completed' AND revoked_on IS NULL`,
      [grant.grant_id, documentRow.document_id]
    );
  } catch (completionError) {
    if (!grantMarkedCompleted && stagingCleanupKey) {
      await tryDeleteOrphanRetrievalUpload(deps, stagingCleanupKey);
    }

    await pool.query(
      `UPDATE oti_external_lead SET resume_retrieval_status = 'failed', updated_on = NOW() WHERE external_lead_id = $1`,
      [numericLeadId]
    );
    await otiResumeRetrievalGrantService.recordRetrievalEvent(pool, {
      grant_id: grant.grant_id,
      external_lead_id: numericLeadId,
      event_type: "retrieval_aborted",
      status: "revoked",
      message: completionError.message,
      actor_employee_code: actorCode
    });
    throw completionError;
  }

  await pool.query(
    `UPDATE oti_external_lead
     SET resume_retrieval_status = 'completed',
         latest_document_id = $2,
         updated_on = NOW()
     WHERE external_lead_id = $1`,
    [numericLeadId, documentRow.document_id]
  );

  await pool.query(
    `UPDATE oti_external_lead_source
     SET resume_retrieval_permitted = TRUE, retrieved_on = NOW()
     WHERE external_lead_id = $1 AND provider_key = $2`,
    [numericLeadId, source.provider_key]
  );

  const indexStatus = await otiExternalResumeIndexService.indexExternalLeadDocument(
    pool,
    numericLeadId,
    documentRow,
    deps
  );

  await otiResumeRetrievalGrantService.recordRetrievalEvent(pool, {
    grant_id: grant.grant_id,
    external_lead_id: numericLeadId,
    event_type: "retrieval_completed",
    status: "completed",
    actor_employee_code: actorCode
  });

  const actor = userContext(req);

  try {
    await writeEnterpriseAudit(pool, {
      eventType: "OtiExternalResumeRetrieved",
      module: "recruitment",
      entity: "external_lead",
      entityId: String(numericLeadId),
      action: "resume_retrieved",
      userName: actor.name,
      userRole: actor.role,
      metadata: {
        grant_uuid: grant.grant_uuid,
        provider_key: source.provider_key,
        content_hash: validation.content_hash,
        auto_registration: false
      }
    });
  } catch (auditError) {
    console.error("OTI resume retrieval audit failed:", auditError.message);
  }

  return {
    grant_uuid: grant.grant_uuid,
    status: "completed",
    document: {
      document_id: documentRow.document_id,
      storage_key: storageKey,
      content_hash: validation.content_hash,
      format: validation.format,
      byte_length: validation.byte_length,
      duplicate: Boolean(documentRow.created_on && documentRow.document_id)
    },
    index: indexStatus,
    auto_registration: false
  };
}

module.exports = {
  getResumeRetrievalStatus,
  executeLicensedRetrieval,
  resolveConnectorPermissions,
  loadPrimarySource
};
