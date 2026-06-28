# Sprint 9.2 — Enterprise Business Flow Conformance Audit

**Type:** Analysis only — no code, schema, or UI changes  
**Date:** 2026-06-27  
**Scope:** All operational ATS screens vs accepted Enterprise Architecture

---

## Executive Answer

**Does every operational screen faithfully implement the original ATS business process using the Enterprise Architecture beneath it?**

**No.** The platform operates as a **dual-stack system**:

- **Enterprise path:** Recruiter Workspace, Hiring Control Tower (live), enterprise API mutations that route through services, and cutover-aware reads for some legacy endpoints.
- **Legacy path:** Most original ATS screens (Requisition, Candidate, Interview Schedule, Interview Feedback) still use direct axios to inline SQL or legacy tables for **reads**, while **writes** often go through enterprise services with optional legacy dual-write.

Recruiter assignment is the clearest example: **Assign/Remove write enterprise SoR** (`rm_recruiter_assignments`), but the **Assigned Recruiters list reads legacy only** (`req_recruiter_map`). Recruiter Workspace KPIs read **enterprise only** (`rm_*` via my-dashboard). The same business action therefore presents different counts on different screens until refresh and even then list vs KPI sources diverge when dual-write is off.

---

## Accepted Enterprise System of Record (Reference)

| Entity | Enterprise SoR | Legacy (deprecated) |
|--------|----------------|---------------------|
| Requisition | `rm_requisitions` | `req_mstr` |
| Recruiter assignment | `rm_recruiter_assignments` | `req_recruiter_map` |
| Candidate pipeline | `rm_candidate_mappings` | `candidate_req_map` |
| Interview | `im_interviews` | `interview_schedule_trn` |
| Feedback | `im_feedback` | `interview_feedback_hdr/dtl` |
| Candidate master | `cand_mstr` (shared, intentional) | — |
| Workflow | `wf_*` | — |
| Tasks | `et_*` | — |
| Offers | `om_*` | — |
| Audit | `md_enterprise_audit` | — |

---

## Cross-Cutting Inconsistency Matrix

| Pattern | Where it occurs | Impact |
|---------|-----------------|--------|
| **Mixed read SoR** | Requisition list (enterprise/legacy via adapter) vs assigned recruiters list (legacy only) vs Recruiter Workspace (enterprise only) | Same recruiter sees different assignment counts |
| **Mixed write SoR** | `POST /map-existing-candidate` → legacy only; `POST /candidate-req-map` → enterprise + dual-write | Pipeline split across tables |
| **Write via service, read inline SQL** | Assign/remove recruiter (service) vs GET assigned-recruiters (inline) | Dialog list stale vs enterprise truth |
| **Enterprise service write, legacy-only read** | Schedule/feedback submit → `im_*`; view feedback → `interview_feedback_hdr` | Submitted feedback invisible on view path if legacy dual-write off |
| **Parallel API stacks** | Legacy pages vs `/api/v1/*` enterprise clients | Same domain, two HTTP surfaces |
| **No repository on legacy pages** | RequisitionPage, CandidatePage, Interview* | Bypass enterprise store; no shared cache/refresh |
| **Duplicate validations** | `assignRecruiter` checks `rm_recruiter_assignments`; assigned list reads `req_recruiter_map` | Duplicate assignment possible in UI list vs enterprise block |
| **Orphan enterprise UI** | Offer bundle in store; no Offer page route | Backend ready; no operational screen |
| **Orphan legacy UI** | `RecruiterDashboard.jsx` (UITestPage only) | Legacy `/recruiter-dashboard` KPIs unused in production route |

---

# 1. Requisition Management

**Screen:** `RequisitionPage.jsx` → `/requisitions`  
**Stack:** Direct axios — **no** store, **no** repository

