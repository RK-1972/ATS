/**
 * Resolve client IP for audit/session records behind reverse proxies.
 * TRUST_PROXY=true enables the first hop of X-Forwarded-For / X-Real-IP.
 */

function normalizeIp(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }

  // IPv6 loopback; equivalent to 127.0.0.1 for local/direct connections.
  if (raw === "::1") {
    return "127.0.0.1";
  }

  return raw.slice(0, 64);
}

function parseForwardedFor(headerValue) {
  const parts = String(headerValue || "")
    .split(",")
    .map((item) => normalizeIp(item))
    .filter(Boolean);

  return parts[0] || null;
}

function isTrustProxyEnabled() {
  const flag = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function resolveClientIp(req) {
  if (!req) {
    return null;
  }

  if (isTrustProxyEnabled()) {
    const forwarded = parseForwardedFor(req.headers?.["x-forwarded-for"]);
    if (forwarded) {
      return forwarded;
    }

    const realIp = normalizeIp(req.headers?.["x-real-ip"]);
    if (realIp) {
      return realIp;
    }
  }

  return (
    normalizeIp(req.ip)
    || normalizeIp(req.socket?.remoteAddress)
    || null
  );
}

module.exports = {
  resolveClientIp,
  normalizeIp,
  isTrustProxyEnabled,
  parseForwardedFor
};
