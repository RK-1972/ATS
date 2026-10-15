# Workforce Planning — Production Integration (Backend Sprint 5)

PostgreSQL-backed Workforce Planning module integrated with Master Data, Platform Configuration, Business Rules, Workflow Engine, and Enterprise Audit.

## Overview

Workforce Planning is the first complete business application on the OPTALYNX platform. When `VITE_API_MODE=live`, mock persistence is replaced by PostgreSQL services. UI, hooks, routing, and React components are unchanged — only the repository, API client, bootstrap, and store wiring switch to live APIs.

## Database Schema

| Table | Purpose |
|-------|---------|
| `wp_config_state` | Draft + published workforce bundle (JSON) |
| `wp_bundle_snapshots` | Version history / rollback |
| `wp_workforce_plans` | Plan metadata (fiscal year, org, currency) |
| `wp_budget_requests` | Budget request records |
| `wp_position_requests` | Position requests linked to budget requests |
| `wp_approved_positions` | Approved position catalogue |
| `wp_budget_utilization` | Aggregate budget utilization |
| `wp_department_headcount` | Department-level utilization |
| `wp_budget_exceptions` | Budget variance exceptions |
| `wp_position_lifecycle` | Position lifecycle events |

All normalized tables support versioning, draft/published/archived status, effective dates, and audit via `modified_by` / `modified_on`.

## Migration & Seed

```bash
cd ats-backend
export OPTALYNX_DB_TARGET=local
npm run migrate:verify
npm run migrate:up
npm run seed:workforce
```

Schema is applied via the Migration Manager (`migrate:up` runs pending files in order, including `005_workforce_planning_schema.sql`). See [database-migrations-runbook.md](./database-migrations-runbook.md). For Neon, set `OPTALYNX_MIGRATE_CONFIRM=I_UNDERSTAND_PRODUCTION`.

Files:

- `migrations/005_workforce_planning_schema.sql`
- `seed/workforcePlanning.seed.json` — generated from frontend mock shape
- `scripts/seedWorkforcePlanning.js`

## REST API

Base path: `/api/v1/workforce`  
Auth: Bearer JWT + Admin role

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/workforce` | Workforce bundle (config + baseline) |
| GET | `/api/v1/workforce/export` | Export published bundle |
| POST | `/api/v1/workforce/publish` | Publish draft to production tables |
| POST | `/api/v1/workforce/discard` | Discard draft, restore published |
| POST | `/api/v1/workforce/import/preview` | Validate import payload |
| POST | `/api/v1/workforce/import` | Apply import to draft |
| GET | `/api/v1/workforce/budget-requests/:id` | Single budget request |
| POST | `/api/v1/workforce/budget-requests/:id/approve` | Approve / route budget request |
| POST | `/api/v1/workforce/budget-requests/:id/reject` | Reject budget request |
| POST | `/api/v1/workforce/budget-requests/:id/send-back` | Send back to hiring manager |
| POST | `/api/v1/workforce/budget-requests/:id/request-clarification` | Request clarification (Workflow Engine) |
| POST | `/api/v1/workforce/budget-requests/:id/submit-clarification` | Submit clarification (Workflow Engine) |
| POST | `/api/v1/workforce/approved-positions/:id/requisitions` | Create requisition from approved position |

### Bundle response

```json
{
  "config": {
    "meta": {},
    "dashboard": {},
    "budget_requests": [],
    "approval_queue": [],
    "approved_positions": [],
    "budget_exceptions": [],
    "analytics": {}
  },
  "baseline": {},
  "isDirty": false,
  "version": "1.0",
  "versionStatus": "Published"
}
```

## Service Layer

`services/workforcePlanningService.js`:

| Method | Purpose |
|--------|---------|
| `getWorkforceBundle` | Load draft/published bundle |
| `approveBudgetRequest` | MD validation → platform config → business rules → workflow |
| `rejectBudgetRequest` | Reject + workflow advance + audit |
| `sendBackBudgetRequest` | Send back + audit |
| `requestBudgetClarification` | Workflow Engine clarification |
| `submitBudgetClarification` | Resume workflow after clarification |
| `createRequisition` | Requisition from approved position + lifecycle |
| `publishBundle` / `discardDraft` | Version management |
| `validateMasterDataReferences` | Departments, grades via Master Data |
| `evaluateBudgetRules` | Thresholds, routing via Business Rules Engine |
| `syncNormalizedTables` | Persist normalized rows on publish/seed |

## Platform Integration

### Master Data

Department and grade references are validated against `md_records` before approval. No hardcoded org values.

### Platform Configuration

- Recruitment module enablement checked before approval
- Budget governance thresholds from `pc_config_state`
- Approval policies honored via rule context

### Business Rules Engine

Budget thresholds, approval routing (TA Lead → Finance), exception handling, and leadership/finance approvals are delegated to `businessRulesService.simulateRules` with execution context (department, grade, salary, headcount).

### Workflow Engine

- Budget approvals start/advance `REQUISITION` workflow instances
- Clarifications use `requestClarification` / `submitClarification`
- Rejections advance workflow with `reject` action

### Enterprise Audit

Events written to shared `md_enterprise_audit`:

`BudgetApproved`, `BudgetRouted`, `BudgetRejected`, `BudgetSentBack`, `PositionApproved`, `ClarificationRequested`, `ClarificationSubmitted`, `RequisitionCreated`, `WorkforcePlanPublished`, `WorkforcePlanImported`

## Frontend Integration

| File | Change |
|------|--------|
| `workforcePlanningClient.js` | Full REST client with mock fallbacks |
| `workforcePlanningRepository.js` | Live mode delegates to API |
| `enterpriseStore.js` | Async approve/reject/sendBack/createRequisition |
| `bootstrap.js` | Loads workforce bundle on startup |

## Activation

```env
VITE_API_MODE=live
VITE_API_BASE_URL=http://localhost:5000
```

```bash
cd ats-backend
export OPTALYNX_DB_TARGET=local
npm run migrate:verify
npm run migrate:up
npm run seed:master-data
npm run seed:platform-config
npm run seed:business-rules
npm run seed:workflows
npm run seed:workforce
npm start
```

Applies all pending schema migrations in filename order (Sprints 1–5 and workforce). See [database-migrations-runbook.md](./database-migrations-runbook.md). For Neon, set `OPTALYNX_MIGRATE_CONFIRM=I_UNDERSTAND_PRODUCTION`.

See [Workforce Planning Verification Scenarios](./Workforce Planning Verification Scenarios.md).
