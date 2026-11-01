"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { cosineSimilarity, normalizeSimilarity } = require("../services/oti/otiVectorMath");
const { getPhase5HybridWeights } = require("../services/oti/otiRankingWeights");
const otiEmbeddingService = require("../services/oti/otiEmbeddingService");
const otiEmbeddingProviderRegistry = require("../services/oti/embeddings/otiEmbeddingProviderRegistry");
const otiVectorStoreService = require("../services/oti/otiVectorStoreService");
const otiSemanticHybridRankService = require("../services/oti/otiSemanticHybridRankService");
const otiSemanticRetrievalService = require("../services/oti/otiSemanticRetrievalService");
const { buildContentHash, buildCompositeEmbeddingText } = require("../services/oti/otiEmbeddingContentService");
const { inspectPgVectorCapability } = require("../services/oti/otiPgVectorCapability");

const MOCK_VECTOR_A = [1, 0, 0];
const MOCK_VECTOR_B = [0.9, 0.1, 0];

function mockProvider() {
  return {
    providerKey: "openai",
    getConfiguration: () => ({
      configured: true,
      model_id: "mock-embedding",
      dimensions: 3
    }),
    embedTexts: async (texts) => ({
      embeddings: texts.map(() => MOCK_VECTOR_A),
      usage: { input_tokens: 10, total_tokens: 10 },
      model_id: "mock-embedding",
      model_version: "v1",
      dimensions: 3
    })
  };
}

beforeEach(() => {
  otiEmbeddingProviderRegistry.resetProvidersForTests();
  otiEmbeddingProviderRegistry.registerProvider(mockProvider());
});

describe("oti phase5 vector math", () => {
  it("computes cosine similarity", () => {
    const score = cosineSimilarity(MOCK_VECTOR_A, MOCK_VECTOR_B);
    assert.ok(score > 0.9);
    assert.equal(normalizeSimilarity(score), score);
  });
});

describe("oti phase5 embedding idempotency", () => {
  it("skips provider call when content hash unchanged", async () => {
    const text = "Java Spring developer";
    const hash = buildContentHash(text);
    let providerCalls = 0;

    const countingProvider = {
      providerKey: "openai",
      getConfiguration: () => ({ configured: true, model_id: "mock-embedding", dimensions: 3 }),
      embedTexts: async () => {
        providerCalls += 1;
        return {
          embeddings: [MOCK_VECTOR_A],
          usage: { input_tokens: 1, total_tokens: 1 },
          model_id: "mock-embedding",
          model_version: "v1",
          dimensions: 3
        };
      }
    };

    otiEmbeddingProviderRegistry.resetProvidersForTests();
    otiEmbeddingProviderRegistry.registerProvider(countingProvider);

    const stored = new Map();
    const pool = {
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM oti_embedding_record") && text.includes("content_hash")) {
          const key = params?.slice(0, 5).join("|");
          const hit = stored.get(key);
          return { rows: hit ? [hit] : [] };
        }
        if (text.includes("INSERT INTO oti_embedding_record")) {
          const key = [params[0], params[1], params[2], params[3], params[5]].join("|");
          stored.set(key, {
            embedding_id: 1,
            embedding_json: MOCK_VECTOR_A,
            model_version: "v1"
          });
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_embedding_usage_log")) {
          return { rows: [] };
        }
        if (text.includes("pg_extension")) {
          return { rows: [] };
        }
        if (text.includes("version()")) {
          return { rows: [{ version: "PostgreSQL 16" }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [{ exists: false }] };
        }
        if (text.includes("has_database_privilege")) {
          return { rows: [{ can_create: false }] };
        }
        return { rows: [] };
      }
    };

    const first = await otiEmbeddingService.upsertEntityEmbedding(
      pool,
      {
        entity_type: "internal_candidate",
        entity_id: 1,
        source_kind: "composite",
        content_hash: hash
      },
      text,
      { provider: countingProvider }
    );

    const second = await otiEmbeddingService.upsertEntityEmbedding(
      pool,
      {
        entity_type: "internal_candidate",
        entity_id: 1,
        source_kind: "composite",
        content_hash: hash
      },
      text,
      { provider: countingProvider }
    );

    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    assert.equal(providerCalls, 1);
  });
});

