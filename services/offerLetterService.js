const path = require("path");
const PDFDocument = require("pdfkit");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const offerLetterRepository = require("../repositories/offerLetterRepository");
const offerLetterValidation = require("./offerLetterValidation");
const salaryCalculationService = require("./salaryCalculationService");
const offerLetterGenerationService = require("./offerLetterGenerationService");
const { userContext } = require("./enterpriseAuditService");

const EDITABLE_CTC_COMPONENTS = [
  "Basic",
  "HRA",
  "Special Allowance",
  "Employer PF",
  "Employer ESI",
  "Bonus",
  "Variable Pay",
  "Retention Bonus",
  "Gratuity",
  "Medical",
  "LTA"
];

const GROSS_COMPONENTS = [
  "Basic",
  "HRA",
  "Special Allowance",
  "Bonus",
  "Variable Pay",
  "Retention Bonus",
  "Medical",
  "LTA"
];

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createR2Client() {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

function mapQueueRow(row) {
  return {
    offerId: row.offer_id,
    letterId: row.letter_id || null,
    offerNumber: row.offer_id,
    candidateName: row.candidate_name,
    position: row.position_title,
    department: row.department,
    businessUnit: row.business_unit,
    annualCtc: Number(row.offered_ctc || 0),
    approvedDate: row.approved_date?.toISOString?.() || row.approved_date || null,
    recruiter: row.recruiter_name || row.recruiter_id || "—",
    letterStatus: row.letter_status || "Awaiting Letter",
    requisitionCode: row.requisition_code,
    location: row.location,
    reportingManager: row.hiring_manager,
    joiningDate: row.valid_until?.toISOString?.()?.slice(0, 10) || null,
    expectedJoiningDate:
      row.expected_joining_date?.toISOString?.()?.slice(0, 10) ||
      row.expected_joining_date ||
      null,
    variablePay: Number(row.variable_pay ?? 0),
    variablePayFrequency: row.variable_pay_frequency || null,
    joiningBonus: Number(row.joining_bonus ?? 0),
    joiningBonusFrequency: row.joining_bonus_frequency || null,
    pdfPath: row.pdf_path || null,
    generatedOn: row.generated_on?.toISOString?.() || row.generated_on || null,
    generatedBy: row.generated_by || null,
    currency: row.currency || "INR"
  };
}

function normalizeIncomingComponents(ctcBreakup) {
  const inputMap = {};

  (Array.isArray(ctcBreakup) ? ctcBreakup : []).forEach((item, index) => {
    const name = String(item.componentName || item.component_name || "").trim();
    if (!name) {
      return;
    }

    inputMap[name] = {
      component_name: name,
      amount: Number(item.amount || 0),
      display_order: Number(item.displayOrder || item.display_order || index + 1)
    };
  });

  return EDITABLE_CTC_COMPONENTS.map((name, index) => ({
    component_name: name,
    amount: Number(inputMap[name]?.amount || 0),
    display_order: index + 1
  }));
}

function calculateTotals(components) {
  const amountByName = Object.fromEntries(
    components.map((item) => [item.component_name, Number(item.amount || 0)])
  );

  const gross = GROSS_COMPONENTS.reduce(
    (sum, name) => sum + Number(amountByName[name] || 0),
    0
  );

  const totalCtc =
    gross +
    Number(amountByName["Employer PF"] || 0) +
    Number(amountByName["Employer ESI"] || 0) +
    Number(amountByName.Gratuity || 0);

  return {
    gross: Number(gross.toFixed(2)),
    totalCtc: Number(totalCtc.toFixed(2)),
    components: components.map((item) => ({
      componentName: item.component_name,
      amount: Number(item.amount || 0),
      displayOrder: item.display_order
    }))
  };
}

async function aggregateDetailTotalsFromPersistedCtc(persistedRows) {
  if (!persistedRows?.length) {
    return {
      structureName: null,
      gross: 0,
      totalCtc: 0,
      ctcBreakup: []
    };
  }

  const aggregated = salaryCalculationService.aggregatePersistedRows(persistedRows);

  return {
    structureName: aggregated.structureName,
    gross: aggregated.gross,
    totalCtc: aggregated.totalCtc,
    ctcBreakup: aggregated.ctcBreakup
  };
}

async function attachGeneratedDocuments(pool, item, offerId) {
  const documents = await offerLetterGenerationService.findLatestOfferLetterDocuments(
    pool,
    offerId
  );

  if (!documents.length) {
    return {
      ...item,
      documents: [],
      pdfGenerated: Boolean(item.pdfPath),
      pdfPending: false
    };
  }

  const docxDocument = documents.find((document) => document.fileType === "DOCX");
  const pdfDocument = documents.find((document) => document.fileType === "PDF");

  return {
    ...item,
    documents,
    documentVersion: docxDocument?.versionNo || pdfDocument?.versionNo || null,
    docxPath: docxDocument?.documentPath || null,
    pdfPath: pdfDocument?.documentPath || item.pdfPath || null,
    pdfGenerated: Boolean(pdfDocument),
    pdfPending: Boolean(docxDocument && !pdfDocument)
  };
}

async function buildOfferLetterItem(pool, row) {
  let persistedComponents = [];

  if (row.letter_id) {
    persistedComponents = await offerLetterRepository.findCtcComponents(
      pool,
      row.letter_id
    );
  }

  const compensation = await aggregateDetailTotalsFromPersistedCtc(persistedComponents);
  const baseItem = {
    ...mapQueueRow(row),
    templateName: row.template_name || "Standard Offer Letter",
    structureName: compensation.structureName,
    ctcBreakup: compensation.ctcBreakup,
    gross: compensation.gross,
    totalCtc: compensation.totalCtc,
    calculatedOn:
      row.compensation_calculated_on?.toISOString?.() ||
      row.compensation_calculated_on ||
      null,
    calculatedBy: row.compensation_calculated_by || null
  };

  return attachGeneratedDocuments(pool, baseItem, row.offer_id);
}

function mapDetailResponse(row, components) {
  const totals = calculateTotals(
    components.length
      ? components.map((item) => ({
          component_name: item.component_name,
          amount: item.amount,
          display_order: item.display_order
        }))
      : normalizeIncomingComponents([])
  );

  return {
    ...mapQueueRow(row),
    templateName: row.template_name || "Standard Offer Letter",
    ctcBreakup: totals.components,
    gross: totals.gross,
    totalCtc: totals.totalCtc
  };
}

function formatCurrency(amount, currency = "INR") {
  const value = Number(amount || 0);

  if (currency === "INR") {
    return `INR ${value.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  return `${currency} ${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function buildOfferLetterPdf(detail, totals) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc
      .fontSize(18)
      .fillColor("#1f3b63")
      .text("OPTALYNX — Offer Letter", { align: "center" });
    doc.moveDown();

    doc
      .fontSize(11)
      .fillColor("#111827")
      .text(`Date: ${new Date().toLocaleDateString("en-IN")}`)
      .moveDown()
      .text(`Dear ${detail.candidateName || "Candidate"},"`)
      .moveDown()
      .text(
        "We are pleased to offer you employment with IGS Engineering Quality based on the details below."
      )
      .moveDown()
      .text(`Offer Number: ${detail.offerNumber}`)
      .text(`Requisition: ${detail.requisitionCode || "—"}`)
      .text(`Position: ${detail.position || "—"}`)
      .text(`Department: ${detail.department || "—"}`)
      .text(`Business Unit: ${detail.businessUnit || "—"}`)
      .text(`Location: ${detail.location || "—"}`)
      .text(`Reporting Manager: ${detail.reportingManager || "—"}`)
      .text(`Annual CTC: ${formatCurrency(detail.annualCtc, detail.currency)}`)
      .moveDown()
      .text(
        "Please review Annexure A for the detailed CTC breakup. This offer is subject to successful completion of background verification and submission of required documents."
      )
      .moveDown()
      .text("Regards,")
      .text("OPTALYNX HR Team");

    doc.addPage();
    doc
      .fontSize(16)
      .fillColor("#1f3b63")
      .text("Annexure A — CTC Breakup", { align: "center" });
    doc.moveDown();

    doc.fontSize(11).fillColor("#111827");
    doc.text(`Candidate: ${detail.candidateName || "—"}`);
    doc.text(`Offer Number: ${detail.offerNumber}`);
    doc.moveDown();

    totals.components.forEach((item) => {
      doc.text(
        `${item.componentName}: ${formatCurrency(item.amount, detail.currency)}`
      );
    });

    doc.moveDown();
    doc.font("Helvetica-Bold");
    doc.text(`Gross: ${formatCurrency(totals.gross, detail.currency)}`);
    doc.text(`Total CTC: ${formatCurrency(totals.totalCtc, detail.currency)}`);

    doc.end();
  });
}

async function uploadOfferLetterPdf(buffer, offerId) {
  const objectKey = `offer-letters/${offerId}/${Date.now()}.pdf`;

  await createR2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: objectKey,
      Body: buffer,
      ContentType: "application/pdf"
    })
  );

  return objectKey;
}

