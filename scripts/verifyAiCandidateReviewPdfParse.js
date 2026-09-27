/**
 * Focused check: pdf-parse v2 PDFParse API used by AI Candidate Review.
 * Run: node scripts/verifyAiCandidateReviewPdfParse.js
 */
const fs = require("fs");
const path = require("path");
const { PDFParse } = require("pdf-parse");

const demoPdf = path.join(__dirname, "..", "demo", "assets", "demo-resume.pdf");

async function parsePdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const textResult = await parser.getText();
    return String(textResult.text || "").trim();
  } finally {
    await parser.destroy();
  }
}

async function main() {
  if (!fs.existsSync(demoPdf)) {
    console.error("FAIL: demo-resume.pdf not found at", demoPdf);
    process.exitCode = 1;
    return;
  }

  const buffer = fs.readFileSync(demoPdf);
  if (buffer.slice(0, 4).toString() !== "%PDF") {
    console.error("FAIL: demo file is not a PDF");
    process.exitCode = 1;
    return;
  }

  const text = await parsePdfBuffer(buffer);
  if (text.length > 0) {
    console.log(`PASS: PDF text extraction (${text.length} chars)`);
  } else {
    console.error("FAIL: PDF text extraction returned empty string");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("FAIL:", error.message);
  process.exitCode = 1;
});
