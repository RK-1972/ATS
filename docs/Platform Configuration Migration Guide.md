# Platform Configuration — Migration Guide

This guide helps teams migrate from mock (in-memory) Platform Configuration to PostgreSQL-backed persistence.

## Prerequisites

- PostgreSQL database configured in `ats-backend/.env` (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`)
- Sprint 1 master data migration applied (`md_enterprise_audit` table exists)
- Backend running on port 5000 with valid Admin JWT

## Step 1 — Apply schema

```bash
cd ats-backend
npm run migrate:platform-config
```

This applies `002_platform_config_schema.sql` (runs all migrations in order).

## Step 2 — Seed initial configuration

```bash
npm run seed:platform-config
```

This loads `seed/platformConfig.seed.json` — identical to the frontend mock — into:

- `pc_config_state` (draft + published)
- `pc_config_snapshots` (initial v1.0 snapshot)
- All normalized `pc_*` tables

Re-running seed **replaces** existing platform configuration.

## Step 3 — Enable live mode (frontend)

```env
VITE_API_MODE=live
VITE_API_BASE_URL=http://localhost:5000
```

Restart the frontend dev server.

## Step 4 — Verify bootstrap

On login, `bootstrapEnterpriseData()` fetches:

```
GET /api/v1/platform-config
```

The Enterprise Store receives `platformConfig`, `platformConfigBaseline`, and `platformConfigDirty`.

## Migrating custom mock changes

If you customized `platformConfig.mock.js` locally:

1. Copy your JSON object to `ats-backend/seed/platformConfig.seed.json`
2. Re-run `npm run seed:platform-config`
3. Or use the import API:

```bash
curl -X POST http://localhost:5000/api/v1/platform-config/import/preview \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"payload": { ... your config ... }}'
```

Fix any validation errors, then:

```bash
curl -X POST http://localhost:5000/api/v1/platform-config/import \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"payload": { ... }, "reason": "Initial migration"}'
```

Publish when ready:

```bash
curl -X POST http://localhost:5000/api/v1/platform-config/publish \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Production cutover"}'
```

## Rollback procedure

1. List snapshots: `GET /api/v1/platform-config/snapshots`
2. Restore: `POST /api/v1/platform-config/restore/:snapshotId`
3. Confirm via `GET /api/v1/platform-config`

## Rollback to mock mode

Set `VITE_API_MODE=mock` (or remove the variable). No database changes required — the UI reverts to in-memory mock data.

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| Empty platform config on load | Run seed; check backend logs and JWT |
| 400 on module toggle | Dependency or mandatory module violation — check error message |
| Changes lost on refresh | Ensure live mode is active and draft mutations succeed (network tab) |
| Publish fails validation | Call `POST /validate` with draft payload to see errors |

## Data model notes

- Draft edits are stored in `pc_config_state.draft_payload` (JSONB)
- Published baseline is `pc_config_state.published_payload`
- Normalized tables update only on **publish** or **restore** — they are for reporting/querying, not draft edits
- Audit events share `md_enterprise_audit` with Master Data
