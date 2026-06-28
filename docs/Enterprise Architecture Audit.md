# OPTALYNX Enterprise Architecture Audit

**Pre-Wave 2 Verification · Analysis Only**  
**Date:** 2026-06-26  
**Scope:** Factual audit of current implementation. No code, schema, or data changes were made.

---

## Executive Summary

The OPTALYNX platform currently operates as **two parallel data architectures** sharing one PostgreSQL database:

1. **Legacy ATS** — operational recruiting data in `req_mstr`, `candidate_req_map`, `req_recruiter_map`, `cand_mstr`, `interview_schedule_trn`, etc., accessed via root-level REST routes in `index.js` and consumed directly by legacy React pages via `axios`.

2. **Enterprise Platform** — governance and lifecycle data in prefixed tables (`md_*`, `pc_*`, `br_*`, `wf_*`, `wp_*`, `rm_*`, `et_*`, `im_*`, `om_*`), accessed via `/api/v1/*` routes, consumed by Repository → Enterprise Store → enterprise workspaces.

**Root cause of Recruiter Workspace showing zeros:** The Recruiter Workspace (Wave 1) reads exclusively from the Enterprise Store → `recruitmentRepository` → `GET /api/v1/recruitment` → `rm_*` tables. Legacy operational data in `req_mstr` / `candidate_req_map` is **not queried** by this path. Additionally, `recruitment.seed.json` seeds only one requisition and one recruiter assignment — **no candidate mappings**. Legacy pages (`/candidates`, `/requisitions`, `/recruiter-dashboard`) continue to read legacy tables and can show data while the enterprise workspace shows none.

Dual-write exists for **new** mutations routed through legacy handlers (`recruitmentLegacyHandlers`, `interviewLegacyHandlers`) into enterprise services, but **historical legacy-only records are not backfilled** into enterprise tables.

---

## Section 1 — Complete Database Inventory

See **[Database Mapping Report.md](./Database%20Mapping%20Report.md)** for the full table inventory (legacy + enterprise), legacy↔enterprise mapping, and duplicate entity analysis.

**Summary counts (from codebase inspection):**

| Category | Table count (approx.) | Defined in |
|----------|----------------------|------------|
| Legacy ATS | 14+ | Pre-existing schema (not in `migrations/`) |
| Enterprise Master Data | 4 | `001_master_data_schema.sql` |
| Platform Configuration | 10 | `002_platform_config_schema.sql` |
| Business Rules | 12 | `003_business_rules_schema.sql` |
| Workflow Engine | 13 | `004_workflow_engine_schema.sql` |
| Workforce Planning | 9 | `005_workforce_planning_schema.sql` |
| Recruitment Management | 5 | `006_recruitment_management_schema.sql` |
| Interview + Task Inbox | 6 | `007_interview_task_inbox_schema.sql` |
| Offer Management | 8 | `008_offer_management_schema.sql` |

---

## Section 2 — Legacy vs Enterprise Mapping

See **Database Mapping Report.md §2 and §4**.

**Pattern observed in `recruitmentService.js` and `interviewService.js`:**

| Legacy | Enterprise | Dual-write on mutation? | Dual-read on query? |
|--------|------------|-------------------------|---------------------|
| `req_mstr` | `rm_requisitions` | Yes (create from approved position; status sync on approve) | No — separate read paths |
| `req_recruiter_map` | `rm_recruiter_assignments` | Yes (via `assignRecruiter`) | No |
| `candidate_req_map` | `rm_candidate_mappings` | Yes (via `mapCandidate`, `updateCandidateStage`) | No |
| `interview_schedule_trn` | `im_interviews` | Partial (schedule via legacy handler writes both; reads split) | No |
| `interview_feedback_hdr/dtl` | `im_feedback` | Partial (legacy submit-feedback path) | No |

Neither table in a pair is marked deprecated in code. Both remain active for different API surfaces.

---

## Section 3 — System of Record

