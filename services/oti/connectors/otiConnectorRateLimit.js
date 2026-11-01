/**
 * In-process connector rate-limit guard (Phase 3 foundation; replace with shared store if scaled).
 */

const windows = new Map();

function getWindowKey(providerKey) {
  return String(providerKey || "unknown");
}

function assertWithinRateLimit(providerKey, { maxPerMinute = 30 } = {}) {
  const key = getWindowKey(providerKey);
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = windows.get(key) || { startedAt: now, count: 0 };

  if (now - bucket.startedAt >= windowMs) {
    bucket.startedAt = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  windows.set(key, bucket);

  if (bucket.count > maxPerMinute) {
    const error = new Error("Connector rate limit exceeded.");
    error.connectorCode = "rate_limited";
    error.retryAfterSeconds = Math.ceil((bucket.startedAt + windowMs - now) / 1000);
    throw error;
  }
}

function resetRateLimitsForTests() {
  windows.clear();
}

module.exports = {
  assertWithinRateLimit,
  resetRateLimitsForTests
};
