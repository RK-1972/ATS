/**
 * Azure OpenAI embeddings provider (prepared for future use).
 */

const { PROVIDERS, httpEmbeddingError } = require("./otiEmbeddingProviderContract");

function getConfiguration() {
  const endpoint = String(process.env.AZURE_OPENAI_ENDPOINT || "").trim();
  const apiKey = String(process.env.AZURE_OPENAI_API_KEY || "").trim();
  const deployment = String(process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "").trim();

  return {
    provider_key: PROVIDERS.AZURE_OPENAI,
    configured: Boolean(endpoint && apiKey && deployment),
    model_id: deployment || null,
    dimensions: Number(process.env.OTI_EMBEDDING_DIMENSIONS || 1536),
    credential_source:
      "env:AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_EMBEDDING_DEPLOYMENT"
  };
}

async function embedTexts() {
  const config = getConfiguration();

  if (!config.configured) {
    throw httpEmbeddingError("Azure OpenAI embedding provider is not configured.", 503);
  }

  throw httpEmbeddingError(
    "Azure OpenAI embedding execution is not enabled in this release; interface is reserved.",
    501
  );
}

module.exports = {
  providerKey: PROVIDERS.AZURE_OPENAI,
  getConfiguration,
  embedTexts
};
