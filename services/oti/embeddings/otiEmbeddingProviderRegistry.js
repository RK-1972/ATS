const { validateEmbeddingProvider } = require("./otiEmbeddingProviderContract");
const openAiEmbeddingProvider = require("./openAiEmbeddingProvider");
const azureOpenAiEmbeddingProvider = require("./azureOpenAiEmbeddingProvider");

const providers = new Map();

function registerProvider(definition) {
  validateEmbeddingProvider(definition);
  providers.set(definition.providerKey, definition);
}

function bootstrapProviders() {
  if (providers.size > 0) {
    return;
  }

  registerProvider(openAiEmbeddingProvider);
  registerProvider(azureOpenAiEmbeddingProvider);
}

function resolveActiveProviderKey() {
  const preferred = String(process.env.OTI_EMBEDDING_PROVIDER || "openai").trim().toLowerCase();
  bootstrapProviders();
  return providers.has(preferred) ? preferred : "openai";
}

function getActiveProvider() {
  bootstrapProviders();
  return providers.get(resolveActiveProviderKey()) || openAiEmbeddingProvider;
}

function listProviders() {
  bootstrapProviders();
  return Array.from(providers.values()).map((provider) => ({
    provider_key: provider.providerKey,
    configuration: provider.getConfiguration()
  }));
}

function resetProvidersForTests() {
  providers.clear();
}

module.exports = {
  registerProvider,
  bootstrapProviders,
  getActiveProvider,
  listProviders,
  resolveActiveProviderKey,
  resetProvidersForTests
};
