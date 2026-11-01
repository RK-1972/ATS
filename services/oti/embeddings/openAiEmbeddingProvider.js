/**
 * OpenAI embeddings provider (backend-only credentials).
 */

const { PROVIDERS, httpEmbeddingError } = require("./otiEmbeddingProviderContract");

const DEFAULT_MODEL = String(process.env.OTI_EMBEDDING_MODEL || "text-embedding-3-small").trim();
const DEFAULT_TIMEOUT_MS = Number(process.env.OTI_EMBEDDING_TIMEOUT_MS || 30000);
const DEFAULT_DIMENSIONS = Number(process.env.OTI_EMBEDDING_DIMENSIONS || 1536);

function getConfiguration() {
  const apiKey = String(process.env.OPENAI_API_KEY || process.env.OTI_OPENAI_API_KEY || "").trim();

  return {
    provider_key: PROVIDERS.OPENAI,
    configured: Boolean(apiKey),
    model_id: DEFAULT_MODEL,
    dimensions: DEFAULT_DIMENSIONS,
    credential_source: "env:OPENAI_API_KEY or env:OTI_OPENAI_API_KEY"
  };
}

async function embedTexts(texts, { modelId, dimensions } = {}) {
  const config = getConfiguration();

  if (!config.configured) {
    throw httpEmbeddingError("OpenAI embedding provider is not configured.", 503);
  }

  const apiKey = String(process.env.OPENAI_API_KEY || process.env.OTI_OPENAI_API_KEY || "").trim();
  const model = String(modelId || config.model_id).trim();
  const dims = Number(dimensions || config.dimensions);

  const input = (texts || []).map((text) => String(text || "").trim()).filter(Boolean);

  if (!input.length) {
    return { embeddings: [], usage: { input_tokens: 0, total_tokens: 0 } };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input,
        dimensions: dims
      }),
      signal: controller.signal
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw httpEmbeddingError("Embedding provider request failed.", response.status >= 500 ? 503 : 400);
    }

    const embeddings = (body.data || [])
      .sort((left, right) => Number(left.index) - Number(right.index))
      .map((row) => row.embedding);

    return {
      embeddings,
      usage: {
        input_tokens: Number(body.usage?.prompt_tokens || body.usage?.total_tokens || 0),
        total_tokens: Number(body.usage?.total_tokens || 0)
      },
      model_id: model,
      model_version: String(process.env.OTI_EMBEDDING_MODEL_VERSION || "v1").trim(),
      dimensions: dims
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpEmbeddingError("Embedding provider timed out.", 504);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  providerKey: PROVIDERS.OPENAI,
  getConfiguration,
  embedTexts
};