async function getPendingLetters(pool) {
  const missingLetters = await pool.query(
    `SELECT o.offer_id
     FROM om_offers o
     LEFT JOIN om_offer_letters ol ON ol.offer_id = o.offer_id
     WHERE ol.letter_id IS NULL
       AND o.offer_status NOT IN ('Draft', 'Pending Approval', 'Declined', 'Withdrawn')`
  );

  for (const row of missingLetters.rows) {
    await offerLetterRepository.ensureAwaitingLetter(pool, row.offer_id);
  }

  const rows = await offerLetterRepository.findPendingLetters(pool);
  return Promise.all(rows.map((row) => buildOfferLetterItem(pool, row)));
}

async function getGeneratedLetters(pool) {
  const rows = await offerLetterRepository.findGeneratedLetters(pool);
  return Promise.all(rows.map((row) => buildOfferLetterItem(pool, row)));
}

async function getOfferLetterDetail(pool, offerId) {
  const row = await offerLetterRepository.findOfferLetterDetail(pool, offerId);

  if (!row) {
    throw httpError(`Offer letter record not found: ${offerId}`, 404);
  }

  offerLetterValidation.assertOfferLetterWorkspaceEligible(row);

  return buildOfferLetterItem(pool, row);
}

async function generateOfferLetter(pool, offerId, payload, req) {
  const row = await offerLetterRepository.findOfferLetterDetail(pool, offerId);

  if (!row) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  offerLetterValidation.assertAwaitingLetterOperations(row);

  const normalizedComponents = normalizeIncomingComponents(payload?.ctcBreakup);
  const totals = calculateTotals(normalizedComponents);
  const annualCtc = Number(row.offered_ctc || 0);

  if (Math.abs(totals.totalCtc - annualCtc) > 0.01) {
    throw httpError(
      `Total CTC (${totals.totalCtc}) must equal Annual CTC (${annualCtc}).`,
      400
    );
  }

  const detail = mapDetailResponse(row, normalizedComponents);
  const pdfBuffer = await buildOfferLetterPdf(detail, totals);
  const pdfPath = await uploadOfferLetterPdf(pdfBuffer, offerId);

  let letter =
    row.letter_id &&
    (await offerLetterRepository.findLetterByOfferId(pool, offerId));

  if (!letter) {
    letter = await offerLetterRepository.insertLetter(pool, {
      letter_id: `OL-${offerId}`,
      offer_id: offerId,
      template_name: payload?.templateName || "Standard Offer Letter",
      status: "Awaiting Letter"
    });
  }

  await offerLetterRepository.replaceCtcComponents(
    pool,
    letter.letter_id,
    normalizedComponents
  );

  const actor = userContext(req);
  const generated = await offerLetterRepository.markLetterGenerated(
    pool,
    letter.letter_id,
    actor.name || "system"
  );

  return {
    letterId: generated.letter_id,
    offerId,
    status: generated.status,
    pdfPath: generated.pdf_path,
    generatedOn: generated.generated_on?.toISOString?.() || generated.generated_on,
    gross: totals.gross,
    totalCtc: totals.totalCtc,
    ctcBreakup: totals.components
  };
}

