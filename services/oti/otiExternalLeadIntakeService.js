/**
 * Bridge OTI external leads into the standard rm_candidate_intake + parse workflow.
 */

const otiCapabilityAuth = require("./otiCapabilityAuth");
const otiExternalLeadService = require("./otiExternalLeadService");
const otiPublicResumeDocumentService = require("./otiPublicResumeDocumentService");
const {
  createDraftCandidateFromParsedIntake,
  applyParsedResumeToDraftCandidate
} = require("../candidateDraftService");

const OTI_SOURCE_REFERENCE_PREFIX = "oti-external-lead:";
const OTI_SOURCE_CODE = "API";

function buildSourceReference(externalLeadId) {
  return `${OTI_SOURCE_REFERENCE_PREFIX}${externalLeadId}`;
}

function parseExternalLeadIdFromReference(sourceReference) {
  if (
    typeof sourceReference !== "string" ||
    !sourceReference.startsWith(OTI_SOURCE_REFERENCE_PREFIX)
  ) {
    return null;
  }

  const leadId = Number(sourceReference.slice(OTI_SOURCE_REFERENCE_PREFIX.length));

  return Number.isFinite(leadId) && leadId > 0 ? leadId : null;
}

async function resolveOtiIntakeSourceId(pool) {
  const result = await pool.query(
    `
    SELECT id AS source_id
    FROM md_candidate_sources
    WHERE UPPER(code) = $1
      AND status = 'Active'
    ORDER BY id
    LIMIT 1
    `,
    [OTI_SOURCE_CODE]
  );

  if (result.rows[0]?.source_id) {
    return String(result.rows[0].source_id);
  }

  const fallback = await pool.query(
    `
    SELECT id AS source_id
    FROM md_candidate_sources
    WHERE status = 'Active'
    ORDER BY name ASC, id
    LIMIT 1
    `
  );

  return fallback.rows[0]?.source_id ? String(fallback.rows[0].source_id) : null;
}

async function reparsedCandidateFromIntakeResume(intake, deps) {
  const { downloadResumeFromStorage, extractPdfText, parseBasicCandidateInfo } = deps;

  if (!intake?.resume_path) {
    return null;
  }

  const originalFileName = String(intake.original_file_name || "").toLowerCase();

  if (originalFileName && !originalFileName.endsWith(".pdf")) {
    return null;
  }

  const resumeBuffer = await downloadResumeFromStorage(intake.resume_path);
  const extractedText = await extractPdfText(resumeBuffer);
  const parsed_candidate = parseBasicCandidateInfo(extractedText);

  return {
    parsed_candidate,
    extracted_text: extractedText
  };
}

async function refreshDraftFromReparsedIntake(pool, candidateId, intake, parsedCandidate, deps) {
  const numericCandidateId = Number(candidateId);

  if (!Number.isFinite(numericCandidateId) || numericCandidateId <= 0) {
    return;
  }

  if (!parsedCandidate?.candidate_name) {
    return;
  }

  const client = await pool.connect();

  try {
    await applyParsedResumeToDraftCandidate(
      client,
      numericCandidateId,
      parsedCandidate,
      intake.resume_path,
      {
        splitCandidateName: deps.splitCandidateName,
        normalizeExperience: deps.normalizeExperience
      }
    );
  } finally {
    client.release();
  }
}

async function runIntakeParseForIntake(pool, intake, createdBy, deps) {
  const {
    downloadResumeFromStorage,
    extractPdfText,
    parseBasicCandidateInfo,
    splitCandidateName,
    normalizeExperience,
    markIntakeParsingFailed
  } = deps;

  const intakeId = intake.intake_id;

  if (!intake.resume_path) {
    const errorMessage = "Resume path is not set for this intake record.";
    await markIntakeParsingFailed(intakeId, errorMessage);
    throw Object.assign(new Error(errorMessage), { status: 400 });
  }

  let resumeBuffer;

  try {
    resumeBuffer = await downloadResumeFromStorage(intake.resume_path);
  } catch (downloadError) {
    const errorMessage = `Failed to download resume from storage: ${downloadError.message}`;
    await markIntakeParsingFailed(intakeId, errorMessage);
    throw Object.assign(new Error(errorMessage), { status: 500 });
  }

  const originalFileName = String(intake.original_file_name || "").toLowerCase();

  if (originalFileName && !originalFileName.endsWith(".pdf")) {
    const errorMessage = "Only PDF resume parsing is currently supported.";
    await markIntakeParsingFailed(intakeId, errorMessage);
    throw Object.assign(new Error(errorMessage), { status: 400 });
  }

  let extractedText;

  try {
    extractedText = await extractPdfText(resumeBuffer);
  } catch (parseError) {
    const errorMessage = parseError.message || "Failed to extract text from resume PDF.";
    await markIntakeParsingFailed(intakeId, errorMessage);
    throw Object.assign(new Error(errorMessage), { status: 500 });
  }

  const parsed_candidate = parseBasicCandidateInfo(extractedText);

  let draftResult;

  if (intake.created_draft_id) {
    draftResult = {
      outcome: "CREATED",
      candidate_id: intake.created_draft_id
    };
  } else {
    draftResult = await createDraftCandidateFromParsedIntake({
      pool,
      intake,
      parsedCandidate: parsed_candidate,
      createdBy,
      splitCandidateName,
      normalizeExperience
    });
  }

  const draft_candidate_id =
    draftResult.outcome === "CREATED" ? draftResult.candidate_id : null;

  await pool.query(
    `
    UPDATE rm_candidate_intake
    SET
      parsing_status = 'COMPLETED',
      error_message = NULL,
      created_draft_id = COALESCE($1, created_draft_id),
      review_status = 'PENDING',
      intake_status = 'COMPLETED'
    WHERE intake_id = $2
    `,
    [draft_candidate_id, intakeId]
  );

  return {
    parsed_candidate,
    extracted_text: extractedText,
    outcome: draftResult.outcome,
    duplicate_candidate: draftResult.duplicate_candidate || null,
    draft_candidate_id,
    parsing_status: "COMPLETED"
  };
}

