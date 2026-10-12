/**
 * PDF generation — soffice resolution (no secrets, no production data).
 * Run: node scripts/verifyPdfGenerationServiceResolution.js
 *
 * On Linux with .libreoffice/ present, defaults to portable-only verification
 * (SPIKE_VERIFY_PORTABLE_ONLY=1, no system /usr/bin fallback).
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
  process.exit(1);
}

function findPortableSofficePath() {
  const portableOptRoot = path.join(process.cwd(), ".libreoffice", "root", "opt");

  if (!fs.existsSync(portableOptRoot)) {
    return null;
  }

  let entries = [];

  try {
    entries = fs.readdirSync(portableOptRoot);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!String(entry).startsWith("libreoffice")) {
      continue;
    }

    const sofficePath = path.join(portableOptRoot, entry, "program", "soffice");

    if (fs.existsSync(sofficePath)) {
      return sofficePath;
    }
  }

  return null;
}

function shouldForcePortableOnly() {
  if (process.env.SPIKE_VERIFY_PORTABLE_ONLY === "0") {
    return false;
  }

  if (process.env.SPIKE_VERIFY_PORTABLE_ONLY === "1") {
    return true;
  }

  return process.platform === "linux" && Boolean(findPortableSofficePath());
}

async function main() {
  const portableSofficePath = findPortableSofficePath();
  const forcePortableOnly = shouldForcePortableOnly();

  if (forcePortableOnly) {
    if (!portableSofficePath) {
      fail(
        "portable-only mode",
        ".libreoffice portable tree missing (run render-fetch-portable-libreoffice.sh)"
      );
    }

    process.env.LIBREOFFICE_PATH = portableSofficePath;
    process.env.OPTALYNX_LIMIT_SOFFICE_TO_CONFIGURED = "1";
    pass(`Portable-only mode (no system fallback): ${portableSofficePath}`);
  }

  const candidates = resolveSofficeBinaryCandidates();

  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail("resolveSofficeBinaryCandidates", "empty list");
  }

  if (forcePortableOnly) {
    if (candidates.length !== 1 || candidates[0] !== portableSofficePath) {
      fail(
        "portable-only candidates",
        `expected only ${portableSofficePath}, got ${candidates.join(", ")}`
      );
    }

    pass("Candidate list restricted to portable executable");
  } else {
    pass(`Candidate list non-empty (${candidates.length} entries, platform=${process.platform})`);
  }

  if (process.platform !== "win32" && !forcePortableOnly) {
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
    fail(
      "resolveSofficeExecCommands",
      "no resolvable soffice binary (set LIBREOFFICE_PATH or run render-fetch-portable-libreoffice.sh)"
    );
  }

  if (forcePortableOnly) {
    if (commands.length !== 1 || commands[0].binary !== portableSofficePath) {
      fail(
        "portable-only exec commands",
        `expected only ${portableSofficePath}, got ${commands.map((c) => c.binary).join(", ")}`
      );
    }
  }

  pass(`Resolved ${commands.length} executable command(s): ${commands.map((c) => c.binary).join(", ")}`);

  const templatePath = path.resolve(
    __dirname,
    "../assets/templates/offer-letter-v1.docx"
  );

  if (!fs.existsSync(templatePath)) {
    fail("offer letter template", `not found at ${templatePath}`);
  }

  const docxBuffer = fs.readFileSync(templatePath);

  try {
    const pdfBuffer = await generatePdfFromDocx(docxBuffer);

    if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 100) {
      fail("generatePdfFromDocx", "PDF buffer too small");
    }

    const header = pdfBuffer.subarray(0, 4).toString("ascii");
    if (header !== "%PDF") {
      fail("generatePdfFromDocx", `invalid PDF header: ${header}`);
    }

    const executableUsed = forcePortableOnly
      ? portableSofficePath
      : commands[0].binary;

    pass(
      `DOCX→PDF conversion produced valid PDF (${pdfBuffer.length} bytes) via ${executableUsed}`
    );
  } catch (error) {
    fail("generatePdfFromDocx", error.message);
  }
}

main().catch((error) => {
  fail("verifyPdfGenerationServiceResolution", error.message);
});