async function ensureAwaitingLetterForOffer(pool, offerId) {
  return offerLetterRepository.ensureAwaitingLetter(pool, offerId);
}

function resolveStorageObjectKey(storedPath) {
  const value = String(storedPath || "").trim();

  if (!value) {
    return value;
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);

      if (segments.length === 0) {
        return value;
      }

      return decodeURIComponent(segments[segments.length - 1]);
    }
  } catch {
    // Fall through — treat as bare object key.
  }

  return value;
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function downloadStoredPdf(storedPath) {
  const objectKey = resolveStorageObjectKey(storedPath);

  let response;

  try {
    response = await createR2Client().send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: objectKey
      })
    );
  } catch (error) {
    const downloadError = new Error(error.message);
    downloadError.isStatObjectFailure = true;
    downloadError.objectKey = objectKey;
    throw downloadError;
  }

  return {
    buffer: await streamToBuffer(response.Body),
    objectKey
  };
}

async function getGeneratedOfferLetterPdf(pool, offerId) {
  return offerLetterGenerationService.downloadOfferLetterPdf(pool, offerId);
}

module.exports = {
  EDITABLE_CTC_COMPONENTS,
  getPendingLetters,
  getGeneratedLetters,
  getOfferLetterDetail,
  generateOfferLetter,
  ensureAwaitingLetterForOffer,
  getGeneratedOfferLetterPdf,
  calculateTotals,
  normalizeIncomingComponents
};
