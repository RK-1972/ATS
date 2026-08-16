/**
 * Report export presentation formatters.
 * Mirrors frontend src/utils/formatDateTime.js (DD/MM/YYYY HH:mm).
 */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseOptalynxDateInput(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const str = String(value).trim();

  if (!str) {
    return null;
  }

  if (DATE_ONLY_PATTERN.test(str)) {
    const [year, month, day] = str.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function padTwo(value) {
  return String(value).padStart(2, "0");
}

function isDateOnlyValue(value) {
  if (value === null || value === undefined) {
    return false;
  }

  return DATE_ONLY_PATTERN.test(String(value).trim());
}

function formatOptalynxDate(value) {
  const date = parseOptalynxDateInput(value);

  if (!date) {
    return "";
  }

  return `${padTwo(date.getDate())}/${padTwo(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function formatOptalynxDateTime(value) {
  const date = parseOptalynxDateInput(value);

  if (!date) {
    return "";
  }

  return `${formatOptalynxDate(value)} ${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

function formatOptalynxDateTimeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (isDateOnlyValue(value)) {
    return formatOptalynxDate(value);
  }

  return formatOptalynxDateTime(value);
}

function formatExportCellValue(value, dataType) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (dataType === "date") {
    return formatOptalynxDateTimeValue(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function formatExportGeneratedTimestamp(date = new Date()) {
  return formatOptalynxDateTime(date.toISOString());
}

function sanitizeFilenamePart(value) {
  return String(value || "Report")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "Report";
}

function buildExportFilename(datasetCode, format, date = new Date()) {
  const datePart = date.toISOString().slice(0, 10);
  const safeDataset = sanitizeFilenamePart(datasetCode);
  return `Optalynx_${safeDataset}_${datePart}.${format}`;
}

module.exports = {
  formatExportCellValue,
  formatExportGeneratedTimestamp,
  formatOptalynxDateTimeValue,
  sanitizeFilenamePart,
  buildExportFilename
};
