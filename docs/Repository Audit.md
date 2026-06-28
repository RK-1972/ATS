# Repository Audit

**OPTALYNX Enterprise Architecture Audit · Section 6**

All repositories live in `ats-frontend/src/repositories/`. Pattern: `isLiveMode()` from `api/config.js` gates API calls; mock handlers in clients return local mock data when `VITE_API_MODE=mock` (default).

---

## Summary Table

| Repository | Purpose | Reads From | Writes To | Mock? | Live API? | Duplicated logic? |
|------------|---------|------------|-----------|-------|-----------|-------------------|
| `baseRepository.js` | Shared helpers | — | — | — | — | N/A |
| `masterDataRepository` | Master data CRUD, import/export | `masterDataClient` → `/api/v1/master` | Same | Yes (`masterData.mock.js`) | Yes | No |
| `platformConfigRepository` | Platform config draft/publish | `platformConfigClient` | Same | Yes (`platformConfig.mock.js`) | Yes | Overlaps with `notificationsRepository` for notification settings |
| `businessRulesRepository` | Rules CRUD, simulate | `businessRulesClient` | Same | Yes (`businessRules.mock.js`) | Yes | No |
| `workflowsRepository` | Workflow config + instances + HCT process | `workflowsClient` | Same | Yes (HCT mock for hiring process in mock mode) | Yes | **Overlaps** `hiringControlTowerRepository`, `workflowConfigurationRepository` |
| `workflowConfigurationRepository` | Workflow toggles in platform config UI | Delegates to `workflowsRepository` in live mode; `workflowConfigurationClient` in mock | Platform config / workflows | Yes | Yes (via delegate) | **Duplicate** of workflows access path |
| `workforcePlanningRepository` | Workforce budget, catalogue | `workforcePlanningClient` | Same | Yes (`workforcePlanning.mock.js`) | Yes | `createRequisition` delegates to recruitment (store level) |
| `recruitmentRepository` | Requisitions, pipeline, assignments | `recruitmentClient` → `/api/v1/recruitment` | Same | **Empty shell only** (no mock data file) | Yes | No |
| `taskRepository` | Enterprise task inbox | `taskClient` → `/api/v1/tasks` | Same | Empty shell | Yes | No |
| `interviewRepository` | Interviews, feedback | `interviewClient` → `/api/v1/interviews` | Same | Empty shell | Yes | Legacy `/schedule-interview` bypasses repository |
| `offerRepository` | Offer governance | `offerClient` → `/api/v1/offers` | Same | Empty shell | Yes | No UI consumer |
| `hiringControlTowerRepository` | HCT process mutations (local) + load | `workflowsRepository.getPrimaryHiringProcess()` live; `hiringControlTowerClient` fallback | Local state mutations; workflow API for advance | Yes (full HCT mock) | Partial (workflows only) | **Duplicate** with `workflowsRepository` for process state |
| `notificationsRepository` | Notification settings/channels | Delegates to `platformConfigRepository` in live | Same | Via platform mock | Yes (delegate) | Thin wrapper |
| `auditRepository` | Client-side audit log | `auditClient` (**no backend**) | In-memory append | Returns passed events | **No backend** | Frontend-only; backend writes separate table |

---

## Detailed Notes

### `recruitmentRepository.js`

- **Purpose:** Enterprise recruitment bundle for store and Recruiter Workspace.
- **Reads:** `GET /api/v1/recruitment` → `recruitmentService.getRecruitmentBundle()` → `rm_requisitions`, `rm_recruiter_assignments`, `rm_candidate_mappings`.
- **Writes:** assignRecruiter, mapCandidate, updateCandidateStage, approveRequisition via v1 endpoints.
- **Mock:** Returns empty arrays in both `getInitialState()` branches. When `isMockMode()` and `getAll()` called without data, client mock returns empty bundle.
- **Gap:** No mock recruitment dataset unlike workforce/platform. **Does not read legacy APIs.**

### `taskRepository.js`

