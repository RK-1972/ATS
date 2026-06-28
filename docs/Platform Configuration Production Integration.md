# Platform Configuration — Production Integration (Backend Sprint 2)

This document describes the PostgreSQL-backed Platform Configuration Engine.

## Overview

Platform Configuration persists to PostgreSQL using the same Repository → API Client → Express → PostgreSQL architecture introduced in Sprint 1. The frontend UI, hooks, and routing are unchanged — only `platformConfigRepository` (and delegated workflow/notification repositories) switch from mock to live when `VITE_API_MODE=live`.

## Database Schema

### Core tables

| Table | Purpose |
|-------|---------|
| `pc_config_state` | Single-row draft + published JSON payloads with version metadata |
| `pc_config_snapshots` | Published configuration history for rollback |
| `pc_general_settings` | Normalized org/environment meta (synced on publish) |
| `pc_modules` | Enabled modules |
| `pc_workflows` | Workflow definitions |
| `pc_budget_governance` | Budget approval and variance rules |
| `pc_notification_channels` | Notification channel toggles |
| `pc_notification_settings` | Digest, quiet hours, retry settings |
| `pc_ai_features` | AI feature toggles |
| `pc_ai_governance` | AI provider, limits, governance flags |
| `pc_role_visibility` | Role × module visibility matrix |
| `pc_approval_policies` | Budget approval chain + exception approvers |

Audit events reuse `md_enterprise_audit` from Sprint 1.

### Versioning model

- **Draft:** `pc_config_state.draft_payload` — live edits from the UI
- **Published:** `pc_config_state.published_payload` — last published baseline
- **Snapshots:** `pc_config_snapshots` — immutable history on each publish/restore
- Normalized tables reflect the **published** payload after publish/restore/seed

## Migration & Seed

```bash
cd ats-backend
npm run migrate:platform-config
npm run seed:platform-config
```

Files:

- `migrations/002_platform_config_schema.sql` — schema
- `seed/platformConfig.seed.json` — seed payload matching frontend mock
- `scripts/seedPlatformConfig.js` — loads seed into PostgreSQL

## REST API

Base path: `/api/v1/platform-config`  
Auth: `Authorization: Bearer <JWT>` + Admin role

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/platform-config` | Full bundle `{ config, baseline, isDirty, version }` |
| PATCH | `/api/v1/platform-config/draft` | Apply draft mutation `{ action, ...params }` |
| PUT | `/api/v1/platform-config/draft` | Replace entire draft payload |
| POST | `/api/v1/platform-config/publish` | Publish draft → published + snapshot |
| POST | `/api/v1/platform-config/discard` | Reset draft from published baseline |
| POST | `/api/v1/platform-config/archive` | Archive current configuration |
| POST | `/api/v1/platform-config/restore/:snapshotId` | Restore from snapshot |
| POST | `/api/v1/platform-config/validate` | Server-side validation |
| GET | `/api/v1/platform-config/export` | Export published configuration |
| GET | `/api/v1/platform-config/snapshots` | List configuration snapshots |
| POST | `/api/v1/platform-config/import/preview` | Import validation preview |
| POST | `/api/v1/platform-config/import` | Apply import to draft |

### Draft mutation actions

| Action | Parameters |
|--------|------------|
| `toggleModule` | `key` |
| `toggleWorkflow` | `key` |
| `updateBudget` | `field`, `value` |
| `updateNotificationSettings` | `field`, `value` |
| `updateAiGovernance` | `field`, `value` |
| `toggleNotificationChannel` | `key` |
| `toggleAiFeature` | `key` |
| `toggleRoleVisibility` | `role`, `moduleKey` |
| `insertWorkflowStage` | `workflowKey`, `stageName`, `afterStageName` |

### Response format

```json
{
  "config": { "meta": {}, "modules": [], "workflows": [], "...": "..." },
  "baseline": { "...": "published snapshot" },
  "isDirty": true,
  "version": "1.0",
  "versionStatus": "Published"
}
```

## Validation

Server-side checks include:

- Duplicate module/workflow/stage names
- Mandatory modules (e.g. recruitment) cannot be disabled
- Module dependency violations (`depends_on`)
- Dependent modules block disabling upstream modules
- Budget variance bounds (0–100%)
- Conflicting approval policies (duplicate roles in approval chain)
- Invalid archived workflow state

## Audit events

Written to `md_enterprise_audit`:

| Event | Trigger |
|-------|---------|
| `ModuleEnabled` / `ModuleDisabled` | Module toggle |
| `WorkflowUpdated` | Workflow toggle / stage insert |
| `NotificationChannelUpdated` | Channel or settings change |
| `BudgetThresholdChanged` | Budget field update |
| `RoleVisibilityChanged` | Role visibility matrix toggle |
| `AIConfigurationUpdated` | AI feature or governance change |
| `PlatformConfigurationPublished` | Publish |
| `PlatformConfigurationDiscarded` | Discard draft |
| `PlatformConfigurationRestored` | Restore snapshot |
| `PlatformConfigurationImported` | Import commit |

## Frontend integration

| File | Change |
|------|--------|
| `platformConfigRepository.js` | Live mode calls API; returns `{ config, baseline, isDirty }` |
| `platformConfigClient.js` | Full REST client |
| `workflowConfigurationRepository.js` | Delegates to platform config in live mode |
| `notificationsRepository.js` | Delegates to platform config in live mode |
| `enterpriseStore.js` | Platform actions use `Promise.resolve()` pattern |
| `bootstrap.js` | Loads platform config on startup in live mode |

## Activation

```env
# ats-frontend/.env
VITE_API_MODE=live
VITE_API_BASE_URL=http://localhost:5000
```

```bash
cd ats-backend && npm start
cd ats-frontend && npm run dev
```

## Verification scenarios

1. **Bootstrap load** — Start app in live mode; Platform Configuration screen shows seeded modules/workflows.
2. **Toggle module** — Disable `vendor_portal`; refresh page; change persists in draft.
3. **Publish** — Click Save/Publish; `meta.last_published` updates; draft equals baseline.
4. **Discard** — Edit budget threshold, discard; value reverts to published baseline.
5. **Dependency guard** — Attempt to disable `recruitment` while dependents enabled → API returns 400.
6. **Audit trail** — Query `md_enterprise_audit` for `ModuleEnabled`, `BudgetThresholdChanged`, etc.
7. **Export/import** — GET export returns published JSON; import preview flags validation errors.
8. **Restore** — Publish twice; restore snapshot 1; configuration reverts to earlier version.

See also: [Configuration Migration Guide](./Platform Configuration Migration Guide.md)
