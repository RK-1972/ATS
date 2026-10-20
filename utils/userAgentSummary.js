const UAParser = require("ua-parser-js");

const SUMMARY_MAX_LENGTH = 255;
const SUMMARY_SEPARATOR = " · ";

function trimToMaxLength(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  if (text.length <= SUMMARY_MAX_LENGTH) {
    return text;
  }

  return `${text.slice(0, SUMMARY_MAX_LENGTH - 3)}...`;
}

function formatOsLabel(os = {}) {
  let name = String(os.name || "").trim();
  const version = String(os.version || "").trim();

  if (!name) {
    return null;
  }

  if (name === "Mac OS") {
    name = "macOS";
  }

  if (version && !name.includes(version)) {
    return `${name} ${version}`.trim();
  }

  return name;
}

function formatBrowserLabel(browser = {}) {
  const name = String(browser.name || "").trim();
  if (!name) {
    return null;
  }

  const version = String(browser.version || "").trim();
  const major = version ? version.split(".")[0] : "";

  if (major) {
    return `${name} ${major}`;
  }

  return name;
}

function formatDeviceLabel(device = {}) {
  const type = String(device.type || "").trim().toLowerCase();

  if (type === "mobile") {
    return "Mobile";
  }

  if (type === "tablet") {
    return "Tablet";
  }

  if (type === "wearable") {
    return "Wearable";
  }

  if (type === "smarttv" || type === "console" || type === "embedded" || type === "xr") {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  return "Desktop";
}

function buildSummaryFromParts(osLabel, browserLabel, deviceLabel) {
  if (!osLabel && !browserLabel) {
    return null;
  }

  const parts = [osLabel, browserLabel, deviceLabel].filter(Boolean);

  if (!parts.length) {
    return null;
  }

  return trimToMaxLength(parts.join(SUMMARY_SEPARATOR));
}

/**
 * Parse User-Agent header into a concise audit label for storage at login.
 */
function formatUserAgentSummary(userAgent) {
  const raw = String(userAgent || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parser = new UAParser(raw);
    const osLabel = formatOsLabel(parser.getOS());
    const browserLabel = formatBrowserLabel(parser.getBrowser());
    const deviceLabel = formatDeviceLabel(parser.getDevice());

    return buildSummaryFromParts(osLabel, browserLabel, deviceLabel);
  } catch {
    return null;
  }
}

/**
 * Detect values already stored in the V2 concise format (avoid re-parsing).
 */
function looksLikeFormattedSummary(stored) {
  const value = String(stored || "").trim();
  if (!value || value.length > 200) {
    return false;
  }

  if (/^mozilla\//i.test(value)) {
    return false;
  }

  const parts = value.split(SUMMARY_SEPARATOR);
  if (parts.length !== 3) {
    return false;
  }

  return parts.every((part) => {
    const segment = part.trim();
    return segment.length > 0 && segment.length <= 80;
  });
}

/**
 * API/display resolver: formatted summaries pass through; legacy raw UA parsed on read.
 */
function resolveUserAgentSummaryForDisplay(stored) {
  const value = String(stored || "").trim();
  if (!value) {
    return null;
  }

  if (looksLikeFormattedSummary(value)) {
    return value;
  }

  const parsed = formatUserAgentSummary(value);
  if (parsed) {
    return parsed;
  }

  if (value.length > 120 || /^mozilla\//i.test(value)) {
    return null;
  }

  return trimToMaxLength(value);
}

module.exports = {
  SUMMARY_MAX_LENGTH,
  SUMMARY_SEPARATOR,
  formatUserAgentSummary,
  resolveUserAgentSummaryForDisplay,
  looksLikeFormattedSummary
};
