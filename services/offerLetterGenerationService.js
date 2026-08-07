const offerLetterRepository = require("../repositories/offerLetterRepository");
const generatedDocumentRepository = require("../repositories/generatedDocumentRepository");
const offerLetterValidation = require("./offerLetterValidation");
const salaryCalculationService = require("./salaryCalculationService");
const offerTemplateMergeService = require("./offerTemplateMergeService");
const pdfGenerationService = require("./pdfGenerationService");
const offerDocumentStorageService = require("./offerDocumentStorageService");
const { userContext } = require("./enterpriseAuditService");

const OFFER_LETTER_DOCUMENT_TYPE = "Offer Letter";
const OFFER_BUSINESS_OBJECT_TYPE = "OFFER";

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loadPersistedSalaryBreakup(pool, letterId) {
  const rows = await offerLetterRepository.findCtcComponents(pool, letterId);

  if (!rows.length) {
    throw httpError(
      "Persisted salary breakup is required before generating the offer letter.",
      400
    );
  }

  return salaryCalculationService.aggregatePersistedRows(rows);
}

async function findOfferContext(pool, offerId) {
  const result = await pool.query(
    `SELECT
       o.offer_id,
       o.candidate_id,
       o.candidate_name,
       o.position_title,
       o.offered_ctc,
       o.currency,
       o.hiring_manager,
       o.recruiter_id,
       o.valid_until,
       o.expected_joining_date,
       o.variable_pay,
       o.variable_pay_frequency,
       o.joining_bonus,
       o.joining_bonus_frequency,
       o.offer_status,
       o.requisition_code,
       o.location,
       c.email_id AS candidate_email,
       u.full_name AS recruiter_name
     FROM om_offers o
     LEFT JOIN cand_mstr c ON c.candidate_id = o.candidate_id
     LEFT JOIN user_mstr u ON u.employee_code = o.recruiter_id
     WHERE o.offer_id = $1`,
    [offerId]
  );

  return result.rows[0] || null;
}

async function findOrganizationContext() {
  return {
    organization_name: "IGS Engineering Quality"
  };
}

function mapSalaryBreakupToPersistedRows(breakup) {
  return salaryCalculationService.mapBreakupToPersistedRows(breakup);
}

async function persistSalaryBreakup(pool, letterId, breakup) {
  await offerLetterRepository.replaceCtcComponents(
    pool,
    letterId,
    mapSalaryBreakupToPersistedRows(breakup),
    "SalaryCalculationService"
  );
}

function mapOfferLetterDocuments(rows) {
  return rows.map(generatedDocumentRepository.mapGeneratedDocumentRow);
}

function buildDocumentResponse(documents, offerId, salaryBreakup, extras = {}) {
  const docxDocument = documents.find(
    (document) => document.fileType === generatedDocumentRepository.FILE_TYPES.DOCX
  );
  const pdfDocument = documents.find(
    (document) => document.fileType === generatedDocumentRepository.FILE_TYPES.PDF
  );
  const pdfGenerated = Boolean(pdfDocument);

  return {
    offerId,
    documents,
    documentVersion: docxDocument?.versionNo || pdfDocument?.versionNo || null,
    docxDocument,
    pdfDocument,
    pdfGenerated,
    pdfPending: Boolean(docxDocument && !pdfDocument),
    docxPath: docxDocument?.documentPath || null,
    pdfPath: pdfDocument?.documentPath || null,
    responseMessage: "Offer letter generated successfully.",
    salaryBreakup,
    ...extras
  };
}