async function loadExternalLeadReviewContext(pool, externalLeadId, runPublicId, requisitionCode) {
  const leadResult = await pool.query(
    `
    SELECT
      el.external_lead_id,
      el.display_name,
      el.headline,
      el."current_role",
      el.organization,
      el.location,
      el.import_status,
      el.possible_internal_candidate_id,
      erl.match_score,
      erl.match_explanation,
      r.run_uuid,
      r.requisition_code
    FROM oti_external_lead el
    INNER JOIN oti_external_run_lead erl ON erl.external_lead_id = el.external_lead_id
    INNER JOIN oti_sourcing_run r ON r.run_id = erl.run_id
    WHERE el.external_lead_id = $1
      AND ($2::text IS NULL OR r.run_uuid = $2)
      AND ($3::text IS NULL OR r.requisition_code = $3)
    ORDER BY erl.rank_order ASC NULLS LAST
    LIMIT 1
    `,
    [externalLeadId, runPublicId || null, requisitionCode || null]
  );

  const row = leadResult.rows[0];

  if (!row) {
    throw Object.assign(new Error("External lead context was not found for this run."), {
      status: 404
    });
  }

  const sources = await pool.query(
    `
    SELECT provider_key, profile_url, source_attribution, licensing_notes
    FROM oti_external_lead_source
    WHERE external_lead_id = $1
    ORDER BY is_primary DESC, discovered_on DESC
    LIMIT 3
    `,
    [externalLeadId]
  );

  return {
    external_lead_id: row.external_lead_id,
    display_name: row.display_name,
    headline: row.headline,
    current_role: row.current_role,
    organization: row.organization,
    location: row.location,
    import_status: row.import_status,
    possible_internal_candidate_id: row.possible_internal_candidate_id,
    match_score: Number(row.match_score || 0),
    match_explanation: row.match_explanation || {},
    run_uuid: row.run_uuid,
    requisition_code: row.requisition_code,
    sources: sources.rows
  };
}