| Action | API | Service | Tables READ | Tables WRITE | SoR |
|--------|-----|---------|-------------|--------------|-----|
| Load grid | `GET /requisitions` | `legacyOperationalAdapter` | `rm_requisitions` OR `req_mstr` | — | Cutover-aware |
| Load clients/projects/HM | `GET /clients`, `/projects/:id`, `/hiring-managers/:id` | Inline | `client_mstr`, `project_mstr`, `hiring_manager_mstr` | — | Legacy master |
| Load recruiters dropdown | `GET /recruiters` | Inline | `user_mstr` | — | Legacy master |
| **Create Requisition** | `POST /requisition` | `recruitmentService.handleLegacyCreateRequisition` | `wp_approved_positions`, `rm_requisitions` | `rm_requisitions`, optional `req_mstr`, `wf_*`, `md_enterprise_audit` | Enterprise write (broken UI: missing `approved_position_id`) |
| **Manage → open dialog** | `GET /assigned-recruiters/:reqId` | Inline SQL | `req_recruiter_map`, `user_mstr` | — | **Legacy read only** |
| **Assign Recruiter** | `POST /assign-recruiter` | `recruitmentService.assignRecruiter` | `rm_requisitions`, `rm_recruiter_assignments` | `rm_recruiter_assignments`; optional `req_recruiter_map`; `wf_*`; audit | Enterprise + optional dual-write |
| **Remove Recruiter** | `DELETE /remove-recruiter/:mapId` | `recruitmentService.removeRecruiterAssignment` | Both tables via resolver | `rm_recruiter_assignments` deactivate; optional `req_recruiter_map`; audit | Enterprise + optional dual-write |
| Update requisition | `PUT /requisition/:id` | Inline SQL | `req_mstr` | `req_mstr` | **Legacy only — must migrate** |

### Requisition grid KPIs / columns

| Element | Source | Filter |
|---------|--------|--------|
| Grid rows | `GET /requisitions` response | None |
| Status display | `req_status` field | None |

---

# 2. Recruiter Assignment Dialog (Detailed)

## Sequence: Open → Assign → Remove → Close

```
User: Click "Manage" on requisition row
  → RequisitionPage: setSelectedReqId, setShowAssignModal(true)
  → GET /assigned-recruiters/:reqId
  → SQL: req_recruiter_map JOIN user_mstr WHERE req_id=$1 AND is_active=true
  → Populates assignedRecruiters[] (legacy map_id keys)

User: Select recruiter from dropdown (data from GET /recruiters → user_mstr)

User: Click "Assign Recruiter"
  → POST /assign-recruiter { req_id, recruiter_code }
  → recruitmentLegacyHandlers → recruitmentService.assignRecruiter
  → Duplicate check: rm_recruiter_assignments (enterprise)
  → WRITE: rm_recruiter_assignments INSERT
  → WRITE (if LEGACY_DUAL_WRITE): req_recruiter_map INSERT
  → WRITE: md_enterprise_audit, wf advance
  → GET /assigned-recruiters/:reqId (refresh list — still legacy read)
  → Does NOT call refreshRecruitment() / enterprise store

User: Click "Remove"
  → DELETE /remove-recruiter/:mapId  (legacy map_id)
  → recruitmentService.removeRecruiterAssignment
  → Resolve: map_id → req_recruiter_map → (req_id, recruiter_code) → rm_recruiter_assignments
  → WRITE: rm_recruiter_assignments is_active=false
  → WRITE (if LEGACY_DUAL_WRITE): req_recruiter_map is_active=false
  → GET /assigned-recruiters/:reqId refresh
  → Does NOT update Recruiter Workspace store

User: Click "Close"
  → Local state only
```

## Explicit answers (Assign Recruiter popup)

| Question | Answer |
|----------|--------|
| Which table populates **Assigned Recruiters list**? | **`req_recruiter_map`** (+ `user_mstr` for names) — legacy only |
| Which table **validates duplicate** assignment? | **`rm_recruiter_assignments`** (enterprise) in `assignRecruiter()` |
| Which table **Remove updates**? | **`rm_recruiter_assignments`** (primary); **`req_recruiter_map`** if dual-write |
| Which table **Recruiter Workspace KPIs** read? | **`rm_recruiter_assignments`**, **`rm_requisitions`** via `GET /api/v1/recruitment/my-dashboard` |
| Same SoR for all actions? | **No** — list reads legacy; assign/remove/KPI write-read enterprise |

---

# 3. Candidate Management

**Screen:** `CandidatePage.jsx` → `/candidates`  
**Stack:** Direct axios — **no** store, **no** repository

