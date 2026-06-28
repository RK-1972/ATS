# Sprint 10.1 — Requisition Management Verification & Legacy Elimination

**Type:** Verification only — no feature, UI, or business-rule changes  
**Date:** 2026-06-27  
**Scope:** Requisition Management module (`RequisitionPage`, Recruiter Assignment dialog, enterprise stack)

---

## Enterprise Conformance Certificate

### Verdict: **CONDITIONAL PASS — Not production-certified until one blocking defect is resolved**

| Criterion | Result |
|-----------|--------|
| No direct axios calls in Requisition Management UI | **PASS** |
| No legacy GET endpoints called by Requisition Management | **PASS** |
| No mixed read execution paths in Requisition Management | **PASS** |
| All reads originate from Enterprise repositories → `/api/v1/recruitment/*` | **PASS** |
| All writes originate from Enterprise services | **PASS** (primary SoR `rm_*`; optional legacy dual-write disabled in dev) |
| One operational System of Record for requisition data | **PASS** (`rm_requisitions`, `rm_recruiter_assignments`) |
| Remove Recruiter works end-to-end from UI in live mode | **FAIL** — missing `httpDelete` import in `recruitmentClient.js` |
| Platform-wide legacy route elimination | **N/A this sprint** — legacy root routes remain for other modules |

**Certification statement:** Requisition Management is **enterprise-native at the architecture layer** and is the **reference implementation** for migrating remaining operational modules, **provided** the `httpDelete` import defect is corrected before production cutover. Full **production-ready** certification is withheld until that single-line fix is verified in live UI.

---

## 1. Operation Trace Matrix

Legend: **N/A** = operation not present in current UI (confirmed by static scan of `RequisitionPage.jsx`).

### 1.1 Page lifecycle

| Operation | Component | Hook | Store Action | Repository | API Client | REST Endpoint | Service | Tables READ | Tables WRITE | Enterprise SoR |
|-----------|-----------|------|--------------|------------|------------|---------------|---------|-------------|--------------|----------------|
| **Load page (mount)** | `RequisitionPage` | `useRequisitionManagement` | `loadRequisitionManagementPage` | `listManagementRequisitions`, `listFormClients`, `listFormRecruiters` | `listRequisitions`, `listFormClients`, `listFormRecruiters` | GET `/api/v1/recruitment/requisitions`, GET `.../form-options/clients`, GET `.../form-options/recruiters` | `listRequisitionsForManagement`, `listFormClients`, `listFormRecruiters` | `rm_requisitions`, `client_mstr`, `user_mstr` | — | `rm_requisitions` (+ reference masters) |
| **Browser reload** | Same | `useEffect` → same | Same | Same | Same | Same | Same | Same | — | Same |
| **Implicit refresh after mutation** | Same | — | `createRequisitionFromForm` / `assignRecruiterOnRequisition` / `removeRecruiterFromRequisition` re-fetch | `listManagementRequisitions` or `getAssignedRecruiters` | Same GETs | Same | Same | Same | — | Same |
| **Recruiter Workspace sync after mutation** | — (side effect) | — | `refreshRecruitment` | `getRecruiterWorkspaceBundle` | `getMyDashboard` | GET `/api/v1/recruitment/my-dashboard` | `getMyRecruiterDashboard` | `rm_requisitions`, `rm_recruiter_assignments`, `rm_candidate_mappings`, `im_interviews`, `et_tasks` | — | `rm_*`, `im_*`, `et_*` |

### 1.2 Grid & display

