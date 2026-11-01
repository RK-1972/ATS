/**
 * Read-only OTI Phase 5 database capability inspection (no extension creation).
 */

require("dotenv").config();
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const version = await pool.query("SELECT version() AS version");
    const extension = await pool.query(
      "SELECT extname, extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1"
    );
    const canCreate = await pool.query(
      "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create"
    );
    const tableExists = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'oti_embedding_record'
       ) AS exists`
    );

    const report = {
      postgres_version: version.rows[0]?.version || null,
      pgvector_installed: Boolean(extension.rows[0]),
      pgvector_version: extension.rows[0]?.extversion || null,
      current_user_can_create_in_db: Boolean(canCreate.rows[0]?.can_create),
      oti_embedding_record_table_exists: Boolean(tableExists.rows[0]?.exists),
      recommended_storage_backend: extension.rows[0] ? "pgvector_or_jsonb" : "jsonb",
      notes: [
        "This script does not CREATE EXTENSION.",
        "Render deployments typically require JSONB backend until pgvector is explicitly enabled."
      ]
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error.message,
      hint: "Set DB_* env vars or run against a reachable PostgreSQL instance."
    })
  );
  process.exitCode = 1;
});
