/**
 * Shared fetch helper for OTI connectors (Node 18+ global fetch).
 */

async function connectorFetch(url, options = {}, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text,
      json
    };
  } finally {
    clearTimeout(timer);
  }
}

async function connectorFetchBuffer(url, options = {}, { timeoutMs = 30000, maxBytes = 15 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > maxBytes) {
      const error = new Error("Response exceeds maximum allowed document size.");
      error.status = 413;
      throw error;
    }

    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      buffer
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  connectorFetch,
  connectorFetchBuffer
};