| Operation | Component | Hook | Store Action | Repository | API Client | REST Endpoint | Service | Tables READ | Tables WRITE | Enterprise SoR |
|-----------|-----------|------|--------------|------------|------------|---------------|---------|-------------|--------------|----------------|
| **Load requisition grid** | `RequisitionPage` (table tbody) | `useRequisitionManagement` | `loadRequisitionManagementPage` | `listManagementRequisitions` | `listRequisitions` | GET `/api/v1/recruitment/requisitions` | `listRequisitionsForManagement` | `rm_requisitions` | — | `rm_requisitions` |
| **Grid column: Req Code** | `<td>{req.req_code}</td>` | — | — | — | — | — | UI map from `requisition_code` | — | — | — |
| **Grid column: Client** | `<td>{req.client_name}</td>` | — | — | — | — | — | mapped from `business_unit` / `department` | — | — | — |
| **Grid column: Job Title** | `<td>{req.job_title}</td>` | — | — | — | — | — | mapped from `position_title` | — | — | — |
| **Grid column: Skills** | `<td>{req.primary_skill}</td>` | — | — | — | — | — | — | — | — | — |
| **Grid column: Openings** | `<td>{req.openings_count}</td>` | — | — | — | — | — | mapped from `headcount` | — | — | — |
| **Grid column: Priority** | `<td>{req.priority_level}</td>` | — | — | — | — | — | static map `"High"` | — | — | — |
| **Grid column: Status** | `<td>{req.req_status}</td>` | — | — | — | — | — | — | — | — | `rm_requisitions.req_status` |
| **Grid column: Location** | `<td>{req.work_location}</td>` | — | — | — | — | — | mapped from `location` | — | — | — |
| **Grid column: Recruiters (Manage link)** | `<span onClick={openAssignModal}>` | — | `setRequisitionManagementUi`, `loadAssignedRecruiters` | `getAssignedRecruiters` | `getAssignedRecruiters` | GET `/api/v1/recruitment/requisitions/:reqId/assigned-recruiters` | `getAssignedRecruitersForRequisition` | `rm_requisitions`, `rm_recruiter_assignments`, `user_mstr` | — | `rm_recruiter_assignments` |
| **Search** | — | — | — | — | — | — | — | — | — | **N/A** |
| **Filter** | — | — | — | — | — | — | — | — | — | **N/A** |
| **Sorting (UI control)** | — | — | — | — | — | — | Server default: `ORDER BY req_id DESC, created_on DESC` | — | — | **N/A** (no client sort UI) |
| **KPIs / summary counts** | — | — | — | — | — | — | — | — | — | **N/A** |
| **Badges / status chips** | — | — | — | — | — | — | Plain text in `<td>` only | — | — | **N/A** |

### 1.3 Create requisition form

| Operation | Component | Hook | Store Action | Repository | API Client | REST Endpoint | Service | Tables READ | Tables WRITE | Enterprise SoR |
|-----------|-----------|------|--------------|------------|------------|---------------|---------|-------------|--------------|----------------|
| **Client dropdown load** | `<select name="client_id">` | `useRequisitionManagement` | `loadRequisitionManagementPage` | `listFormClients` | `listFormClients` | GET `/api/v1/recruitment/form-options/clients` | `listFormClients` | `client_mstr` | — | Reference master (not operational SoR) |
| **Project dropdown load** | `<select name="project_id">` | — | `loadRequisitionFormProjects` | `listFormProjects` | `listFormProjects` | GET `.../form-options/projects/:clientId` | `listFormProjectsByClient` | `project_mstr` | — | Reference master |
| **Hiring Manager dropdown load** | `<select name="hiring_manager_id">` | — | `loadRequisitionFormHiringManagers` | `listFormHiringManagers` | `listFormHiringManagers` | GET `.../form-options/hiring-managers/:projectId` | `listFormHiringManagersByProject` | `hiring_manager_mstr` | — | Reference master |
| **Create Requisition button** | `handleCreateRequisition` | — | `createRequisitionFromForm` | `createRequisitionFromForm` | `createRequisitionFromForm` | POST `/api/v1/recruitment/requisitions/legacy-form` | `handleLegacyCreateRequisition` → `createFromApprovedPosition` | `wp_approved_positions`, `rm_requisitions`, rules | `rm_requisitions`, `wf_instances`, `md_enterprise_audit`; optional `req_mstr` if dual-write | `rm_requisitions` |
| **Edit requisition** | — | — | — | — | — | — | — | — | — | **N/A** |
| **View requisition detail** | — | — | — | — | — | — | — | — | — | **N/A** |
| **Delete / Close requisition** | — | — | — | — | — | — | — | — | — | **N/A** |
| **Status change (manual)** | — | — | — | — | — | — | — | — | — | **N/A** |

### 1.4 Recruiter Assignment dialog

