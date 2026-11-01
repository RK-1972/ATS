# OTI Phase 5 — PostgreSQL & pgvector capability

## Purpose

Document how to verify embedding storage options **without** enabling extensions in production.

## Verification script

Run locally or against a read-only staging connection:

```bash
node scripts/checkOtiPgVectorCapability.js
```

The script reports:

- PostgreSQL `version()`
- Whether extension `vector` is installed (`pg_extension`)
- Whether the current role may create extensions (`pg_has_role` / `has_database_privilege` heuristics)
- Whether `oti_embedding_record` exists (post-migration 076)

## Expected environments

| Environment | Typical PostgreSQL | pgvector | Phase 5 storage |
|-------------|-------------------|----------|-----------------|
| Local dev | 14–16 (Docker) | Optional manual install | `embedding_json` JSONB; optional `embedding_vector` after ops migration |
| Render managed | 15+ (varies by plan) | **Not enabled by default** | JSONB cosine retrieval in application layer |
| Neon / cloud | Managed | Varies by project | JSONB fallback unless extension explicitly enabled |

## Production policy (Optalynx)

- **Do not** run `CREATE EXTENSION vector` on Render/production without DBA approval.
- Migration `076_oti_phase5_embeddings.sql` uses **JSONB embeddings only** so OTI semantic search works without pgvector.
- When pgvector is approved, apply the commented IVFFlat block at the bottom of migration `076` (or a follow-up ops migration) and set `OTI_VECTOR_STORAGE_BACKEND=pgvector`.

## Compatibility notes

- OpenAI `text-embedding-3-small` dimensions: **1536** (default in OTI config).
- IVFFlat indexes require sufficient row counts and maintenance; use JSONB backend until volume justifies pgvector.
