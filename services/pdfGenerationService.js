const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getConfiguredSofficePaths() {
  const raw =
    process.env.LIBREOFFICE_PATH ||
    process.env.SOFFICE_PATH ||
    process.env.LIBRE_OFFICE_EXE ||
    "";

  const trimmed = String(raw).trim();

  return trimmed ? [trimmed] : [];
}

function resolvePortableLibreOfficeCandidates() {
  if (process.platform === "win32" || process.platform === "darwin") {
    return [];
  }

  const candidates = [];
  const portableOptRoot = path.join(process.cwd(), ".libreoffice", "root", "opt");

  if (!pathExists(portableOptRoot)) {
    return candidates;
  }

  let entries = [];

  try {
    entries = fs.readdirSync(portableOptRoot);
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (!String(entry).startsWith("libreoffice")) {
      continue;
    }

    const sofficePath = path.join(portableOptRoot, entry, "program", "soffice");

    if (pathExists(sofficePath)) {
      candidates.push(sofficePath);
    }
  }

  return candidates;
}

function resolveSofficeBinaryCandidates() {
  const configured = getConfiguredSofficePaths();

  if (process.env.OPTALYNX_LIMIT_SOFFICE_TO_CONFIGURED === "1") {
    const seen = new Set();

    return configured.filter((candidate) => {
      const key = String(candidate || "").trim();

      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  const candidates = [...configured, ...resolvePortableLibreOfficeCandidates()];

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 =
      process.env["PROGRAMFILES(X86)"] ||
      process.env.PROGRAMFILES_X86 ||
      "C:\\Program Files (x86)";

    candidates.push(
      path.join(programFiles, "LibreOffice", "program", "soffice.exe"),
      path.join(programFilesX86, "LibreOffice", "program", "soffice.exe"),
      "soffice.exe",
      "soffice"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "soffice"
    );
  } else {
    candidates.push(
      "/usr/bin/libreoffice",
      "/usr/bin/soffice",
      "/snap/bin/libreoffice",
      "/opt/libreoffice/program/soffice",
      "/opt/libreoffice7.6/program/soffice",
      "soffice",
      "libreoffice"
    );
  }

  const seen = new Set();

  return candidates.filter((candidate) => {
    const key = String(candidate || "").trim();

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function pathExists(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildSofficeExecEnv(binary) {
  const env = { ...process.env };
  const programDir = path.dirname(binary);

  if (programDir.endsWith(`${path.sep}program`)) {
    const existing = env.LD_LIBRARY_PATH || "";
    env.LD_LIBRARY_PATH = existing ? `${programDir}:${existing}` : programDir;
  }

  return env;
}

function resolveSofficeExecCommands() {
  const commands = [];
  const seen = new Set();

  const addCommand = (binary, cwd) => {
    const key = `${binary}@@${cwd || ""}`;

    if (!binary || seen.has(key)) {
      return;
    }

    seen.add(key);
    commands.push({ binary, cwd: cwd || undefined });
  };

  for (const candidate of resolveSofficeBinaryCandidates()) {
    const isPathLike = candidate.includes("/") || candidate.includes("\\");

    if (!isPathLike) {
      addCommand(candidate, undefined);
      continue;
    }

    if (pathExists(candidate)) {
      addCommand(candidate, path.dirname(candidate));
    }
  }

  return commands;
}

function buildLibreOfficeConvertOptions() {
  const sofficeBinaryPaths =
    process.env.OPTALYNX_LIMIT_SOFFICE_TO_CONFIGURED === "1"
      ? getConfiguredSofficePaths()
      : [...getConfiguredSofficePaths(), ...resolvePortableLibreOfficeCandidates()];

  const seen = new Set();

  const uniquePaths = sofficeBinaryPaths.filter((candidate) => {
    const key = String(candidate || "").trim();

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  if (!uniquePaths.length) {
    return undefined;
  }

  return { sofficeBinaryPaths: uniquePaths };
}

async function convertWithLibreOfficeConvert(docxBuffer) {
  let libre;

  try {
    libre = require("libreoffice-convert");
  } catch {
    return null;
  }

  const convertOptions = buildLibreOfficeConvertOptions();
  const libreOptions = convertOptions || {};

  try {
    if (typeof libre.convertWithOptions === "function") {
      return await new Promise((resolve, reject) => {
        libre.convertWithOptions(
          docxBuffer,
          ".pdf",
          undefined,
          libreOptions,
          (error, pdfBuffer) => {
            if (error) {
              reject(error);
              return;
            }

            resolve(pdfBuffer);
          }
        );
      });
    }

    return await new Promise((resolve, reject) => {
      libre.convert(docxBuffer, ".pdf", undefined, (error, pdfBuffer) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(pdfBuffer);
      });
    });
  } catch {
    return null;
  }
}

async function convertWithSoffice(docxBuffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-offer-pdf-"));
  const inputPath = path.join(tempDir, "offer-letter.docx");
  const outputPath = path.join(tempDir, "offer-letter.pdf");

  fs.writeFileSync(inputPath, docxBuffer);

  const convertArgs = [
    "--headless",
    "--invisible",
    "--convert-to",
    "pdf",
    "--outdir",
    tempDir,
    inputPath
  ];

  const commands = resolveSofficeExecCommands();

  let lastError = null;

  for (const { binary, cwd } of commands) {
    try {
      await execFileAsync(binary, convertArgs, {
        timeout: 120000,
        cwd: cwd || undefined,
        env: buildSofficeExecEnv(binary)
      });

      if (fs.existsSync(outputPath)) {
        const pdfBuffer = fs.readFileSync(outputPath);
        fs.rmSync(tempDir, { recursive: true, force: true });
        return pdfBuffer;
      }
    } catch (error) {
      lastError = error;
    }
  }

  fs.rmSync(tempDir, { recursive: true, force: true });

  if (lastError) {
    throw lastError;
  }

  return null;
}

function buildConversionFailureMessage(lastError) {
  const platformHint =
    process.platform === "win32"
      ? "Install LibreOffice or set LIBREOFFICE_PATH to soffice.exe."
      : "Install LibreOffice (soffice) on the server or set LIBREOFFICE_PATH to the soffice binary.";

  if (lastError?.message) {
    const isMissingBinary =
      lastError.code === "ENOENT" ||
      /could not find soffice/i.test(String(lastError.message));

    if (isMissingBinary) {
      return `PDF conversion failed: LibreOffice (soffice) is not available. ${platformHint}`;
    }

    return `PDF conversion failed: ${lastError.message}`;
  }

  return `PDF conversion requires LibreOffice (soffice) on the server. ${platformHint}`;
}

async function generatePdfFromDocx(docxBuffer) {
  if (!Buffer.isBuffer(docxBuffer) || !docxBuffer.length) {
    throw httpError("Merged offer letter DOCX buffer is empty.", 400);
  }

  let lastError = null;

  try {
    const libreOfficePdf = await convertWithLibreOfficeConvert(docxBuffer);

    if (libreOfficePdf?.length) {
      return libreOfficePdf;
    }

    const sofficePdf = await convertWithSoffice(docxBuffer);

    if (sofficePdf?.length) {
      return sofficePdf;
    }
  } catch (error) {
    lastError = error;
  }

  throw httpError(buildConversionFailureMessage(lastError), 500);
}

module.exports = {
  generatePdfFromDocx,
  resolveSofficeBinaryCandidates,
  resolveSofficeExecCommands
};