| Action | API | Service | Tables READ | Tables WRITE | SoR |
|--------|-----|---------|-------------|--------------|-----|
| Load candidates (Recruiter) | `GET /my-candidates-list` | Inline | `cand_mstr`, `candidate_req_map`, `req_mstr` | — | Legacy |
| Load candidates (Admin) | `GET /candidates` | Inline | `cand_mstr` | — | Shared master |
| Load requisitions dropdown | `GET /my-requisitions` or `/requisitions` | Adapter or legacy handlers | Enterprise OR legacy | — | Mixed |
| **Pipeline dashboard** | `GET /pipeline-details` | Inline | `candidate_req_map`, `cand_mstr`, `req_mstr` | — | **Legacy only** |
| **Save Candidate (create)** | `POST /candidate` | Inline | `cand_mstr` | `cand_mstr`, MinIO | Shared master |
| Map on create | `POST /candidate-req-map` | `recruitmentService.mapCandidate` | `rm_requisitions`, optional legacy dup check | `rm_candidate_mappings`, optional `candidate_req_map`, `wf_*`, audit | Enterprise + dual-write |
| **Update candidate** | `PUT /candidate/:id` | Inline | `cand_mstr` | `cand_mstr` | Shared master |
| **Map existing (edit, new)** | `POST /map-existing-candidate` | Inline | `candidate_req_map` | **`candidate_req_map` only** | **Legacy bypass — no service** |
| **Update stage (edit/pipeline)** | `PUT /update-ats-stage/:mapId` | `recruitmentService.updateCandidateStage` | `rm_candidate_mappings`, legacy map | Enterprise + optional legacy + `cand_mstr` | Enterprise + dual-write |
| Edit load | `GET /candidate-full-details/:id` | Inline | `cand_mstr`, `candidate_req_map` | — | Legacy |
| Search | Client filter | — | — | — | — |

### Pipeline dashboard KPIs

| Element | API | SQL tables | Filter |
|---------|-----|------------|--------|
| Stage counts / rows | `GET /pipeline-details` | `candidate_req_map` JOIN `cand_mstr` JOIN `req_mstr` | Recruiter: `recruiter_id = employee_code` |

**Inconsistency:** Pipeline reads **`candidate_req_map`**; Recruiter Workspace pipeline reads **`rm_candidate_mappings`**. Counts diverge when dual-write off or migration drift.

---

# 4. Interview Scheduling

**Screen:** `InterviewSchedulePage.jsx` → `/interview-schedule`  
**Stack:** Direct axios — **no** `interviewRepository`

| Action | API | Service | Tables READ | Tables WRITE | SoR |
|--------|-----|---------|-------------|--------------|-----|
| Load requisitions | `GET /my-requisitions` | Adapter | Enterprise OR legacy | — | Mixed |
| Load interviewers | `GET /active-interviewers` | Inline | `interview_panel_mstr`, `user_mstr` | — | Legacy master |
| **Schedule grid** | `GET /interview-schedules` | `legacyOperationalAdapter` | Enterprise: `im_interviews`, `rm_*`, `cand_mstr`; Legacy: `interview_schedule_trn`, `candidate_req_map` | — | Cutover-aware read |
| Load candidates by req | `GET /interview-candidates/:reqId` | Inline | **`candidate_req_map`**, `cand_mstr` | — | **Legacy only** |
| **Schedule interview** | `POST /schedule-interview` | `interviewService` + legacy handler | Mixed | **`im_interviews`**, `im_panel_assignments`, `wf_*`, `et_tasks`, audit; optional `interview_schedule_trn`; stage on `rm_candidate_mappings` or legacy | Enterprise write + optional dual-write |
| View feedback link | Navigate | — | — | — | — |

### Schedule grid columns

| Field | Source when enterprise SOR | Source when legacy SOR |
|-------|---------------------------|------------------------|
| Candidate name | `cand_mstr` via `rm_candidate_mappings` | `cand_mstr` via `candidate_req_map` |
| Req code | `rm_requisitions` | `req_mstr` |
| Interviewer | `im_panel_assignments` / legacy `interview_schedule_trn` | `interview_panel_mstr` |

---

# 5. Interview Feedback

**Screens:** `InterviewerHome.jsx`, `InterviewFeedbackPage.jsx`, `ViewFeedback.jsx`

| Action | API | Service | Tables READ | Tables WRITE | SoR |
|--------|-----|---------|-------------|--------------|-----|
| My interviews list | `GET /my-interviews` | Inline (first route) | **`interview_schedule_trn`**, `candidate_req_map`, `interview_feedback_hdr` | — | **Legacy only** |
| Load feedback form | `GET /feedback-details/:scheduleId` | Inline | **`interview_schedule_trn`**, legacy joins | — | Legacy |
| **Submit feedback** | `POST /submit-feedback` | `interviewService.submitFeedback` | `im_interviews`, rules | **`im_feedback`**, `im_interviews`, `wf_*`, `et_tasks`, audit; optional legacy hdr/dtl + `interview_schedule_trn` + stage on `rm_candidate_mappings` or legacy | Enterprise + optional dual-write |
| **View feedback** | `GET /feedback/:scheduleId` | Inline | **`interview_feedback_hdr/dtl`**, legacy joins | — | **Legacy only — does not read `im_feedback`** |

