const { validateAiProvider } = require("./otiAiProviderContract");
const openAiReasoningProvider = require("./openAiReasoningProvider");
const azureOpenAiReasoningProvider = require("./azureOpenAiReasoningProvider");

const providers = new Map();

function registerProvider(definition) {
  validateAiProvider(definition);
  providers.set(definition.providerKey, definition);
}

function bootstrapProviders() {
  if (providers.size > 0) {
    return;
  }

  registerProvider(openAiReasoningProvider);
  registerProvider(azureOpenAiReasoningProvider);
}

function resolveActiveProviderKey() {
  const preferred = String(process.env.OTI_AI_PROVIDER || "openai").trim().toLowerCase();
  bootstrapProviders();
  return providers.has(preferred) ? preferred : "openai";
}

function getActiveProvider() {
  bootstrapProviders();
  return providers.get(resolveActiveProviderKey()) || openAiReasoningProvider;
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