| Operation | Component | Hook | Store Action | Repository | API Client | REST Endpoint | Service | Tables READ | Tables WRITE | Enterprise SoR |
|-----------|-----------|------|--------------|------------|------------|---------------|---------|-------------|--------------|----------------|
| **Open dialog (Manage click)** | `openAssignModal` | — | `setRequisitionManagementUi`, `loadAssignedRecruiters` | `getAssignedRecruiters` | `getAssignedRecruiters` | GET `/api/v1/recruitment/requisitions/:reqId/assigned-recruiters` | `getAssignedRecruitersForRequisition` | `rm_requisitions`, `rm_recruiter_assignments`, `user_mstr` | — | `rm_recruiter_assignments` |
| **Recruiter dropdown** | `<select>` in modal | Loaded on page mount | `loadRequisitionManagementPage` | `listFormRecruiters` | `listFormRecruiters` | GET `.../form-options/recruiters` | `listFormRecruiters` | `user_mstr` | — | Reference master |
| **Assigned Recruiters list** | `assignedRecruiters.map` | — | `loadAssignedRecruiters` | `getAssignedRecruiters` | Same GET | Same | Same | `rm_recruiter_assignments`, `user_mstr` | — | `rm_recruiter_assignments` |
| **Assign Recruiter button** | `handleAssignRecruiter` | — | `assignRecruiterOnRequisition` | `assignRecruiterToRequisition` | `assignRecruiterToRequisition` | POST `/api/v1/recruitment/requisitions/:reqId/assign-recruiter` | `assignRecruiter` | `rm_requisitions`, `rm_recruiter_assignments`, `br_*`, `wf_*` | `rm_recruiter_assignments`, `md_enterprise_audit`, `wf_instances`; optional `req_recruiter_map` | `rm_recruiter_assignments` |
| **Remove Recruiter button** | `handleRemoveRecruiter` | — | `removeRecruiterFromRequisition` | `removeRecruiterFromRequisition` | `removeRecruiterAssignment` ⚠️ | DELETE `/api/v1/recruitment/recruiter-assignments/:assignmentId` | `removeRecruiterAssignment` | `rm_recruiter_assignments` | `rm_recruiter_assignments`, `md_enterprise_audit`; optional `req_recruiter_map` | `rm_recruiter_assignments` |
| **Close dialog** | Close button | — | `setRequisitionManagementUi({ showAssignModal: false })` | — | — | — | — | — | — | Client UI only |
| **Duplicate validation** | Server-side on assign | — | — | — | — | — | `assignRecruiter` checks `rm_recruiter_assignments` | `rm_recruiter_assignments` | — | `rm_recruiter_assignments` |

⚠️ **Blocking defect:** `recruitmentClient.js` calls `httpDelete` without importing it from `httpClient.js`. Service-layer remove verified PASS; **UI-layer remove will throw `ReferenceError` in live mode**.

---

## 2. Static Code Scan — Requisition Module

### 2.1 RequisitionPage.jsx

| Pattern | Occurrences | Classification |
|---------|-------------|----------------|
| `axios` | 0 | — |
| `fetch(` | 0 | — |
| Legacy root endpoints (`/requisitions`, `/clients`, etc.) | 0 | — |
| Direct `API` import | 0 | — |
| Enterprise hook only | 1 (`useRequisitionManagement`) | **Valid** |

### 2.2 useRequisitionManagement.js

| Pattern | Occurrences | Classification |
|---------|-------------|----------------|
| `axios` / `fetch` / legacy URLs | 0 | **Valid** — store-only |

### 2.3 recruitmentRepository.js (management methods)

| Pattern | Occurrences | Classification |
|---------|-------------|----------------|
| Direct axios | 0 | **Valid** |
| `recruitmentClient` only | All management methods | **Valid** |

### 2.4 recruitmentClient.js (Requisition Management methods)

| Endpoint fragment | Used by Requisition Management | Classification |
|-------------------|-------------------------------|----------------|
| `/api/v1/recruitment/requisitions` | Grid load | **Valid** (enterprise) |
| `/api/v1/recruitment/requisitions/legacy-form` | Create | **Valid** (enterprise route; name reflects form payload shape, not legacy SoR) |
| `/api/v1/recruitment/form-options/*` | Dropdowns | **Valid** (enterprise) |
| `/api/v1/recruitment/requisitions/:id/assigned-recruiters` | Dialog list | **Valid** (enterprise) |
| `/api/v1/recruitment/requisitions/:id/assign-recruiter` | Assign | **Valid** (enterprise) |
| `/api/v1/recruitment/recruiter-assignments/:id` | Remove | **Valid** (enterprise) — **broken client import** |
| `httpDelete` | Line 47 | **Technical debt / defect** — not imported |

### 2.5 Related files outside RequisitionPage (not part of module execution path)

| File | Legacy reference | Classification |
|------|------------------|----------------|
| `CandidatePage.jsx` | GET `/requisitions`, `/my-requisitions` | **Deprecated** for other modules — not Requisition Management |
| `InterviewSchedulePage.jsx` | GET `/my-requisitions` | **Deprecated** — other module |
| `RecruiterDashboard.jsx` | GET `/recruiter-dashboard` | **Dead code** in production routes (UITestPage only) |
| `index.js` | Root `/requisitions`, `/assigned-recruiters`, etc. | **Deprecated** platform routes — not called by Requisition Management |

