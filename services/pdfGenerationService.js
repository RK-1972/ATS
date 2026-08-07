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

async function convertWithLibreOfficeConvert(docxBuffer) {
  let libre;

  try {
    libre = require("libreoffice-convert");
  } catch {
    return null;
  }

  try {
    if (typeof libre.convertAsync === "function") {
      return await libre.convertAsync(docxBuffer, ".pdf", undefined);
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

function resolveSofficeCommands(inputPath, tempDir) {
  const programDir = "C:\\Program Files\\LibreOffice\\program";
  const programDirX86 = "C:\\Program Files (x86)\\LibreOffice\\program";
  const convertArgs = [
    "--headless",
    "--invisible",
    "--convert-to",
    "pdf",
    "--outdir",
    tempDir,
    inputPath
  ];

  return [
    { binary: "soffice", args: convertArgs, cwd: programDir },
    { binary: path.join(programDir, "soffice.exe"), args: convertArgs, cwd: programDir },
    {
      binary: path.join(programDirX86, "soffice.exe"),
      args: convertArgs,
      cwd: programDirX86
    }
  ];
}

async function convertWithSoffice(docxBuffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "optalynx-offer-pdf-"));
  const inputPath = path.join(tempDir, "offer-letter.docx");
  const outputPath = path.join(tempDir, "offer-letter.pdf");

  fs.writeFileSync(inputPath, docxBuffer);

  const commands = resolveSofficeCommands(inputPath, tempDir);

  let lastError = null;

  for (const { binary, args, cwd } of commands) {
    try {
      await execFileAsync(binary, args, { timeout: 120000, cwd });

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

async function generatePdfFromDocx(docxBuffer) {
  if (!Buffer.isBuffer(docxBuffer) || !docxBuffer.length) {
    throw httpError("Merged offer letter DOCX buffer is empty.", 400);
  }

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
    throw httpError(
      `PDF conversion failed: ${error.message || "LibreOffice conversion error."}`,
      500
    );
  }

  throw httpError(
    "PDF conversion requires LibreOffice (soffice) on the server. Install LibreOffice and retry.",
    500
  );
}

module.exports = {
  generatePdfFromDocx
};
