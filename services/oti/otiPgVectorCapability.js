/**
 * Read-only pgvector capability detection (no CREATE EXTENSION).
 */

async function inspectPgVectorCapability(pool) {
  if (!pool || typeof pool.query !== "function") {
    return {
      postgres_version: null,
      pgvector_installed: false,
      pgvector_version: null,
      vector_column_available: false,
      storage_backend: "jsonb",
      can_create_extension: false
    };
  }

  try {
    const version = await pool.query("SELECT version() AS version");
    const extension = await pool.query(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1"
    );
    const createPriv = await pool.query(
      "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create"
    );
    const vectorColumn = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'oti_embedding_record'
           AND column_name = 'embedding_vector'
       ) AS exists`
    );

    const pgvectorInstalled = Boolean(extension.rows[0]);
    const configuredBackend = String(process.env.OTI_VECTOR_STORAGE_BACKEND || "").trim().toLowerCase();
    const usePgVector =
      pgvectorInstalled &&
      Boolean(vectorColumn.rows[0]?.exists) &&
      (configuredBackend === "pgvector" || configuredBackend === "auto");

    return {
      postgres_version: version.rows[0]?.version || null,
      pgvector_installed: pgvectorInstalled,
      pgvector_version: extension.rows[0]?.extversion || null,
      vector_column_available: Boolean(vectorColumn.rows[0]?.exists),
      storage_backend: usePgVector ? "pgvector" : "jsonb",
      can_create_extension: Boolean(createPriv.rows[0]?.can_create)
    };
  } catch {
    return {
      postgres_version: null,
      pgvector_installed: false,
      pgvector_version: null,
      vector_column_available: false,
      storage_backend: "jsonb",
      can_create_extension: false
    };
  }
}

module.exports = {
  inspectPgVectorCapability
};