### 2.6 Legacy adapters (backend)

| Artifact | Called by Requisition Management? | Classification |
|----------|-----------------------------------|----------------|
| `legacyOperationalAdapter.listLegacyRequisitions` | **No** | **Deprecated** — still used by GET `/requisitions` for other screens |
| `recruitmentLegacyReadHandlers.handleGetAssignedRecruiters` | **No** (page uses `/api/v1/*`) | **Valid delegation** — root route now calls same enterprise service |
| `recruitmentLegacyHandlers` assign/remove/create | **No** | **Deprecated** for Requisition Management; available for other callers |

---

## 3. Legacy Dependency Matrix

| Dependency | Pre-Sprint 10 | Post-Sprint 10 | Post-Sprint 10.1 status |
|------------|---------------|----------------|-------------------------|
| RequisitionPage → axios | Yes | No | **Eliminated** |
| Grid read SoR | Mixed adapter | `rm_requisitions` only | **Enterprise** |
| Assigned list SoR | `req_recruiter_map` | `rm_recruiter_assignments` | **Enterprise** |
| Assign write SoR | Enterprise (+ optional dual-write) | Same | **Enterprise** |
| Remove write SoR | Enterprise (+ optional dual-write) | Same | **Enterprise** |
| Form dropdowns | Inline root routes | Recruitment Service form-options | **Enterprise service** (reference masters) |
| Create route | POST `/requisition` | POST `/api/v1/recruitment/requisitions/legacy-form` | **Enterprise** |
| Workspace KPI sync | Not triggered | `refreshRecruitment()` after mutations | **Enterprise** |
| UI Remove Recruiter | — | Broken `httpDelete` import | **Blocking defect** |

---

## 4. Runtime Verification Report

**Environment:** `ats_dev`, `OPERATIONAL_SOR=enterprise`, `LEGACY_DUAL_WRITE=false`  
**Script:** `ats-backend/scripts/verifySprint101RequisitionManagement.js`

| Step | Action | Result | Notes |
|------|--------|--------|-------|
| 1 | Load requisition grid (service) | **PASS** | 5 rows from `rm_requisitions` |
| 2 | Load assigned recruiters | **PASS** | 3 active from `rm_recruiter_assignments` for req_id=4 |
| 3 | Assign recruiter | **PASS** | 3→4 assignments; enterprise table only |
| 4 | Remove recruiter | **PASS** | 4→3 assignments; `assignment_id=52` deactivated |
| 5 | Create requisition (no approved_position_id) | **PASS (expected fail)** | Business rule unchanged |
| 6 | Recruiter Workspace dashboard | **Informational** | IGS0378 shows 0 requisitions (not assigned to sample req) |
| 7 | DB drift check | **Informational** | `req_mstr`=4 vs `rm_requisitions`=5 — legacy table not primary read source |

### Runtime scenarios (Requisition Management module)

| Scenario | Executable | Result |
|----------|------------|--------|
| Create Requisition (UI form) | Yes | **Expected 400** without `approved_position_id` — unchanged business rule |
| Edit Requisition | No UI | **N/A** |
| Assign Recruiter | Service: PASS; UI: expected PASS | Service verified |
| Remove Recruiter | Service: PASS; UI: **FAIL** | Missing `httpDelete` import |
| Refresh page | Reload triggers `loadRequisitionManagementPage` | **PASS** (architecture) |
| Refresh Recruiter Workspace | `refreshRecruitment()` after assign/remove | **PASS** (architecture) |
| Reload browser | Same as page load | **PASS** (architecture) |
| Restart backend / frontend | Enterprise routes persist | **PASS** (architecture) |

**Data consistency after assign/remove cycle:** Assigned list count returned to baseline (3). Enterprise assignment count unchanged net (11 active before and after — assign+remove on same recruiter offset).

---

## 5. Database Verification

### 5.1 Per-operation database effects

| Operation | Primary tables written | Audit | Workflow | Business rules |
|-----------|----------------------|-------|----------|----------------|
| Load grid | — | — | — | — |
| Load assigned list | — | — | — | — |
| Create requisition | `rm_requisitions`, optional `req_mstr` | `md_enterprise_audit` (RequisitionCreated) | `wf_instances` start | `evaluateRecruitmentRules` (create_requisition) |
| Assign recruiter | `rm_recruiter_assignments`, optional `req_recruiter_map` | `md_enterprise_audit` (RecruiterAssigned) | `wf_instances` advance if linked | `evaluateRecruitmentRules` (assign_recruiter) |
| Remove recruiter | `rm_recruiter_assignments` deactivate, optional `req_recruiter_map` | `md_enterprise_audit` (RecruiterUnassigned) | — | — |
| Form dropdown reads | — | — | — | — |