| Entity | Current SoR (intended enterprise) | Legacy parallel SoR | Repository | API | DB table(s) |
|--------|-----------------------------------|---------------------|------------|-----|-------------|
| Approved Position | Enterprise | — | `workforcePlanningRepository` | `GET /api/v1/workforce` | `wp_approved_positions` |
| Requisition (governance) | Enterprise | Legacy ATS ops | `recruitmentRepository` | `GET /api/v1/recruitment` | `rm_requisitions` |
| Requisition (operations) | **Legacy** (de facto for ATS UI) | — | None (direct axios) | `GET /requisitions`, `/my-requisitions` | `req_mstr` |
| Candidate | **Legacy** | — | None | `GET /candidates` | `cand_mstr` |
| Recruiter Assignment | Enterprise + Legacy | Both active | `recruitmentRepository` / none | `/api/v1/recruitment/.../assign-recruiter` vs `/assign-recruiter` | `rm_recruiter_assignments`, `req_recruiter_map` |
| Candidate Mapping / Pipeline | Enterprise + Legacy | Both active | `recruitmentRepository` / none | `/api/v1/recruitment/candidate-mappings` vs `/candidate-req-map` | `rm_candidate_mappings`, `candidate_req_map` |
| Interview (enterprise) | Enterprise | Legacy | `interviewRepository` | `GET /api/v1/interviews` | `im_interviews` |
| Interview (operations) | **Legacy** | — | None | `/interview-schedules`, `/my-interviews` | `interview_schedule_trn` |
| Interview Feedback | Legacy + Enterprise | Both | `interviewRepository` (enterprise path) | `/submit-feedback`, `/api/v1/interviews/:id/feedback` | `interview_feedback_*`, `im_feedback` |
| Offer | Enterprise | — | `offerRepository` | `GET /api/v1/offers` | `om_offers` (+ related `om_*`) |
| Task (inbox) | Enterprise | — | `taskRepository` | `GET /api/v1/tasks` | `et_tasks` |
| Workflow (runtime) | Enterprise | — | `workflowsRepository` | `GET /api/v1/workflows` | `wf_instances`, `wf_history`, etc. |
| Workflow (config UI) | Enterprise | — | `workflowsRepository`, `workflowConfigurationRepository` | `/api/v1/workflows`, platform config | `wf_definitions`, `pc_workflows` |
| Business Rule | Enterprise | — | `businessRulesRepository` | `GET /api/v1/business-rules` | `br_rules`, etc. |
| Notification (config) | Enterprise | — | `notificationsRepository` → platform config | `/api/v1/platform-config` | `pc_notification_*` |
| Notification (delivery) | Not persisted | — | — | — | Rules/workflow return notification *names* only |
| Audit (backend persistence) | Enterprise DB | — | `enterpriseAuditService` (backend only) | **No REST API** | `md_enterprise_audit` |
| Audit (frontend) | In-memory store | — | `auditRepository` | `ENDPOINTS.audit` (**no backend route**) | None (client-side append) |
| Master Data | Enterprise | Legacy masters pages | `masterDataRepository` | `GET /api/v1/master` | `md_records` |
| Platform Configuration | Enterprise | — | `platformConfigRepository` | `GET /api/v1/platform-config` | `pc_*` |
| Hiring Control Tower (UI process) | Workflow instance + mock fallback | — | `hiringControlTowerRepository`, `workflowsRepository` | **No `/api/v1/hiring-control-tower` backend** | `wf_instances` (partial) |
| User / Auth | Legacy | — | None | `/login`, `/users` | `user_mstr` |
| Client / Project / HM masters | Legacy | — | None | `/clients`, `/projects`, etc. | `client_mstr`, `project_mstr`, `hiring_manager_mstr` |

---

## Section 4 — Workspace Data Flow

See **[Current Data Flow Diagrams.md](./Current%20Data%20Flow%20Diagrams.md)**.

---

## Section 5 — API Inventory

See **[API Inventory.md](./API%20Inventory.md)**.

---

## Section 6 — Repository Audit

See **[Repository Audit.md](./Repository%20Audit.md)**.

---

## Section 7 — Enterprise Store Audit

**File:** `ats-frontend/src/store/enterpriseStore.js`  
**Bootstrap:** `enterprise/bootstrap.js` (runs only when `VITE_API_MODE=live`)

| Slice | Purpose | Repository | Primary entities | DB source | Frontend consumers |
|-------|---------|------------|------------------|-----------|-------------------|
| `platformConfig` | Module toggles, roles, budget, notifications, AI | `platformConfigRepository` | modules, workflows, role_visibility | `pc_*` | Platform Configuration pages, `moduleVisibility.js`, Admin home menu |
| `businessRules` | Rule library, simulator | `businessRulesRepository` | rules, categories, matrix | `br_*` | Business Rules pages |
| `workflows` | Workflow definitions + instances | `workflowsRepository` | definitions, instances | `wf_*` | Workflows config, HCT (via primary instance) |
| `workforce` | Budget requests, approved positions | `workforcePlanningRepository` | budget_requests, approved_positions | `wp_*` | Workforce Planning pages |
| `recruitment` | Requisitions, assignments, pipeline | `recruitmentRepository` | requisitions, pipeline | `rm_*` | Enterprise Store actions, **Recruiter Workspace** |
| `taskInbox` | Enterprise tasks | `taskRepository` | tasks | `et_tasks` | Recruiter Workspace, store `completeTask` |
| `interviews` | Interview records | `interviewRepository` | interviews | `im_*` | Recruiter Workspace, store schedule/feedback |
| `offers` | Offer governance | `offerRepository` | offers | `om_*` | Store actions only — **no dedicated UI page** |
| `hiringProcess` | HCT process state | `hiringControlTowerRepository`, `workflowsRepository` | stages, timeline, budget | `wf_instances` + mock shape | Hiring Control Tower page |
| `masterData` | Reference data | `masterDataRepository` | grades, bands, etc. | `md_records` | Master Data page |
| `auditEvents` | Client-side audit log | `auditRepository` | events | **Not loaded from DB** | Audit hooks, activity displays |
| `workforceUi` | Selection, toast | — | UI state | — | Workforce pages |
| `hiringTowerUi` | Stage selection, clarification | — | UI state | — | HCT page |
| `businessRulesUi` | Draft rule, simulator | — | UI state | — | Business Rules pages |
| `masterDataUi` | Drawer, filters | — | UI state | — | Master Data page |
| `recruiterUi` | Search, inspector, tabs | — | UI state | — | Recruiter Workspace |

