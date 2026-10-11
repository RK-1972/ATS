/**
 * PDF generation — soffice resolution (no secrets, no production data).
 * Run: node scripts/verifyPdfGenerationServiceResolution.js
 */
const fs = require("fs");
const path = require("path");
const {
  resolveSofficeBinaryCandidates,
  resolveSofficeExecCommands,
  generatePdfFromDocx
} = require("../services/pdfGenerationService");

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function main() {
  const candidates = resolveSofficeBinaryCandidates();

  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail("resolveSofficeBinaryCandidates", "empty list");
    return;
  }

  pass(`Candidate list non-empty (${candidates.length} entries, platform=${process.platform})`);

  if (process.platform !== "win32") {
    const hasWindowsOnlyDefault =
      candidates.length === 2 &&
      candidates.every((item) => String(item).includes("Program Files"));

    if (hasWindowsOnlyDefault) {
      fail("Linux/macOS candidates", "still Windows-only defaults");
    } else {
      pass("Non-Windows candidates include platform paths");
    }
  }

  const commands = resolveSofficeExecCommands();

  if (!commands.length) {
    console.log(
      "SKIP: no resolvable soffice binary on this machine (set LIBREOFFICE_PATH to test conversion)"
    );
  } else {
    pass(`Resolved ${commands.length} executable command(s) without throwing`);
  }

  const templatePath = path.resolve(
    __dirname,
    "../assets/templates/offer-letter-v1.docx"
  );

  if (!fs.existsSync(templatePath)) {
    console.log("SKIP: offer letter DOCX template not found for live conversion test");
    return;
  }

  if (!commands.length) {
    return;
  }

  const docxBuffer = fs.readFileSync(templatePath);

  generatePdfFromDocx(docxBuffer)
    .then((pdfBuffer) => {
      if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 100) {
        fail("generatePdfFromDocx", "PDF buffer too small");
        return;
      }

      const header = pdfBuffer.subarray(0, 4).toString("ascii");
      if (header !== "%PDF") {
        fail("generatePdfFromDocx", `invalid PDF header: ${header}`);
        return;
      }

      pass(`DOCX→PDF conversion produced valid PDF (${pdfBuffer.length} bytes)`);
    })
    .catch((error) => {
      fail("generatePdfFromDocx", error.message);
    });
}

main();