### 5.2 Primary read source confirmation

| Data domain | Primary read table | Legacy table read by Requisition Management? |
|-------------|-------------------|---------------------------------------------|
| Requisition list | `rm_requisitions` | **No** |
| Assigned recruiters | `rm_recruiter_assignments` | **No** |
| Recruiter names | `user_mstr` | Reference only |
| Form clients/projects/HM | `client_mstr`, `project_mstr`, `hiring_manager_mstr` | Reference only (not operational SoR) |

**No legacy operational table is the primary read source for Requisition Management.**

---

## 6. Hidden Legacy Endpoint Inventory (Platform)

These remain registered in `index.js` but are **not invoked by Requisition Management**:

| Method | Endpoint | Handler | Status |
|--------|----------|---------|--------|
| GET | `/requisitions` | `legacyOperationalAdapter` (cutover-aware) | **Deprecated** — other modules |
| POST | `/requisition` | `recruitmentLegacyHandlers` → enterprise service | **Deprecated** — other modules |
| PUT | `/requisition/:id` | Inline SQL → `req_mstr` | **Deprecated** — unused by Requisition Management |
| POST | `/assign-recruiter` | `recruitmentLegacyHandlers` | **Deprecated** — other modules |
| GET | `/assigned-recruiters/:reqId` | `recruitmentService.getAssignedRecruitersForRequisition` | **Deprecated route path** — enterprise service underneath |
| DELETE | `/remove-recruiter/:mapId` | `recruitmentLegacyHandlers` | **Deprecated** — other modules |
| GET | `/clients`, `/projects/:id`, `/hiring-managers/:id`, `/recruiters` | Inline SQL | **Deprecated** — other modules |
| GET | `/recruiter-dashboard` | `legacyOperationalAdapter` | **Dead** for production UI |
| GET | `/my-requisitions` | `legacyOperationalAdapter` | **Deprecated** — Candidate/Interview modules |

---

## 7. Remaining Technical Debt

| ID | Item | Severity | Blocks certification? |
|----|------|----------|-------------------------|
| TD-10.1-01 | `httpDelete` not imported in `recruitmentClient.js` | **Critical** | **Yes** — Remove Recruiter UI broken in live mode |
| TD-10.1-02 | Endpoint path `/requisitions/legacy-form` naming | Low | No — executes enterprise service |
| TD-10.1-03 | `assignRecruiter` fallback lookup in `req_mstr` when enterprise row missing | Low | No — edge-case fallback only |
| TD-10.1-04 | `createFromApprovedPosition` optional `insertLegacyRequisition` when dual-write enabled | Low | No — disabled in current env |
| TD-10.1-05 | Platform root legacy routes still registered | Medium | No for Requisition Management; yes for full platform cutover |
| TD-10.1-06 | No Edit/View/Delete/Close requisition in UI | Informational | No — never existed in scope |
| TD-10.1-07 | Create form lacks `approved_position_id` | Informational | No — pre-existing business constraint |
| TD-10.1-08 | `req_mstr` row count ≠ `rm_requisitions` (4 vs 5) | Medium | No for reads; migration hygiene |

---

## 8. Success Criteria Scorecard

| Criterion | Status |
|-----------|--------|
| No direct axios calls remain in Requisition Management | ✅ |
| No legacy GET endpoints called by Requisition Management | ✅ |
| No mixed execution paths in Requisition Management reads | ✅ |
| All reads originate from Enterprise repositories | ✅ |
| All writes originate from Enterprise services | ✅ |
| One operational System of Record | ✅ (`rm_*`) |
| All UI operations function in live mode | ❌ (Remove only) |
| Declared production-ready as reference implementation | ⚠️ **Conditional** |

---

## 9. Reference Implementation Declaration

Requisition Management demonstrates the target migration pattern:

```
UI → Hook → Store → Repository → API Client → /api/v1/recruitment/* → recruitmentService → rm_*
```

**Use this module as the template** for Candidate Management, Interview Scheduling, and Interview Feedback migrations.

**Before production cutover:** resolve TD-10.1-01, re-run UI Remove Recruiter test in live mode, and confirm assign/list/remove counts match Recruiter Workspace after refresh.

---

*Verification only. No application code modified in this sprint.*
