/**
 * Embedding orchestration — idempotent generation, usage tracking, retries.
 */

const { getActiveProvider, resolveActiveProviderKey } = require("./embeddings/otiEmbeddingProviderRegistry");
const { upsertEmbeddingRecord } = require("./otiVectorStoreService");
const { inspectPgVectorCapability } = require("./otiPgVectorCapability");

const MAX_BATCH = Number(process.env.OTI_EMBEDDING_BATCH_SIZE || 16);
const RETRY_ATTEMPTS = 3;

function estimateCostUsd(totalTokens, modelId) {
  const per1k = String(modelId || "").includes("embedding-3-small") ? 0.00002 : 0.0001;
  return Number(((Number(totalTokens || 0) / 1000) * per1k).toFixed(6));
}

async function logUsage(pool, payload) {
  try {
    await pool.query(
      `INSERT INTO oti_embedding_usage_log (
         model_provider, model_id, request_type, input_tokens, total_tokens,
         estimated_cost_usd, entity_type, entity_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        payload.model_provider,
        payload.model_id,
        payload.request_type,
        payload.input_tokens,
        payload.total_tokens,
        payload.estimated_cost_usd,
        payload.entity_type || null,
        payload.entity_id || null
      ]
    );
  } catch {
    // usage log is best-effort when migration not applied
  }
}

async function findExistingEmbedding(pool, identity) {
  try {
    const result = await pool.query(
      `SELECT embedding_id, embedding_json, model_version
       FROM oti_embedding_record
       WHERE entity_type = $1
         AND entity_id = $2
         AND source_kind = $3
         AND content_hash = $4
         AND model_id = $5
       LIMIT 1`,
      [
        identity.entity_type,
        identity.entity_id,
        identity.source_kind,
        identity.content_hash,
        identity.model_id
      ]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const embedding =
      typeof row.embedding_json === "string"
        ? JSON.parse(row.embedding_json)
        : row.embedding_json;

    return { ...row, embedding_json: embedding };
  } catch {
    return null;
  }
}

async function embedWithRetry(provider, texts) {
  let lastError;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await provider.embedTexts(texts);
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_ATTEMPTS) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function upsertEntityEmbedding(pool, identity, text, deps = {}) {
  const provider = deps.provider || getActiveProvider();
  const config = provider.getConfiguration();

  if (!config.configured) {
    return { skipped: true, reason: "embedding_provider_not_configured" };
  }

  const contentHash = identity.content_hash;
  const existing = await findExistingEmbedding(pool, {
    ...identity,
    content_hash: contentHash,
    model_id: config.model_id
  });

  if (existing) {
    return { skipped: true, reason: "unchanged_content_hash", embedding_id: existing.embedding_id };
  }

  const result = await embedWithRetry(provider, [text]);
  const vector = result.embeddings?.[0];

  if (!vector) {
    throw new Error("Embedding provider returned no vector.");
  }

  const capability = await inspectPgVectorCapability(pool);

  await upsertEmbeddingRecord(pool, {
    entity_type: identity.entity_type,
    entity_id: identity.entity_id,
    source_kind: identity.source_kind || "composite",
    content_hash: contentHash,
    model_provider: resolveActiveProviderKey(),
    model_id: result.model_id || config.model_id,
    model_version: result.model_version || "v1",
    dimensions: result.dimensions || config.dimensions,
    token_count: result.usage?.total_tokens || 0,
    embedding_json: vector,
    storage_backend: capability.storage_backend
  });

  await logUsage(pool, {
    model_provider: resolveActiveProviderKey(),
    model_id: result.model_id || config.model_id,
    request_type: identity.source_kind || "composite",
    input_tokens: result.usage?.input_tokens || 0,
    total_tokens: result.usage?.total_tokens || 0,
    estimated_cost_usd: estimateCostUsd(result.usage?.total_tokens, result.model_id || config.model_id),
    entity_type: identity.entity_type,
    entity_id: identity.entity_id
  });

  return { skipped: false, dimensions: vector.length };
}

async function embedBatchTexts(pool, items, deps = {}) {
  const provider = deps.provider || getActiveProvider();
  const config = provider.getConfiguration();

  if (!config.configured || !items.length) {
    return { processed: 0, skipped: items.length };
  }

  let processed = 0;

  for (let index = 0; index < items.length; index += MAX_BATCH) {
    const batch = items.slice(index, index + MAX_BATCH);

    for (const item of batch) {
      await upsertEntityEmbedding(pool, item.identity, item.text, deps);
      processed += 1;
    }
  }

  return { processed };
}

function isEmbeddingConfigured() {
  return Boolean(getActiveProvider().getConfiguration().configured);
}

module.exports = {
  upsertEntityEmbedding,
  embedBatchTexts,
  findExistingEmbedding,
  isEmbeddingConfigured,
  estimateCostUsd,
  logUsage
};
