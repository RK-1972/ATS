/**
 * Resume document validation — magic bytes, size, integrity (Phase 4).
 */

const { hashResumeContent } = require("./otiResumeTextUtils");

const MAX_RESUME_BYTES = 15 * 1024 * 1024;

const PDF_LEADING_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

const BINARY_FORMAT_SIGNATURES = [
  {
    format: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    test: (buf) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b
  },
  {
    format: "doc",
    mime: "application/msword",
    test: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0xd0 &&
      buf[1] === 0xcf &&
      buf[2] === 0x11 &&
      buf[3] === 0xe0
  }
];

function skipLeadingPdfNoise(buffer) {
  let offset = 0;
  const length = buffer.length;

  if (length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    offset = 3;
  }

  while (offset < length && PDF_LEADING_WHITESPACE.has(buffer[offset])) {
    offset += 1;
  }

  return offset;
}

function hasPdfMagicAt(buffer, offset) {
  return (
    offset + 5 <= buffer.length &&
    buffer[offset] === 0x25 &&
    buffer[offset + 1] === 0x50 &&
    buffer[offset + 2] === 0x44 &&
    buffer[offset + 3] === 0x46 &&
    buffer[offset + 4] === 0x2d
  );
}

function detectPdfFormat(buffer) {
  const offset = skipLeadingPdfNoise(buffer);
  if (hasPdfMagicAt(buffer, offset)) {
    return { format: "pdf", mime: "application/pdf", trusted: true };
  }
  return null;
}

function looksLikeHtmlOrPlainTextResponse(buffer) {
  const scanLength = Math.min(buffer.length, 2048);
  const slice = buffer.slice(0, scanLength);
  const start = skipLeadingPdfNoise(slice);

  const sample = slice
    .slice(start, Math.min(start + 512, scanLength))
    .toString("utf8")
    .trimStart()
    .toLowerCase();

  if (
    sample.startsWith("<!doctype") ||
    sample.startsWith("<html") ||
    sample.startsWith("<?xml")
  ) {
    return true;
  }

  const head = slice.slice(start, Math.min(start + 256, scanLength));
  if (head.length === 0 || head.includes(0)) {
    return false;
  }

  const text = head.toString("utf8");
  if (/^[\x20-\x7e\r\n\t]+$/.test(text) && !text.includes("%PDF-")) {
    return true;
  }

  return false;
}

function detectFormat(buffer, filenameHint = "") {
  for (const signature of BINARY_FORMAT_SIGNATURES) {
    if (signature.test(buffer)) {
      return { format: signature.format, mime: signature.mime, trusted: true };
    }
  }

  const pdfDetected = detectPdfFormat(buffer);
  if (pdfDetected) {
    return pdfDetected;
  }

  const lower = String(filenameHint || "").toLowerCase();
  if (lower.endsWith(".pdf")) {
    if (looksLikeHtmlOrPlainTextResponse(buffer)) {
      return { format: "html_or_text", mime: "text/plain", trusted: false };
    }
    return { format: "unknown_pdf_hint", mime: "application/octet-stream", trusted: false };
  }

  return { format: "unknown", mime: "application/octet-stream", trusted: false };
}

function validateResumeDocument(buffer, { filenameHint, allowedFormats = ["pdf", "doc", "docx"] } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, reason: "Document is empty." };
  }

  if (buffer.length > MAX_RESUME_BYTES) {
    return { ok: false, reason: "Document exceeds maximum allowed size." };
  }

  const detected = detectFormat(buffer, filenameHint);

  if (detected.format === "html_or_text") {
    return { ok: false, reason: "Document is not a valid PDF (received HTML or plain text)." };
  }

  if (detected.trusted === false && detected.format.startsWith("unknown")) {
    return { ok: false, reason: "Unsupported or unrecognized document format." };
  }

  if (!allowedFormats.includes(detected.format)) {
    return { ok: false, reason: `Document format ${detected.format} is not permitted.` };
  }

  const contentHash = hashResumeContent(buffer);

  return {
    ok: true,
    format: detected.format,
    mime: detected.mime,
    byte_length: buffer.length,
    content_hash: contentHash
  };
}

module.exports = {
  MAX_RESUME_BYTES,
  validateResumeDocument,
  detectFormat
};
