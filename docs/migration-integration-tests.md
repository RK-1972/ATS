# Migration manager — disposable PostgreSQL integration tests

## Purpose

Exercises real PostgreSQL semantics for the Migration Manager CLI and runner. **Not** a substitute for production readiness; complements mocked unit tests in `scripts/migrationManager.test.js`.

## Prerequisites

- Local PostgreSQL (or Docker), reachable on `localhost` / `127.0.0.1` / `::1` only.
- **Do not** point tests at `ats_dev`, `neondb`, Neon, or Render.

## Required environment (no `.env` fallback)

```bash
set TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/optalynx_mig_test
set OPTALYNX_MIG_TEST_DESTROY_CONFIRM=I_AUTHORIZE_DISPOSABLE_MIGRATION_TEST_DB
cd ats-backend
npm run migrate:test:integration
```

### Safety rules

| Check | Behavior |
|--------|----------|
| `TEST_DATABASE_URL` | Required; parsed without `dotenv` |
| Database name | Must match `optalynx_mig_test` or `optalynx_mig_test_<suffix>` |
| Forbidden names | `ats_dev`, `neondb`, `postgres` (as target), templates |
| Host | Local only; refuses `*.neon.tech`, `*.render.com`, etc. |
| `OPTALYNX_MIG_TEST_DESTROY_CONFIRM` | Required before `CREATE DATABASE` / `DROP DATABASE` |
| `OPTALYNX_MIG_INTEGRATION_REQUIRE_PG=1` | If `TEST_DATABASE_URL` is set but the probe fails, exit non-zero (CI); omit to allow skips when PG is optional |
| Cleanup | `DROP DATABASE` only after name re-validation |

## Commands

| Script | Description |
|--------|-------------|
| `npm run migrate:test` | Mocked unit tests (no DB) |
| `npm run migrate:test:integration` | Disposable PostgreSQL integration suite |
| `npm run migrate:verify-cli` | Unit tests + offline dry-run |

## Fingerprint review

Integration suite includes a **fingerprint limitation report** (`migrationFingerprintReviewReport.js`). Regclass, column/index presence, and minimum row counts **do not** prove full schema or seed equivalence.

## Scenarios not fully automated

- Full `001–060` chain on empty database (time/prerequisite cost).
- Neon/Render target guards against real cloud hosts (local-only harness).
- Microsoft Graph / external services (N/A).
- Human DBA recovery when **both** orphan and recovery-block persistence fail and fingerprints are inconclusive (partially covered by mocks).

## Cleanup

The harness terminates connections and `DROP DATABASE` only for the validated disposable name. If integration tests abort mid-run, manually drop `optalynx_mig_test` after confirming the name on a **local** instance.
