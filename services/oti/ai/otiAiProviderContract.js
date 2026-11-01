const PROVIDERS = Object.freeze({
  OPENAI: "openai",
  AZURE_OPENAI: "azure_openai"
});

function httpAiError(message, status = 503) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateAiProvider(definition) {
  const required = ["providerKey", "getConfiguration", "completeStructuredJson"];

  for (const key of required) {
    if (typeof definition[key] === "undefined") {
      throw new Error(`AI provider definition missing required field: ${key}`);
    }
  }
}

module.exports = {
  PROVIDERS,
  httpAiError,
  validateAiProvider
};
