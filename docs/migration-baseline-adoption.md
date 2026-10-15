# Migration manager — controlled baseline adoption (single file)

## Purpose

Record a **single** pending migration in `schema_migrations` when its SQL effects are already present but the ledger row is missing (`suspected_orphan` with passing fingerprints). **Adoption never runs migration SQL.**

This complements `repair-ledger`, which uses the same eligibility gates. Prefer **dry-run first**, then **confirm** with an explicit environment confirmation.

## Workflow

1. `npm run migrate -- verify` — expect failures while ledger is incomplete.
2. `npm run migrate -- baseline-plan --json` — review fingerprint recommendations for pending files.
3. `npm run migrate -- baseline-adopt --filename <file.sql> --dry-run [--json]` — eligibility only; **no writes**.
4. If eligible, set the confirmation variable (exact value from dry-run / help), then:
   `npm run migrate -- baseline-adopt --filename <file.sql> --confirm [--json]`
5. Re-run `verify` and `status`.

Adopt **one file at a time**, in migration order. Do not skip earlier pending migrations.

## Confirmation

```bash
export OPTALYNX_BASELINE_ADOPT_CONFIRM=I_ADOPT_LEDGER_RECORD_FOR_<exact-filename.sql>
```

Example:

```bash
export OPTALYNX_BASELINE_ADOPT_CONFIRM=I_ADOPT_LEDGER_RECORD_FOR_010_interview_stages_schema.sql
```

- The value must match the **full migration filename** including `.sql`.
- Required only for `--confirm`, not for `--dry-run`.
- On Neon, also set `OPTALYNX_MIGRATE_CONFIRM=I_UNDERSTAND_PRODUCTION` and `OPTALYNX_DB_TARGET=neon`.

## Eligibility (all required)

| Gate | Refusal |
|------|---------|
| File exists in migrations directory | Not found |
| Pending, not already applied | Already applied / not pending |
| No checksum drift **anywhere** in inventory | Drift present |
| Recovery persistence tables present | Missing orphans/recovery DDL |
| No active recovery block for this file | Recovery block row |
| `pendingKind === suspected_orphan` | `normal_pending`, `uncertain_partial`, `recovery_blocked` |
| Fingerprints configured and `allPass` | Missing or failing checks |
| `059_candidate_registered_pan_unique.sql` | Duplicate REGISTERED PAN preflight |
| Advisory lock | Another migration holder |
| Confirmation env | Missing or wrong value |
| Earlier pending migrations (lex order) | Any unresolved earlier file |
| Unknown ledger rows | Filenames in DB not in migration directory |

## Refusal scenarios

- **normal_pending** — schema not yet applied; use `migrate:up` (or fix prerequisites), not adoption.
- **uncertain_partial** — mixed/missing evidence; manual DBA review.
- **recovery_blocked** — resolve block before any ledger repair/adopt.
- **Drift** — reconcile file checksum vs ledger before any mutate.
- **059 preflight** — clean duplicate REGISTERED PAN groups first (counts only; PAN values are never logged).

## Audit trail

There is **no separate adoption audit table** in this phase. Adoption returns structured JSON:

- `filename`, `checksum`, `fingerprint` summary, `preflight059` summary (when applicable)
- `adoptionOutcome`: `ledger_recorded` (confirm) or `eligible` / `refused` (dry-run)
- `migrationSqlExecuted: false` (always)

Ledger write uses `schema_migrations`; orphan resolution and recovery-block clearance apply **only to the adopted filename** (same as `repair-ledger`).

## Recovery / rollback

- Wrong adoption: manual DBA review; remove erroneous ledger row only with change control.
- Adoption does not roll back schema. Use `repair-ledger` / `migrate:status` documentation for orphan flows.

## Limitations

- Fingerprints prove **configured signals**, not full schema or seed equivalence across environments (local vs Neon).
- **No bulk** `--all` adoption.
- `unknownInLedger` rows cause `verify` to fail and block `migrate:up`, `baseline-adopt`, and `repair-ledger` until manually resolved (the manager does not delete or reconcile unknown rows automatically).