**UI-only slices do not touch repositories directly.**

---

## Section 8 — Current UI Data Source Verification

| Screen | Component | Hook / pattern | Repository | API | Database table |
|--------|-----------|----------------|------------|-----|----------------|
| **Recruiter Workspace** | `RecruiterWorkspacePage` | `useRecruiterWorkspace` | `recruitmentRepository`, `taskRepository`, `interviewRepository` | `/api/v1/recruitment`, `/api/v1/tasks`, `/api/v1/interviews` | `rm_*`, `et_tasks`, `im_interviews` |
| Recruiter Dashboard (legacy, unused as landing) | `RecruiterDashboard` | direct `useEffect` + axios | **None** | `/recruiter-dashboard`, `/my-requisitions` | `req_recruiter_map`, `candidate_req_map`, `req_mstr` |
| **Candidate Management** | `CandidatePage` | direct axios | **None** | `/candidates`, `/candidate-req-map`, `/update-ats-stage/:mapId` | `cand_mstr`, `candidate_req_map` |
| **Requisition Management** | `RequisitionPage` | direct axios | **None** | `/requisitions`, `/requisition`, `/assign-recruiter` | `req_mstr`, `req_recruiter_map` |
| **Interview Schedule** | `InterviewSchedulePage` | direct axios | **None** | `/interview-schedules`, `/schedule-interview` | `interview_schedule_trn`, `candidate_req_map` |
| **Interview Feedback** | `InterviewFeedbackPage` | direct axios | **None** | `/submit-feedback` | `interview_feedback_hdr/dtl` |
| **Interviewer Home** | `InterviewerHome` | direct axios | **None** | `/my-interviews` | `interview_schedule_trn` |
| **Hiring Control Tower** | `HiringControlTowerPage` | `useHiringControlTower` | `hiringControlTowerRepository`, `workflowsRepository` | `/api/v1/workflows` (live); HCT endpoint **missing** | `wf_instances` (partial); mock fallback |
| **Workforce Planning** | Workforce pages | `useWorkforcePlanning` | `workforcePlanningRepository` | `/api/v1/workforce` | `wp_*` |
| **Business Rules** | Business Rules pages | `useBusinessRules` | `businessRulesRepository` | `/api/v1/business-rules` | `br_*` |
| **Platform Configuration** | Platform config pages | `usePlatformConfig` | `platformConfigRepository` | `/api/v1/platform-config` | `pc_*` |
| **Master Data** | `MasterDataPage` | `useMasterData` | `masterDataRepository` | `/api/v1/master` | `md_records` |
| **Offer Management** | **No UI screen** | Store actions only | `offerRepository` | `/api/v1/offers` | `om_*` |
| Admin Home (legacy) | `AdminHomeLegacy` | partial store for menu | `platformConfig` (menu only) | Mixed legacy + links to enterprise routes | Mixed |
| User Management | `UserManagementPage` | axios | None | `/users` | `user_mstr` |
| Master Management (legacy) | `MasterManagementPage` | axios | None | `/clients`, `/projects`, etc. | Legacy master tables |

---

## Section 9 — Duplicate Data Detection

See **Database Mapping Report.md §4** for entity-by-entity analysis.

**Critical duplicates:**

