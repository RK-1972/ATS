const { PROVIDERS, httpAiError } = require("./otiAiProviderContract");

function getConfiguration() {
  return {
    provider_key: PROVIDERS.AZURE_OPENAI,
    configured: false,
    model_id: String(process.env.OTI_AZURE_OPENAI_DEPLOYMENT || "").trim() || null,
    credential_source: "env:OTI_AZURE_OPENAI_* (not implemented in Phase 6)"
  };
}

async function completeStructuredJson() {
  throw httpAiError("Azure OpenAI reasoning provider is not implemented yet.", 501);
}

module.exports = {
  providerKey: PROVIDERS.AZURE_OPENAI,
  getConfiguration,
  completeStructuredJson
};
