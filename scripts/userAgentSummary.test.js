const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  SUMMARY_MAX_LENGTH,
  formatUserAgentSummary,
  resolveUserAgentSummaryForDisplay,
  looksLikeFormattedSummary
} = require("../utils/userAgentSummary");
const { mapSessionRow } = require("../services/applicationSessionService");

const WIN_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const MAC_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";

describe("userAgentSummary", () => {
  it("formats Windows Chrome desktop for storage", () => {
    const summary = formatUserAgentSummary(WIN_CHROME_UA);
    assert.ok(summary);
    assert.match(summary, /Windows/i);
    assert.match(summary, /Chrome/i);
    assert.match(summary, /Desktop/);
    assert.ok(summary.length <= SUMMARY_MAX_LENGTH);
  });

  it("formats macOS Safari desktop", () => {
    const summary = formatUserAgentSummary(MAC_SAFARI_UA);
    assert.ok(summary);
    assert.match(summary, /macOS/i);
    assert.match(summary, /Safari/i);
    assert.match(summary, /Desktop/);
  });

  it("formats Android Chrome mobile", () => {
    const summary = formatUserAgentSummary(ANDROID_CHROME_UA);
    assert.ok(summary);
    assert.match(summary, /Android/i);
    assert.match(summary, /Chrome/i);
    assert.match(summary, /Mobile/);
  });

  it("formats Microsoft Edge", () => {
    const summary = formatUserAgentSummary(EDGE_UA);
    assert.ok(summary);
    assert.match(summary, /Edge/i);
  });

  it("returns null for missing User-Agent", () => {
    assert.equal(formatUserAgentSummary(""), null);
    assert.equal(formatUserAgentSummary(null), null);
    assert.equal(formatUserAgentSummary(undefined), null);
  });

  it("returns null for malformed values", () => {
    assert.equal(formatUserAgentSummary("not-a-real-ua"), null);
  });

  it("caps output at VARCHAR(255)", () => {
    const longUa = `${WIN_CHROME_UA} ${"x".repeat(400)}`;
    const summary = formatUserAgentSummary(longUa);
    assert.ok(summary);
    assert.ok(summary.length <= SUMMARY_MAX_LENGTH);
  });

  it("passes through already-formatted summaries on read", () => {
    const formatted = "Windows 11 · Chrome 141 · Desktop";
    assert.equal(looksLikeFormattedSummary(formatted), true);
    assert.equal(resolveUserAgentSummaryForDisplay(formatted), formatted);
  });

  it("parses legacy raw User-Agent on read without DB update", () => {
    const display = resolveUserAgentSummaryForDisplay(WIN_CHROME_UA);
    assert.ok(display);
    assert.match(display, /Chrome/i);
    assert.match(display, /Desktop/);
    assert.ok(!display.startsWith("Mozilla"));
  });

  it("returns null for absent legacy display values", () => {
    assert.equal(resolveUserAgentSummaryForDisplay(null), null);
    assert.equal(resolveUserAgentSummaryForDisplay(""), null);
  });
});

describe("mapSessionRow user_agent_summary", () => {
  it("maps formatted and legacy user agent for API responses", () => {
    const formatted = mapSessionRow({
      session_id: "11111111-1111-4111-8111-111111111111",
      employee_code: "EMP-1",
      login_at: "2026-01-01T10:00:00.000Z",
      logout_at: null,
      last_seen_at: "2026-01-01T10:00:00.000Z",
      source_ip: "127.0.0.1",
      status: "ACTIVE",
      user_agent_summary: "Windows 11 · Chrome 141 · Desktop"
    });

    assert.equal(formatted.user_agent_summary, "Windows 11 · Chrome 141 · Desktop");

    const legacy = mapSessionRow({
      session_id: "11111111-1111-4111-8111-111111111111",
      employee_code: "EMP-1",
      login_at: "2026-01-01T10:00:00.000Z",
      logout_at: null,
      last_seen_at: "2026-01-01T10:00:00.000Z",
      source_ip: "127.0.0.1",
      status: "ACTIVE",
      user_agent_summary: WIN_CHROME_UA
    });

    assert.ok(legacy.user_agent_summary);
    assert.match(legacy.user_agent_summary, /Chrome/i);
  });
});
