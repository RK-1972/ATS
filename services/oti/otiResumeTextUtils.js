/**
 * Resume text normalization and hashing for OTI indexing.
 */

const crypto = require("crypto");

const MAX_INDEX_TEXT_CHARS = 120000;

function normalizeResumeText(raw) {
  return String(raw || "")
    .replace(/\u0000/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashResumeContent(bufferOrText) {
  const input = Buffer.isBuffer(bufferOrText)
    ? bufferOrText
    : Buffer.from(String(bufferOrText || ""), "utf8");

  return crypto.createHash("sha256").update(input).digest("hex");
}

function truncateForIndex(text) {
  const normalized = normalizeResumeText(text);

  if (normalized.length <= MAX_INDEX_TEXT_CHARS) {
    return normalized;
  }

  return normalized.slice(0, MAX_INDEX_TEXT_CHARS);
}

function classifyExtractionFailure(error, extractedText) {
  const message = String(error?.message || error || "").toLowerCase();
  const text = normalizeResumeText(extractedText);

  if (message.includes("password") || message.includes("encrypted")) {
    return { status: "unsupported", reason: "Password-protected PDF is not supported." };
  }

  if (!text) {
    return { status: "failed", reason: "No extractable text was found in the document." };
  }

  if (message.includes("invalid") || message.includes("corrupt")) {
    return { status: "failed", reason: "The document appears corrupted or unreadable." };
  }

  return { status: "failed", reason: "Resume extraction failed." };
}

function isPdfPath(resumePath) {
  const value = String(resumePath || "").toLowerCase();
  return value.endsWith(".pdf") || value.includes(".pdf?");
}

module.exports = {
  normalizeResumeText,
  hashResumeContent,
  truncateForIndex,
  classifyExtractionFailure,
  isPdfPath,
  MAX_INDEX_TEXT_CHARS
};
