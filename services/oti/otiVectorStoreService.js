/**
 * Provider-independent vector storage & similarity search.
 */

const { inspectPgVectorCapability } = require("./otiPgVectorCapability");
const { cosineSimilarity, normalizeSimilarity } = require("./otiVectorMath");

async function loadEmbeddingsForEntities(pool, { entityType, entityIds = [], modelId }) {
  if (!entityIds.length) {
    return [];
  }

  const result = await pool.query(
    `SELECT entity_id, embedding_json, model_id, model_version, content_hash, dimensions
     FROM oti_embedding_record
     WHERE entity_type = $1
       AND source_kind = 'composite'
       AND model_id = $2
       AND entity_id = ANY($3::int[])`,
    [entityType, modelId, entityIds]
  );

  return result.rows.map((row) => ({
    entity_id: row.entity_id,
    vector: row.embedding_json,
    model_id: row.model_id,
    model_version: row.model_version,
    content_hash: row.content_hash,
    dimensions: row.dimensions
  }));
}

async function searchSimilarJsonb(pool, { entityType, queryVector, modelId, limit = 50 }) {
  const capability = await inspectPgVectorCapability(pool);

  if (capability.storage_backend === "pgvector" && capability.vector_column_available) {
    try {
      const vectorLiteral = `[${queryVector.join(",")}]`;
      const pgResult = await pool.query(
        `SELECT entity_id,
                1 - (embedding_vector <=> $1::vector) AS similarity
         FROM oti_embedding_record
         WHERE entity_type = $2
           AND source_kind = 'composite'
           AND model_id = $3
           AND embedding_vector IS NOT NULL
         ORDER BY embedding_vector <=> $1::vector
         LIMIT $4`,
        [vectorLiteral, entityType, modelId, limit]
      );

      return pgResult.rows.map((row) => ({
        entity_id: row.entity_id,
        similarity: normalizeSimilarity(Number(row.similarity))
      }));
    } catch {
      // Fall back to JSONB application-layer similarity when pgvector query is unavailable.
    }
  }

  const rows = await pool.query(
    `SELECT entity_id, embedding_json
     FROM oti_embedding_record
     WHERE entity_type = $1
       AND source_kind = 'composite'
       AND model_id = $2`,
    [entityType, modelId]
  );

  const scored = rows.rows.map((row) => ({
    entity_id: row.entity_id,
    similarity: normalizeSimilarity(cosineSimilarity(queryVector, row.embedding_json))
  }));

  scored.sort((left, right) => right.similarity - left.similarity);
  return scored.slice(0, limit);
}

async function upsertEmbeddingRecord(pool, payload) {
  await pool.query(
    `INSERT INTO oti_embedding_record (
       entity_type, entity_id, source_kind, content_hash,
       model_provider, model_id, model_version, dimensions, token_count,
       embedding_json, storage_backend
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (entity_type, entity_id, source_kind, content_hash, model_id)
     DO UPDATE SET
       embedding_json = EXCLUDED.embedding_json,
       dimensions = EXCLUDED.dimensions,
       token_count = EXCLUDED.token_count,
       storage_backend = EXCLUDED.storage_backend,
       updated_on = NOW()`,
    [
      payload.entity_type,
      payload.entity_id,
      payload.source_kind,
      payload.content_hash,
      payload.model_provider,
      payload.model_id,
      payload.model_version,
      payload.dimensions,
      payload.token_count,
      JSON.stringify(payload.embedding_json),
      payload.storage_backend || "jsonb"
    ]
  );
}

module.exports = {
  loadEmbeddingsForEntities,
  searchSimilarJsonb,
  upsertEmbeddingRecord
};