**Critical inconsistency:** Submit path writes **`im_feedback`**; view path reads **`interview_feedback_hdr`**. With `LEGACY_DUAL_WRITE=false`, view may show no data for enterprise-only feedback.

---

# 6. Hiring Control Tower

**Screen:** `HiringControlTowerPage.jsx` → `/hiring-control-tower`  
**Stack:** Enterprise — `useHiringControlTower` → `enterpriseStore` → repositories

| Action | Store action | API | Service | Tables READ | Tables WRITE |
|--------|--------------|-----|---------|-------------|--------------|
| Initial load (live) | `bootstrapEnterpriseData` | `GET /api/v1/workflows` | `workflowService` bundle | `wf_config_state`, `wf_instances` | — |
| Select stage | `setSelectedStageKey` | — | — | — | — |
| Approve / Reject | `approveHiringStage` | `POST /api/v1/workflows/instances/:id/advance` | `workflowService.advanceWorkflow` | `br_*` eval | `wf_instances`, `wf_history`, `md_enterprise_audit` |
| Request clarification | `sendClarification` | `POST .../request-clarification` | `workflowService` | — | `wf_*`, audit |
| Submit clarification | `submitClarification` | `POST .../submit-clarification` | `workflowService` | — | `wf_*`, audit |

### HCT KPIs / panels

| Element | Source | API | Filter |
|---------|--------|-----|--------|
| KPI slab | `buildHiringControlTowerData` selector | Merged from store (`hiringProcess`, workforce, rules) | Client-side stage selection |
| Timeline | `hiringProcess.stages` | `GET /api/v1/workflows` | — |
| Budget panel | Workforce slice + instance payload | Bootstrap bundles | — |
| Activity | In-memory `auditEvents` | Session `publishAudit` only | Not `md_enterprise_audit` DB read |

**Gap:** `GET /api/v1/hiring-control-tower` defined in client but **not registered** on backend; live mode uses workflows bundle fallback.

**Conformance:** HCT is the most enterprise-faithful operational screen for its domain (`wf_*` SoR). It does not surface recruitment/interview operational entities directly.

---

# 7. Recruiter Workspace

**Screen:** `RecruiterWorkspacePage.jsx` → `/recruiter`  
**Stack:** Enterprise — `useRecruiterWorkspace` → `enterpriseStore` → `recruitmentRepository`

| Layer | Detail |
|-------|--------|
| Hook | `useRecruiterWorkspace.js` |
| Store actions | `refreshRecruitment`, `completeTask`, `setRecruiterUi` |
| Repository | `recruitmentRepository.getRecruiterWorkspaceBundle()` |
| API | **`GET /api/v1/recruitment/my-dashboard`** |
| Service | `recruitmentService.getMyRecruiterDashboard` — filters by JWT `employee_code` |

### KPI trace

| KPI | Selector field | SQL origin (via my-dashboard) |
|-----|----------------|-------------------------------|
| My Requisitions | `requisitions.length` | `rm_requisitions` JOIN `rm_recruiter_assignments` WHERE recruiter_code = JWT |
| My Candidates | `pipeline.length` | `rm_candidate_mappings` JOIN assignments on requisition |
| Interviews Today | `interviews` filtered by date | `im_interviews` JOIN assignments |
| Pending Actions | `tasks` status Pending | `et_tasks` linked to recruiter requisitions |

### Actions

| Action | API | Tables |
|--------|-----|--------|
| Refresh | `GET /api/v1/recruitment/my-dashboard` | All above |
| Complete task | `POST /api/v1/tasks/:id/complete` + `GET /api/v1/tasks` | `et_tasks` (note: refetch is **global** tasks, not recruiter-scoped dashboard filter) |
| Search / tab / inspector | Client only | — |

**Conformance:** Recruiter Workspace is **enterprise-faithful for reads** within recruitment/interview/task scope. It is **not notified** when legacy RequisitionPage mutates assignments. Activity timeline is **not** loaded from `md_enterprise_audit`.

---

# 8. Offer Management

**Operational screen:** **None routed in production** (`App.jsx` has no `/offers` page; Home menu item is non-navigating).

