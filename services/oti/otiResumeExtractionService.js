/**
 * PDF/text extraction for OTI resume indexing.
 */

const { PDFParse } = require("pdf-parse");
const {
  normalizeResumeText,
  classifyExtractionFailure,
  isPdfPath
} = require("./otiResumeTextUtils");

async function extractTextFromPdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText();
    return normalizeResumeText(textResult.text);
  } finally {
    await parser.destroy();
  }
}

async function extractResumeText({ resumePath, buffer }) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      ok: false,
      status: "failed",
      reason: "Resume file is empty or missing."
    };
  }

  if (!isPdfPath(resumePath)) {
    return {
      ok: false,
      status: "unsupported",
      reason: "Only PDF resumes are supported for indexing in Phase 2."
    };
  }

  try {
    const text = await extractTextFromPdfBuffer(buffer);

    if (!text) {
      return {
        ok: false,
        status: "failed",
        reason: "No extractable text was found in the PDF."
      };
    }

    return { ok: true, text };
  } catch (error) {
    const classified = classifyExtractionFailure(error, "");
    return {
      ok: false,
      status: classified.status,
      reason: classified.reason
    };
  }
}

module.exports = {
  extractResumeText
};