describe("oti phase5 jsonb retrieval fallback", () => {
  it("ranks entities by cosine similarity without pgvector", async () => {
    const pool = {
      query: async (sql) => {
        const text = String(sql);

        if (text.includes("pg_extension")) {
          return { rows: [] };
        }
        if (text.includes("version()")) {
          return { rows: [{ version: "PostgreSQL 15" }] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: [{ exists: false }] };
        }
        if (text.includes("has_database_privilege")) {
          return { rows: [{ can_create: true }] };
        }
        if (text.includes("FROM oti_embedding_record")) {
          return {
            rows: [
              { entity_id: 10, embedding_json: MOCK_VECTOR_A },
              { entity_id: 11, embedding_json: [0, 1, 0] }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const results = await otiVectorStoreService.searchSimilarJsonb(pool, {
      entityType: "internal_candidate",
      queryVector: MOCK_VECTOR_A,
      modelId: "mock-embedding",
      limit: 5
    });

    assert.equal(results[0].entity_id, 10);
    assert.ok(results[0].similarity > results[1].similarity);
  });
});

describe("oti phase5 semantic hybrid ranking", () => {
  it("uses documented phase 5 weights including semantic similarity", async () => {
    const weights = getPhase5HybridWeights();
    const sum = Object.values(weights).reduce((total, value) => total + value, 0);
    assert.ok(Math.abs(sum - 1) < 0.0001);
    assert.ok(weights.semantic_similarity > 0);
  });

  it("labels semantic matches separately from exact skill overlap", () => {
    const merged = otiSemanticHybridRankService.mergeSemanticCandidates(
      [{ candidate_id: 1, source_type: "talent_pool" }],
      [],
      [{ candidate_id: 1, source_type: "semantic_index", semantic_similarity: 0.8 }]
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].semantic_similarity, 0.8);
    assert.match(String(merged[0].source_type), /semantic_index/);
  });
});

describe("oti phase5 semantic explainability", () => {
  it("includes disclaimer that similarity is not suitability probability", () => {
    const explanation = otiSemanticRetrievalService.explainSemanticMatch({
      similarity: 0.77,
      queryText: "Java architect"
    });

    assert.ok(explanation.semantic_similarity > 0);
    assert.match(explanation.disclaimer, /not a probability/i);
  });
});

describe("oti phase5 pgvector capability inspection", () => {
  it("defaults to jsonb backend when pgvector is unavailable", async () => {
    const capability = await inspectPgVectorCapability({
      query: async (sql) => {
        if (String(sql).includes("pg_extension")) {
          return { rows: [] };
        }
        if (String(sql).includes("version()")) {
          return { rows: [{ version: "PostgreSQL 15" }] };
        }
        if (String(sql).includes("information_schema.columns")) {
          return { rows: [{ exists: false }] };
        }
        if (String(sql).includes("has_database_privilege")) {
          return { rows: [{ can_create: false }] };
        }
        return { rows: [] };
      }
    });

    assert.equal(capability.pgvector_installed, false);
    assert.equal(capability.storage_backend, "jsonb");
  });
});

describe("oti phase5 embedding content builder", () => {
  it("builds composite text from JD and resume without inventing fields", () => {
    const text = buildCompositeEmbeddingText({
      queryText: "Kubernetes",
      requisition: { primary_skill: "Java", job_title: "Platform Engineer" },
      resumeText: "Built microservices on AWS.",
      skills: [{ name: "Java" }]
    });

    assert.match(text, /Java/);
    assert.match(text, /Platform Engineer/);
    assert.match(text, /microservices/);
  });
});
