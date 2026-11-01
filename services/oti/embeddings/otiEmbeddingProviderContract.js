/**
 * Provider-independent embedding contract (Phase 5).
 */

const PROVIDERS = Object.freeze({
  OPENAI: "openai",
  AZURE_OPENAI: "azure_openai"
});

function httpEmbeddingError(message, status = 503) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateEmbeddingProvider(definition) {
  const required = ["providerKey", "getConfiguration", "embedTexts"];

  for (const key of required) {
    if (typeof definition[key] === "undefined") {
      throw new Error(`Embedding provider missing required field: ${key}`);
    }
  }
}

module.exports = {
  PROVIDERS,
  httpEmbeddingError,
  validateEmbeddingProvider
};