| Entity | Locations | Should both exist? |
|--------|-----------|-------------------|
| Requisition | `req_mstr`, `rm_requisitions` | **No** for single SoR — currently both active; enterprise intended SoR but legacy holds operational history |
| Recruiter assignment | `req_recruiter_map`, `rm_recruiter_assignments` | **No** — dual-write on new assigns only |
| Candidate pipeline | `candidate_req_map`, `rm_candidate_mappings` | **No** — dual-write on new maps only |
| Interview | `interview_schedule_trn`, `im_interviews` | **No** — partial sync |
| Feedback | `interview_feedback_*`, `im_feedback` | **No** |
| Workflow tasks | `wf_tasks`, `et_tasks` | **Yes, different purposes** — workflow engine vs enterprise inbox (risk: confusion) |
| Workflow config | `pc_workflows`, `wf_definitions` | **Overlapping** — platform toggles vs engine definitions |
| Audit | `md_enterprise_audit` (DB), `auditEvents` (frontend memory) | **No** — not synchronized; no read API |
| Candidates | `cand_mstr` only in legacy | Enterprise mappings reference `candidate_id` but no `rm_candidates` table |

---

## Section 10 — Integration Status

See **[Production Readiness Assessment.md](./Production%20Readiness%20Assessment.md)**.

---

## Section 11 — Architecture Risks

| Risk | Severity | Evidence |
|------|----------|----------|
| **Parallel System of Record** — Legacy ATS and Enterprise tables hold overlapping entities with no read reconciliation | **Critical** | Recruiter Workspace empty while legacy dashboard populated |
| **No audit read API** — Backend writes `md_enterprise_audit`; frontend never hydrates | **High** | `auditClient` points to non-existent `/api/v1/audit` |
| **No HCT backend API** — Client defines `/api/v1/hiring-control-tower` but no route registered | **High** | `hiringControlTowerClient.js` vs `index.js` route registration |
| **Mock mode default** — `VITE_API_MODE` defaults to `"mock"`; bootstrap skipped | **High** | `api/config.js`, `bootstrap.js` |
| **Recruitment mock empty** — No mock bundle for recruitment (unlike workforce/platform) | **Medium** | `recruitmentRepository.getInitialState()` always empty |
| **Incomplete seed data** — Recruitment seed has 0 pipeline rows | **Medium** | `recruitment.seed.json` |
| **Recruiter filter mismatch** — Workspace filters by `employee_code === recruiter_code`; seed uses `EMP-1042` | **Medium** | `recruiterSelectors.js` |
| **Offer module backend-only** — No UI workspace | **Medium** | No offer pages in `src/pages` |
| **Legacy pages bypass governance** — Direct CRUD on legacy tables without workflow/rules | **High** | `CandidatePage`, `RequisitionPage` |
| **wf_tasks vs et_tasks** — Two task systems | **Medium** | Both created by workflow/recruitment services |
| **Dead code path** — `RecruiterDashboard` still exists but bypassed by `/recruiter` redirect | **Low** | `Home.jsx`, `RecruiterDashboard.jsx` |
| **Circular dependency risk** — Workforce `createRequisition` delegates to recruitment service | **Low** | Documented integration |

---

## Section 12 — Recommendations

| Issue | Priority | Recommendation |
|-------|----------|----------------|
| Dual SoR for requisitions, candidates, interviews | **Critical** | **Synchronize** — Backfill `rm_*` / `im_*` from legacy OR **Replace** legacy read paths with enterprise APIs; designate enterprise tables as sole SoR |
| Recruiter Workspace reads wrong dataset | **Critical** | **Refactor** frontend to consume unified SoR; interim: enrich workspace from legacy APIs (not recommended long-term) |
| No `/api/v1/audit` | **High** | **Keep** DB table; **Merge** read path via new audit REST route + bootstrap hydration |
| Missing HCT API | **High** | **Replace** mock fallback with workflow instance API or implement HCT route |
| Legacy pages active parallel writes | **High** | **Deprecate** direct legacy mutations; route all writes through enterprise services (handlers exist partially) |
| Mock mode empty recruitment | **Medium** | **Keep** mock mode; add recruitment mock bundle OR document live-only requirement |
| Incomplete seeds | **Medium** | **Synchronize** seeds to include pipeline, tasks aligned with HCT mock |
| Offer UI missing | **Medium** | **Keep** backend; Wave 3 workspace per charter |
| `auditEvents` in-memory only | **High** | **Replace** with DB-backed audit fetch |
| Candidate master only in legacy | **High** | **Merge** — extend enterprise schema or link `rm_candidate_mappings` to `cand_mstr` explicitly in API layer |

**Await approval before any architectural changes.**

---

## Related Documents

1. [Database Mapping Report.md](./Database%20Mapping%20Report.md)
2. [Repository Audit.md](./Repository%20Audit.md)
3. [API Inventory.md](./API%20Inventory.md)
4. [Current Data Flow Diagrams.md](./Current%20Data%20Flow%20Diagrams.md)
5. [Production Readiness Assessment.md](./Production%20Readiness%20Assessment.md)
