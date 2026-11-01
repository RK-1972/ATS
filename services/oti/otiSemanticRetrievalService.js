/**
 * Semantic similarity retrieval for internal candidates (Phase 5).
 */

const candidateAccessService = require("../candidateAccessService");
const otiEmbeddingService = require("./otiEmbeddingService");
const { getActiveProvider } = require("./embeddings/otiEmbeddingProviderRegistry");
const { buildCompositeEmbeddingText, buildContentHash } = require("./otiEmbeddingContentService");
const { searchSimilarJsonb } = require("./otiVectorStoreService");
const otiEmbeddingIndexService = require("./otiEmbeddingIndexService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function explainSemanticMatch({ similarity, queryText }) {
  return {
    semantic_similarity: Number(similarity.toFixed(4)),
    semantic_basis: "meaning_level_similarity",
    disclaimer:
      "Semantic similarity indicates related professional language; it is not a probability of suitability.",
    query_text: queryText || null
  };
}

async function ensureQueryEmbedding(pool, { queryText, requisition, structuredQuery }, deps = {}) {
  const text = buildCompositeEmbeddingText({
    queryText,
    requisition,
    skills: structuredQuery?.skill_tokens || []
  });

  if (!text) {
    throw httpError("Query text is required for semantic retrieval.", 400);
  }

  const provider = deps.provider || getActiveProvider();
  const config = provider.getConfiguration();

  const result = await otiEmbeddingService.upsertEntityEmbedding(
    pool,
    {
      entity_type: "search_query",
      entity_id: 0,
      source_kind: "query",
      content_hash: buildContentHash(`${config.model_id}:${text}`)
    },
    text,
    deps
  );

  if (result.skipped && result.reason === "embedding_provider_not_configured") {
    return { configured: false, queryVector: null, modelId: config.model_id };
  }

  const stored = await otiEmbeddingService.findExistingEmbedding(pool, {
    entity_type: "search_query",
    entity_id: 0,
    source_kind: "query",
    content_hash: buildContentHash(`${config.model_id}:${text}`),
    model_id: config.model_id
  });

  return {
    configured: true,
    queryVector: stored?.embedding_json || null,
    modelId: config.model_id
  };
}

async function searchInternalCandidatesSemantic(pool, req, options = {}) {
  const {
    requisitionCode,
    queryText,
    requisition,
    structuredQuery,
    limit = 50,
    candidateIdsToEmbed = []
  } = options;

  if (!otiEmbeddingService.isEmbeddingConfigured()) {
    return {
      candidates: [],
      excluded: [],
      limitation_notes: ["Semantic retrieval skipped: embedding provider is not configured."],
      semantic_enabled: false
    };
  }

  for (const candidateId of candidateIdsToEmbed.slice(0, 100)) {
    await otiEmbeddingIndexService.embedInternalCandidateFromIndex(pool, candidateId, options.deps);
  }

  const queryEmbedding = await ensureQueryEmbedding(pool, { queryText, requisition, structuredQuery }, options.deps);

  if (!queryEmbedding.configured || !queryEmbedding.queryVector) {
    return {
      candidates: [],
      excluded: [],
      limitation_notes: ["Semantic retrieval unavailable."],
      semantic_enabled: false
    };
  }

  const similar = await searchSimilarJsonb(pool, {
    entityType: "internal_candidate",
    queryVector: queryEmbedding.queryVector,
    modelId: queryEmbedding.modelId,
    limit: Math.min(limit, 100)
  });

  const included = [];
  const excluded = [];

  for (const row of similar) {
    const accessRow = await candidateAccessService.loadCandidateAccessRow(pool, row.entity_id);

    if (!accessRow) {
      excluded.push({ candidate_id: row.entity_id, reason: "not_found" });
      continue;
    }

    if (!candidateAccessService.canReadCandidateRow(accessRow, req)) {
      const draftAllowed = await candidateAccessService.canReviewDraftCandidateRow(pool, accessRow, req);
      if (!draftAllowed) {
        excluded.push({ candidate_id: row.entity_id, reason: "access_denied" });
        continue;
      }
    }

    if (requisitionCode) {
      const activeMapping = await pool.query(
        `SELECT 1 FROM rm_candidate_mappings
         WHERE candidate_id = $1 AND requisition_code = $2 AND is_active = TRUE
         LIMIT 1`,
        [row.entity_id, requisitionCode]
      );

      if (activeMapping.rows[0]) {
        excluded.push({ candidate_id: row.entity_id, reason: "active_mapping_on_target_req" });
        continue;
      }
    }

    included.push({
      candidate_id: row.entity_id,
      source_type: "semantic_index",
      semantic_similarity: row.similarity,
      index_metadata: {
        semantic_explanation: explainSemanticMatch({ similarity: row.similarity, queryText })
      }
    });
  }

  return {
    candidates: included,
    excluded,
    limitation_notes: [],
    semantic_enabled: true
  };
}

async function searchExternalLeadsSemantic(pool, req, { queryText, requisition, structuredQuery, limit = 25 } = {}) {
  if (!otiEmbeddingService.isEmbeddingConfigured()) {
    return { leads: [], semantic_enabled: false };
  }

  const queryEmbedding = await ensureQueryEmbedding(pool, { queryText, requisition, structuredQuery });

  if (!queryEmbedding.queryVector) {
    return { leads: [], semantic_enabled: false };
  }

  const similar = await searchSimilarJsonb(pool, {
    entityType: "external_lead",
    queryVector: queryEmbedding.queryVector,
    modelId: queryEmbedding.modelId,
    limit
  });

  return {
    leads: similar.map((row) => ({
      external_lead_id: row.entity_id,
      semantic_similarity: row.similarity,
      match_explanation: explainSemanticMatch({ similarity: row.similarity, queryText })
    })),
    semantic_enabled: true
  };
}

module.exports = {
  searchInternalCandidatesSemantic,
  searchExternalLeadsSemantic,
  explainSemanticMatch
};