async function prepareExternalLeadIntakeReview(pool, externalLeadId, req, body, deps) {
  await otiCapabilityAuth.assertExternalLeadAccessible(pool, req, externalLeadId, body);
  await otiExternalLeadService.assertExternalLeadExists(pool, externalLeadId);

  const context = body || {};
  const otiContext = await loadExternalLeadReviewContext(
    pool,
    externalLeadId,
    context.run_id,
    context.requisition_code
  );

  if (String(otiContext.import_status || "").toLowerCase() === "imported") {
    throw Object.assign(
      new Error("This external lead has already been registered as a candidate."),
      { status: 409 }
    );
  }

  const sourceReference = buildSourceReference(externalLeadId);

  const existingIntake = await pool.query(
    `
    SELECT *
    FROM rm_candidate_intake
    WHERE source_reference = $1
    ORDER BY intake_id DESC
    LIMIT 1
    `,
    [sourceReference]
  );

  let intake = existingIntake.rows[0];

  if (intake && String(intake.parsing_status || "").toUpperCase() === "COMPLETED") {
    const candidateId = intake.created_draft_id;
    let parsed_candidate = null;
    let extracted_text = null;

    try {
      const reparsed = await reparsedCandidateFromIntakeResume(intake, deps);

      parsed_candidate = reparsed?.parsed_candidate || null;
      extracted_text = reparsed?.extracted_text || null;

      if (candidateId && parsed_candidate) {
        await refreshDraftFromReparsedIntake(pool, candidateId, intake, parsed_candidate, deps);
      }
    } catch (error) {
      console.error("OTI external intake re-parse failed:", error.message);
    }

    return {
      intake_id: intake.intake_id,
      intake_status: intake.intake_status || "COMPLETED",
      parsing_status: intake.parsing_status,
      draft_candidate_id: candidateId,
      resume_path: intake.resume_path,
      original_file_name: intake.original_file_name,
      outcome: candidateId ? "CREATED" : "PENDING",
      parsed_candidate,
      extracted_text,
      duplicate_candidate: null,
      oti_context: otiContext,
      reused_existing_intake: true
    };
  }

  const document = await otiPublicResumeDocumentService.getExternalLeadResumeDocument(
    pool,
    externalLeadId,
    req,
    context
  );

  const detectedFormat = String(document.detected_format || "pdf").toLowerCase();

  if (detectedFormat !== "pdf") {
    throw Object.assign(
      new Error(
        "Standard intake parsing supports PDF resumes only. Download the document and complete manual intake if needed."
      ),
      { status: 400 }
    );
  }

  const { uploadResumeToStorage } = deps;
  const originalFileName = `oti-external-lead-${externalLeadId}.${detectedFormat}`;
  const resumePath = await uploadResumeToStorage({
    buffer: document.buffer,
    originalname: originalFileName,
    mimetype: document.mime_type || "application/pdf"
  });

  const sourceId = await resolveOtiIntakeSourceId(pool);

  if (!sourceId) {
    throw Object.assign(new Error("Candidate source master data is not configured."), {
      status: 500
    });
  }

  if (!intake) {
    const insertResult = await pool.query(
      `
      INSERT INTO rm_candidate_intake (
        source_id,
        source_reference,
        original_file_name,
        resume_path,
        intake_status
      ) VALUES ($1, $2, $3, $4, 'RESUME_UPLOADED')
      RETURNING *
      `,
      [sourceId, sourceReference, originalFileName, resumePath]
    );

    intake = insertResult.rows[0];
  } else {
    const updateResult = await pool.query(
      `
      UPDATE rm_candidate_intake
      SET
        resume_path = $1,
        original_file_name = $2,
        intake_status = 'RESUME_UPLOADED',
        parsing_status = 'PENDING',
        error_message = NULL
      WHERE intake_id = $3
      RETURNING *
      `,
      [resumePath, originalFileName, intake.intake_id]
    );

    intake = updateResult.rows[0];
  }

  const parseResult = await runIntakeParseForIntake(
    pool,
    intake,
    req.user?.employee_code || null,
    deps
  );

  return {
    intake_id: intake.intake_id,
    intake_status: "COMPLETED",
    parsing_status: parseResult.parsing_status,
    draft_candidate_id: parseResult.draft_candidate_id,
    resume_path: intake.resume_path,
    original_file_name: intake.original_file_name,
    outcome: parseResult.outcome,
    parsed_candidate: parseResult.parsed_candidate,
    duplicate_candidate: parseResult.duplicate_candidate,
    extracted_text: parseResult.extracted_text,
    oti_context: otiContext,
    reused_existing_intake: false
  };
}

async function completeExternalLeadRegistration(pool, externalLeadId, req, body) {
  await otiCapabilityAuth.assertExternalLeadAccessible(pool, req, externalLeadId, body);

  const candidateId = Number(body?.candidate_id);

  if (!Number.isFinite(candidateId) || candidateId <= 0) {
    throw Object.assign(new Error("candidate_id is required."), { status: 400 });
  }

  const candidateResult = await pool.query(
    `
    SELECT candidate_id, candidate_status, candidate_code
    FROM cand_mstr
    WHERE candidate_id = $1
    LIMIT 1
    `,
    [candidateId]
  );

  const candidate = candidateResult.rows[0];

  if (!candidate) {
    throw Object.assign(new Error("Candidate record was not found."), { status: 404 });
  }

  if (String(candidate.candidate_status || "").toUpperCase() !== "REGISTERED") {
    throw Object.assign(
      new Error("Candidate must be registered before completing external lead import."),
      { status: 400 }
    );
  }

  const sourceReference = buildSourceReference(externalLeadId);

  const intakeResult = await pool.query(
    `
    SELECT intake_id, created_draft_id
    FROM rm_candidate_intake
    WHERE source_reference = $1
    ORDER BY intake_id DESC
    LIMIT 1
    `,
    [sourceReference]
  );

  const intake = intakeResult.rows[0];

  if (intake && Number(intake.created_draft_id) !== candidateId) {
    throw Object.assign(
      new Error("Registered candidate does not match the intake draft for this external lead."),
      { status: 409 }
    );
  }

  await pool.query(
    `
    UPDATE oti_external_lead
    SET import_status = 'imported', updated_on = NOW()
    WHERE external_lead_id = $1
    `,
    [externalLeadId]
  );

  if (intake) {
    await pool.query(
      `
      UPDATE rm_candidate_intake
      SET review_status = 'COMPLETED'
      WHERE intake_id = $1
      `,
      [intake.intake_id]
    );
  }

  return {
    external_lead_id: externalLeadId,
    candidate_id: candidateId,
    candidate_code: candidate.candidate_code,
    import_status: "imported"
  };
}

module.exports = {
  OTI_SOURCE_REFERENCE_PREFIX,
  buildSourceReference,
  parseExternalLeadIdFromReference,
  prepareExternalLeadIntakeReview,
  completeExternalLeadRegistration
};
