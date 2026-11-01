/**
 * OpenAI chat completions for structured OTI reasoning (backend-only credentials).
 */

const { PROVIDERS, httpAiError } = require("./otiAiProviderContract");

const DEFAULT_MODEL = String(process.env.OTI_AI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const DEFAULT_TIMEOUT_MS = Number(process.env.OTI_AI_TIMEOUT_MS || 45000);
const DEFAULT_MAX_OUTPUT_TOKENS = Number(process.env.OTI_AI_MAX_OUTPUT_TOKENS || 1800);

function getConfiguration() {
  const apiKey = String(process.env.OPENAI_API_KEY || process.env.OTI_OPENAI_API_KEY || "").trim();

  return {
    provider_key: PROVIDERS.OPENAI,
    configured: Boolean(apiKey),
    model_id: DEFAULT_MODEL,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    credential_source: "env:OPENAI_API_KEY or env:OTI_OPENAI_API_KEY"
  };
}

async function completeStructuredJson(
  { systemPrompt, userPrompt, maxOutputTokens, modelId, responseLabel },
  { fetchImpl = fetch } = {}
) {
  const config = getConfiguration();

  if (!config.configured) {
    throw httpAiError("OpenAI reasoning provider is not configured.", 503);
  }

  const apiKey = String(process.env.OPENAI_API_KEY || process.env.OTI_OPENAI_API_KEY || "").trim();
  const model = String(modelId || config.model_id).trim();
  const maxTokens = Number(maxOutputTokens || config.max_output_tokens);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: String(systemPrompt || "").trim() },
          { role: "user", content: String(userPrompt || "").trim() }
        ]
      }),
      signal: controller.signal
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        body?.error?.message ||
        `OpenAI request failed (${response.status}) for ${responseLabel || "oti_ai"}.`;
      throw httpAiError(message, response.status >= 500 ? 503 : 400);
    }

    const content = body?.choices?.[0]?.message?.content;
    let parsed = null;

    try {
      parsed = JSON.parse(String(content || "{}"));
    } catch {
      throw httpAiError("OpenAI returned invalid JSON.", 502);
    }

    return {
      json: parsed,
      usage: {
        input_tokens: Number(body.usage?.prompt_tokens || 0),
        output_tokens: Number(body.usage?.completion_tokens || 0),
        total_tokens: Number(body.usage?.total_tokens || 0)
      },
      model_id: model,
      model_provider: PROVIDERS.OPENAI
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpAiError("OpenAI reasoning request timed out.", 504);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  providerKey: PROVIDERS.OPENAI,
  getConfiguration,
  completeStructuredJson
};