- **Purpose:** Enterprise task inbox.
- **Reads:** `GET /api/v1/tasks`, `GET /api/v1/tasks/my`.
- **Writes:** `completeTask`, etc.
- **Mock:** Empty shell.

### `interviewRepository.js`

- **Purpose:** Enterprise interview bundle.
- **Reads:** `GET /api/v1/interviews` → `im_*` tables.
- **Writes:** schedule, feedback, complete via v1 API.
- **Mock:** Empty shell.
- **Gap:** Legacy Interview Schedule page uses axios to `/schedule-interview`, not this repository.

### `hiringControlTowerRepository.js`

- **Purpose:** Hiring Control Tower process state (stages, timeline, budget panels).
- **Live load:** Primary path is `workflowsRepository.getPrimaryHiringProcess()` from workflow instance.
- **Fallback:** `hiringControlTowerClient.getAll()` → `/api/v1/hiring-control-tower` — **endpoint not registered in backend**.
- **Mutations:** Many methods update local state only (`updateStageStatus`, `appendTimeline`); approve/clarification call workflow client in live mode.
- **Duplication:** Process shape mirrors `hiringControlTower.mock.js`; overlaps workflows instance payload.

### `workflowsRepository.js`

- **Purpose:** Workflow definitions, instances, import/export, HCT primary instance extraction.
- **Live:** `/api/v1/workflows` → `wf_*` tables.
- **Mock:** Uses platform config mock + HCT mock for hiring process.
- **Duplication:** Absorbs HCT data loading responsibility from `hiringControlTowerRepository`.

### `workforcePlanningRepository.js`

- **Purpose:** Workforce planning bundle.
- **Live/Mock:** Full mock in mock mode; live API in live mode.
- **Note:** Store `createRequisition` calls recruitment through workforce bridge — cross-repository orchestration in store, not repository.

### `platformConfigRepository.js`

- **Purpose:** Platform configuration with dirty/baseline tracking.
- **Live/Mock:** Rich mock in mock mode; PostgreSQL in live mode.
- **Used by:** Platform config UI, `moduleVisibility.js`, Admin menu filtering.

### `auditRepository.js`

- **Purpose:** Append-only client audit for UI.
- **Reads:** `auditClient.getAll()` — mock returns current in-memory array.
- **Writes:** `create()` appends to store array only.
- **Critical gap:** Does not read `md_enterprise_audit`. Backend audit is write-only.

### `offerRepository.js`

- **Purpose:** Offer governance CRUD lifecycle.
- **Consumers:** `enterpriseStore` actions only — no page-level hook.
- **Mock:** Empty shell.

### `notificationsRepository.js`

- **Purpose:** Thin delegation for notification channel/settings mutations.
- **Live:** Delegates to `platformConfigRepository`.
- **No standalone backend** — notifications are part of platform config tables.

---

## Repositories Without Legacy Equivalents

Enterprise repositories have **no legacy repository layer**. Legacy pages call `axios` directly (`src/api/axios.jsx`), bypassing the repository pattern entirely.

---

## Mock vs Live Behavior Matrix

| Repository | Mock data source | Live bootstrap loads? |
|------------|------------------|----------------------|
| platformConfig | `platformConfig.mock.js` | Yes |
| businessRules | `businessRules.mock.js` | Yes |
| workflows | platform + HCT mocks | Yes |
| workforce | `workforcePlanning.mock.js` | Yes |
| masterData | `masterData.mock.js` | Yes |
| recruitment | **Empty** | Yes (but DB may differ from legacy) |
| taskInbox | **Empty** | Yes |
| interviews | **Empty** | Yes |
| offers | **Empty** | Yes |
| hiringProcess | HCT mock / workflow instance | Yes |
| auditEvents | `[]` initially | **No API load** |

**Default:** `VITE_API_MODE=mock` → bootstrap in `main.jsx` **does not run** → enterprise store stays at initial mock/empty state for recruitment/tasks/interviews.
