# OPTALYNX — database schema migrations runbook

## Overview

Schema changes for the ATS backend are applied through the **Migration Manager** CLI (`scripts/migrateCli.js`). The manager maintains a PostgreSQL ledger (`schema_migrations`), checksum drift detection, orphan/recovery persistence, and controlled ledger repair / baseline adoption (no SQL replay for those recovery commands).

**Do not** use legacy `runMigrations.js` or standalone `apply*.js` runners — they are blocked and would bypass ledger and target guards.

## Environment

| Variable | Purpose |
|----------|---------|
| `OPTALYNX_DB_TARGET` | `local` or `neon` — required for connected commands |
| `DB_*` / connection | Resolved via `scripts/lib/migrationDb.js` (same as app) |
| `OPTALYNX_MIGRATE_CONFIRM` | `I_UNDERSTAND_PRODUCTION` — required for **mutating** commands against Neon |
| `OPTALYNX_MIGRATE_ALLOW_RETRY_CONFIRM` | `I_CONFIRM_MIGRATION_RETRY` — optional retry of a single `uncertain_partial` migration via `migrate:up --allow-retry-filename` |
| `OPTALYNX_BASELINE_ADOPT_CONFIRM` | Per-file value for `baseline-adopt --confirm` (see baseline adoption doc) |

## NPM scripts

| Script | Command |
|--------|---------|
| `npm run migrate` | CLI entry (`node scripts/migrateCli.js`) |
| `npm run migrate:status` | Read-only ledger summary |
| `npm run migrate:plan` | Read-only next steps |
| `npm run migrate:verify` | Drift, unknown ledger, orphan, fingerprint outcomes |
| `npm run migrate:dry-run` | No DDL/DML (`--offline` avoids DB) |
| `npm run migrate:up` | Apply pending migration SQL (mutating) |
| `npm run migrate:repair-ledger` | Record ledger row when fingerprints prove effects (no SQL) |
| `npm run migrate:baseline-plan` | Read-only adoption recommendations |
| `npm run migrate:test` | Unit tests (mocked; no disposable DB required) |
| `npm run migrate:test:integration` | PostgreSQL integration (`optalynx_mig_test` only) |
| `npm run migrate:verify-cli` | Core unit tests + offline dry-run |

## Typical workflow (local)

1. `OPTALYNX_DB_TARGET=local npm run migrate:status`
2. `OPTALYNX_DB_TARGET=local npm run migrate:verify`
3. Resolve **checksum drift** and **unknown ledger rows** (filenames in `schema_migrations` that are not in the repo) before any mutating command — the manager does not auto-delete unknown rows.
4. `OPTALYNX_DB_TARGET=local npm run migrate:up` — applies pending files in lexicographic filename order within the selected slice.

`migrate:up` refuses when:

- Checksum drift exists anywhere in the inventory
- Unknown ledger filenames exist (not present in the migrations directory)
- Recovery persistence is missing or orphan/recovery blocks apply (see verify output)
- Batch includes migration `059` and REGISTERED PAN duplicate preflight fails

## Recovery (ledger only, no migration SQL)

When verify reports `suspected_orphan` and fingerprints pass:

1. `migrate:repair-ledger --filename <file.sql>` **or** controlled `baseline-adopt` (dry-run, then confirm).

Details, confirmation strings, and limitations: **[migration-baseline-adoption.md](./migration-baseline-adoption.md)**.

## Integration testing

Disposable local database only — never `ats_dev` or Neon production targets:

**[migration-integration-tests.md](./migration-integration-tests.md)**

## Related documentation

- Baseline adoption: `docs/migration-baseline-adoption.md`
- Integration harness: `docs/migration-integration-tests.md`