async function generateOfferLetterDocument(pool, offerId, req) {
  const actor = userContext(req);
  const generatedBy = actor.name || actor.email_id || "system";
  const generationStartedAt = Date.now();
  let generationLockAcquired = false;

  if (!offerId) {
    throw httpError("Offer id is required.", 400);
  }

  try {
    const offerRow = await findOfferContext(pool, offerId);
    const existingLetter = await offerLetterRepository.findLetterByOfferId(pool, offerId);

    if (!offerRow) {
      throw httpError(`Offer not found: ${offerId}`, 404);
    }

    offerLetterValidation.assertAwaitingLetterOperations({
      ...offerRow,
      letter_status: existingLetter?.status
    });

    const lockedLetter = await offerLetterRepository.acquireGenerationLock(pool, offerId);

    if (!lockedLetter) {
      throw httpError(
        "Offer must be in the Awaiting Letters queue before generating an offer letter.",
        400
      );
    }

    generationLockAcquired = true;

    const fixedAnnualCtc = Number(offerRow.offered_ctc || 0);

    if (!fixedAnnualCtc || fixedAnnualCtc <= 0) {
      throw httpError("Approved offer CTC is required before generating the offer letter.", 400);
    }

    const calculatedBreakup = salaryCalculationService.calculateSalaryBreakup(fixedAnnualCtc);

    let letter = existingLetter;

    if (!letter?.letter_id) {
      letter = await offerLetterRepository.insertLetter(pool, {
        letter_id: `OL-${offerId}`,
        offer_id: offerId,
        template_name: "Offer Letter V1",
        status: "Awaiting Letter"
      });
    }

    await persistSalaryBreakup(pool, letter.letter_id, calculatedBreakup);

    const persistedCompensation = await loadPersistedSalaryBreakup(pool, letter.letter_id);
    const organizationRow = await findOrganizationContext();

    const mergedDocxBuffer = offerTemplateMergeService.mergeOfferLetterTemplate({
      offerRow,
      organizationRow,
      salaryBreakup: persistedCompensation.salaryBreakup
    });

    const pdfBuffer = await pdfGenerationService.generatePdfFromDocx(mergedDocxBuffer);

    const versionNo = await generatedDocumentRepository.getNextVersionNo(
      pool,
      OFFER_BUSINESS_OBJECT_TYPE,
      offerId
    );
    const generationDurationMs = Date.now() - generationStartedAt;
    const generationTimestamp = Date.now();

    const docxPath = await offerDocumentStorageService.storeOfferLetterDocx(
      mergedDocxBuffer,
      offerId
    );
    const pdfPath = await offerDocumentStorageService.storeOfferLetterPdf(
      pdfBuffer,
      offerId
    );

    const docxRow = await generatedDocumentRepository.insertGeneratedDocument(pool, {
      document_id: `GD-OFFER-${offerId}-${generationTimestamp}-DOCX`,
      document_type: OFFER_LETTER_DOCUMENT_TYPE,
      file_type: generatedDocumentRepository.FILE_TYPES.DOCX,
      business_object_type: OFFER_BUSINESS_OBJECT_TYPE,
      business_object_id: offerId,
      template_id: null,
      template_version: 1,
      version_no: versionNo,
      document_path: docxPath,
      status: generatedDocumentRepository.DOCUMENT_STATUSES.GENERATED,
      generated_by: generatedBy,
      generation_duration_ms: generationDurationMs
    });

    const pdfRow = await generatedDocumentRepository.insertGeneratedDocument(pool, {
      document_id: `GD-OFFER-${offerId}-${generationTimestamp}-PDF`,
      document_type: OFFER_LETTER_DOCUMENT_TYPE,
      file_type: generatedDocumentRepository.FILE_TYPES.PDF,
      business_object_type: OFFER_BUSINESS_OBJECT_TYPE,
      business_object_id: offerId,
      template_id: null,
      template_version: 1,
      version_no: versionNo,
      document_path: pdfPath,
      status: generatedDocumentRepository.DOCUMENT_STATUSES.GENERATED,
      generated_by: generatedBy,
      generation_duration_ms: generationDurationMs
    });

    await offerLetterRepository.markLetterGenerated(
      pool,
      letter.letter_id,
      generatedBy
    );

    generationLockAcquired = false;

    const documents = mapOfferLetterDocuments([docxRow, pdfRow]);

    return buildDocumentResponse(documents, offerId, persistedCompensation.salaryBreakup, {
      fileName: `Offer_Letter_${offerId}.pdf`,
      contentType: offerDocumentStorageService.PDF_MIME
    });
  } finally {
    if (generationLockAcquired) {
      await offerLetterRepository.releaseGenerationLock(pool, offerId);
    }
  }
}

async function findLatestOfferLetterDocuments(pool, offerId) {
  const rows = await generatedDocumentRepository.findLatestVersionDocuments(
    pool,
    OFFER_BUSINESS_OBJECT_TYPE,
    offerId,
    OFFER_LETTER_DOCUMENT_TYPE
  );

  return mapOfferLetterDocuments(rows);
}

async function downloadOfferLetterDocx(pool, offerId) {
  const offerRow = await offerLetterRepository.findOfferLetterDetail(pool, offerId);

  if (!offerRow) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  offerLetterValidation.assertGeneratedLetterAccess(offerRow);

  const generatedRow = await generatedDocumentRepository.findLatestByBusinessObjectFileType(
    pool,
    OFFER_BUSINESS_OBJECT_TYPE,
    offerId,
    OFFER_LETTER_DOCUMENT_TYPE,
    generatedDocumentRepository.FILE_TYPES.DOCX
  );

  if (!generatedRow?.document_path) {
    throw httpError(`Generated offer letter DOCX is not available for ${offerId}.`, 404);
  }

  const file = await offerDocumentStorageService.downloadOfferLetterDocx(
    generatedRow.document_path
  );

  return {
    buffer: file.buffer,
    contentType: offerDocumentStorageService.DOCX_MIME,
    fileName: `Offer_Letter_${offerId}.docx`,
    documentId: generatedRow.document_id
  };
}

async function downloadOfferLetterPdf(pool, offerId) {
  const offerRow = await offerLetterRepository.findOfferLetterDetail(pool, offerId);

  if (!offerRow) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  offerLetterValidation.assertGeneratedLetterAccess(offerRow);

  const generatedRow = await generatedDocumentRepository.findLatestByBusinessObjectFileType(
    pool,
    OFFER_BUSINESS_OBJECT_TYPE,
    offerId,
    OFFER_LETTER_DOCUMENT_TYPE,
    generatedDocumentRepository.FILE_TYPES.PDF
  );

  const pdfPath = generatedRow?.document_path || offerRow.pdf_path;

  if (!pdfPath) {
    throw httpError(`Generated offer letter PDF is not available for ${offerId}.`, 404);
  }

  const file = await offerDocumentStorageService.downloadOfferLetterPdf(pdfPath);

  return {
    buffer: file.buffer,
    contentType: offerDocumentStorageService.PDF_MIME,
    fileName: `Offer_Letter_${offerId}.pdf`,
    documentId: generatedRow?.document_id || null
  };
}

module.exports = {
  OFFER_LETTER_DOCUMENT_TYPE,
  OFFER_BUSINESS_OBJECT_TYPE,
  generateOfferLetterDocument,
  findLatestOfferLetterDocuments,
  downloadOfferLetterDocx,
  downloadOfferLetterPdf,
  findOfferContext,
  findOrganizationContext
};
