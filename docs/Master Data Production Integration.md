# Master Data — Production Integration (Backend Sprint 1)

This document describes the PostgreSQL-backed Enterprise Master Data implementation.

## Overview

Master Data is the first enterprise module integrated with the Express backend. All 35 logical entity types persist to PostgreSQL. The frontend continues to use the same UI, hooks, and store — only `masterDataRepository` switches from mock to live when `VITE_API_MODE=live`.

## Database Schema

### Core tables

| Table | Purpose |
|-------|---------|
| `md_entity_types` | Registry of 35 master entity types (domain, label, logical table name) |
| `md_records` | Unified physical storage for all master records |
| `md_record_history` | Version history per record |
| `md_enterprise_audit` | Enterprise audit log (Master Data events) |

### `md_records` columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | VARCHAR(120) PK | Stable ID, e.g. `md-grades-g10` |
| `entity_type` | VARCHAR(50) FK | Snake_case key, e.g. `grades` |
| `code` | VARCHAR(100) | Unique per entity type |
| `name` | VARCHAR(255) | Display name |
| `description` | TEXT | Optional |
| `status` | VARCHAR(20) | `Active` / `Inactive` |
| `version` | NUMERIC(5,1) | e.g. 1.0, 1.1 |
| `version_status` | VARCHAR(20) | `Draft` / `Published` / `Archived` |
| `used_by` | JSONB | Downstream module references |
| `effective_from` | TIMESTAMPTZ | Optional validity start |
| `effective_to` | TIMESTAMPTZ | Optional validity end |
| `created_by` | VARCHAR(255) | Audit user |
| `created_on` | TIMESTAMPTZ | Created timestamp |
| `modified_by` | VARCHAR(255) | Last modifier |
| `modified_on` | TIMESTAMPTZ | Last modified |
| `is_deleted` | BOOLEAN | Soft delete flag |

**Unique constraint:** `(entity_type, code)`

### Per-entity views (35)

Logical normalized tables exposed as views over `md_records`:

`md_business_units`, `md_departments`, `md_grades`, `md_cities`, … (full list in migration)

Example:

```sql
CREATE VIEW md_grades AS
  SELECT * FROM md_records WHERE entity_type = 'grades' AND is_deleted = FALSE;
```

## Migration

```bash
cd ats-backend
npm run migrate:master-data
npm run seed:master-data
```

Files:

- `migrations/001_master_data_schema.sql` — schema + entity registry + views
- `scripts/seedMasterData.js` — seeds ~80 records matching frontend mock data

## REST API

Base path: `/api/v1/master`  
Auth: `Authorization: Bearer <JWT>` + Admin role

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/master` | Full bundle `{ meta, domains, records }` |
| GET | `/api/v1/master/:entityType` | List records for entity |
| GET | `/api/v1/master/:entityType/export` | Export entity records |
| GET | `/api/v1/master/:entityType/:id` | Single record with history |
| POST | `/api/v1/master/:entityType` | Create record (Draft) |
| PUT | `/api/v1/master/:entityType/:id` | Update record |
| POST | `/api/v1/master/:entityType/:id/publish` | Publish record |
| POST | `/api/v1/master/:entityType/:id/archive` | Archive record |
| POST | `/api/v1/master/:entityType/:id/rollback` | Rollback to published version |
| DELETE | `/api/v1/master/:entityType/:id` | Soft delete |
| POST | `/api/v1/master/:entityType/import/preview` | Duplicate validation preview |
| POST | `/api/v1/master/:entityType/import` | Bulk import valid rows |

`:entityType` uses kebab-case in URLs (`business-units`) mapped to snake_case keys (`business_units`).

### Response format

Returns raw JSON DTOs (not `{ success, data }` wrapper) to match frontend `httpClient`.

Record DTO matches frontend store shape:

```json
{
  "id": "md-grades-g10",
  "entityType": "grades",
  "code": "G10",
  "name": "Grade G10",
  "description": "...",
  "status": "Active",
  "version": "1.0",
  "versionStatus": "Published",
  "usedBy": ["Business Rules", "Workflow"],
  "lastUpdated": "2026-06-26T10:00:00.000Z",
  "history": []
}
```

## Validation

| Rule | HTTP |
|------|------|
| Duplicate code (same entity type) | 409 |
| Duplicate name (same entity type) | 409 |
| Missing code/name on create | 400 |
| Invalid entity type | 400 |
| Record not found | 404 |
| Invalid status transition (publish) | 422 |
| `effective_from` > `effective_to` | 400 |
| Import duplicate codes | Marked `Duplicate` in preview |

## Audit

Every mutation writes to `md_enterprise_audit` with event types:

- `MasterDataCreated`
- `MasterDataUpdated`
- `MasterDataPublished`
- `MasterDataArchived`
- `MasterDataImported`
- `MasterDataRollback`

Frontend store also publishes in-memory audit events for immediate UI display (no hook changes).

## Frontend activation

In `ats-frontend/.env.local`:

```env
VITE_API_MODE=live
VITE_API_BASE_URL=http://localhost:5000
```

Bootstrap (`src/enterprise/bootstrap.js`) loads master data from API on app start.

## Success flow: Create Grade

1. Admin creates Grade G13 in `/master-data`
2. `masterDataRepository.saveRecord()` → `POST /api/v1/master/grades`
3. Record persisted in `md_records` + history + audit
4. Page refresh → `GET /api/v1/master` hydrates store
5. Business Rules Rule Simulator reads grades via `getMasterDataOptions()` from shared store

## Future integration considerations

1. **Other enterprise modules** — Follow same pattern: PostgreSQL tables + `/api/v1/*` + repository live mode
2. **Audit API** — Expose `GET /api/v1/audit` to hydrate frontend audit drawer from DB
3. **Dedicated tables** — Hot entities (grades, departments) can migrate from views to physical `md_*` tables without API changes
4. **Referential integrity** — Add FK constraints when downstream modules (requisitions, offers) reference master IDs
5. **Effective dating** — Enforce `effective_from`/`effective_to` in queries for time-travel lookups
6. **Route modularization** — Extract remaining `index.js` routes into domain routers

## File map

```
ats-backend/
├── migrations/001_master_data_schema.sql
├── masterData/entityTypes.js
├── services/masterDataService.js
├── routes/masterDataRoutes.js
└── scripts/
    ├── runMigrations.js
    └── seedMasterData.js
```