| Layer | Status |
|-------|--------|
| Backend API | Complete — `GET/POST /api/v1/offers/*` → `offerManagementService` → `om_*` |
| Repository / store | `offerRepository`, `enterpriseStore` actions wired |
| UI actions | **No user-facing grid or forms** |

**Conformance:** Backend implements enterprise SoR; **business process has no operational UI** to execute it.

---

# 9. Multiple Systems of Record (Active Duplicates)

| Entity | Enterprise rows (typical dev) | Legacy rows | Dual-write on mutate | Read split |
|--------|------------------------------|-------------|----------------------|------------|
| Requisitions | `rm_requisitions` | `req_mstr` | Create (optional), approve (optional) | Adapter vs inline |
| Assignments | `rm_recruiter_assignments` | `req_recruiter_map` | Assign/remove (optional) | **List legacy / KPI enterprise** |
| Pipeline | `rm_candidate_mappings` | `candidate_req_map` | Map/stage (optional); map-existing **legacy only** | Pipeline legacy / workspace enterprise |
| Interviews | `im_interviews` | `interview_schedule_trn` | Schedule (optional) | Adapter vs inline |
| Feedback | `im_feedback` | `interview_feedback_hdr/dtl` | Submit (optional) | **View legacy only** |

---

# 10. Legacy Endpoints Still Bypassing Enterprise Services

| Endpoint | Bypass type |
|----------|-------------|
| `GET /assigned-recruiters/:reqId` | Inline SQL — no service |
| `GET /pipeline-details` | Inline SQL — no service |
| `GET /my-candidates-list` | Inline SQL — no service |
| `GET /interview-candidates/:reqId` | Inline SQL — no service |
| `GET /my-interviews` | Inline SQL — no service |
| `GET /feedback-details/:scheduleId` | Inline SQL — no service |
| `GET /feedback/:scheduleId` | Inline SQL — no service |
| `POST /map-existing-candidate` | Inline INSERT — **no recruitmentService** |
| `PUT /requisition/:id` | Inline UPDATE — **no recruitmentService** |
| `POST /candidate`, `PUT /candidate/:id` | Inline — intentional for `cand_mstr` master |

---

# 11. Orphan / Unused Artifacts

| Artifact | Status |
|----------|--------|
| `RecruiterDashboard.jsx` | Legacy KPI UI; only mounted in `UITestPage`; production login routes to `/recruiter` |
| `GET /api/v1/hiring-control-tower` | Client endpoint with no backend route |
| Duplicate `GET /my-requisitions` in `index.js` | Second registration dead (Express first-match) |
| Duplicate `GET /my-interviews` in `index.js` | Second registration dead |
| Enterprise `interviewRepository` / `recruitmentRepository.getAll()` (admin bundle) | Not used by legacy ATS pages |

---

# 12. Final Conformance Verdict by Screen

| Screen | Enterprise-faithful? | Primary inconsistency |
|--------|---------------------|------------------------|
| Requisition Management | **Partial** | Assigned list legacy read; create broken; PUT legacy-only |
| Candidate Management | **Partial** | Pipeline/candidate list legacy read; map-existing legacy-only write |
| Recruiter Assignment (dialog) | **Partial** | Write enterprise; list legacy; no workspace refresh |
| Interview Scheduling | **Partial** | Schedule write enterprise; candidates dropdown legacy read |
| Interview Feedback | **Partial** | Submit enterprise; view/list legacy read |
| Hiring Control Tower | **Mostly yes** (workflow domain) | Audit/activity not DB-backed in UI |
| Recruiter Workspace | **Yes** (scoped reads) | Isolated from legacy page mutations; task refetch scope mismatch |
| Offer Management | **N/A (no UI)** | Backend only |

---

## Summary Statement

The Enterprise Architecture is **correctly implemented in services and enterprise APIs**, but **most original ATS screens do not consistently read from the Enterprise System of Record**. They execute a **hybrid business process**: legacy axios pages for UX, enterprise services for many (not all) writes, and cutover-aware reads only where `legacyOperationalAdapter` was wired.

**Mixed legacy and enterprise execution paths remain the norm**, not the exception. Full business-process conformance requires read-path unification and elimination of remaining inline legacy writes — particularly `assigned-recruiters`, `pipeline-details`, `map-existing-candidate`, feedback view, and requisition update.

*This audit identifies inconsistencies only. No fixes are recommended or implemented herein.*
