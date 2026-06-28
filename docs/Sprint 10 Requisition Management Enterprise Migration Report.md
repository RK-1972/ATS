# Sprint 10 — Requisition Management Enterprise Migration Report

**Date:** 2026-06-27  
**Scope:** RequisitionPage, Recruiter Assignment dialog, related store/repository/API/service layer

---

## Pre-Migration Audit Matrix

| Action | HTTP | Pre-migration path | Classification |
|--------|------|-------------------|----------------|
| Load requisition grid | GET `/requisitions` | RequisitionPage → axios → `legacyOperationalAdapter` (cutover-aware) | **Mixed** |
| Load clients | GET `/clients` | RequisitionPage → axios → inline SQL `client_mstr` | **Legacy** |
| Load projects | GET `/projects/:clientId` | RequisitionPage → axios → inline SQL `project_mstr` | **Legacy** |
| Load hiring managers | GET `/hiring-managers/:projectId` | RequisitionPage → axios → inline SQL `hiring_manager_mstr` | **Legacy** |
| Load recruiters dropdown | GET `/recruiters` | RequisitionPage → axios → inline SQL `user_mstr` | **Legacy** |
| Create requisition | POST `/requisition` | RequisitionPage → axios → `recruitmentLegacyHandlers` → `recruitmentService` | **Mixed** (enterprise write, legacy route) |
| Load assigned recruiters | GET `/assigned-recruiters/:reqId` | RequisitionPage → axios → inline SQL `req_recruiter_map` | **Legacy** |
| Assign recruiter | POST `/assign-recruiter` | RequisitionPage → axios → `recruitmentService.assignRecruiter` | **Mixed** (enterprise write, legacy route) |
| Remove recruiter | DELETE `/remove-recruiter/:mapId` | RequisitionPage → axios → `recruitmentService.removeRecruiterAssignment` | **Mixed** (enterprise write, legacy route) |

**Tables touched pre-migration:**

| Operation | Read | Write |
|-----------|------|-------|
| Grid | `rm_requisitions` OR `req_mstr` (adapter) | — |
| Assigned list | `req_recruiter_map` | — |
| Assign | `rm_recruiter_assignments` (dup check) | `rm_recruiter_assignments` (+ optional `req_recruiter_map`) |
| Remove | resolver across both | `rm_recruiter_assignments` (+ optional `req_recruiter_map`) |

---

## Post-Migration Execution Path

All RequisitionPage operations now follow:

```
RequisitionPage
  → useRequisitionManagement
  → enterpriseStore (requisitionManagement slice)
  → recruitmentRepository
  → recruitmentClient (httpClient)
  → /api/v1/recruitment/*
  → recruitmentService
  → Enterprise System of Record
```

---

## Post-Migration Action Matrix

| Action | Store action | Repository | API | Service method | Table(s) |
|--------|-------------|------------|-----|----------------|----------|
| Load grid | `loadRequisitionManagementPage` | `listManagementRequisitions` | GET `/api/v1/recruitment/requisitions` | `listRequisitionsForManagement` | READ `rm_requisitions` |
| Load clients | `loadRequisitionManagementPage` | `listFormClients` | GET `/api/v1/recruitment/form-options/clients` | `listFormClients` | READ `client_mstr` |
| Load projects | `loadRequisitionFormProjects` | `listFormProjects` | GET `.../form-options/projects/:clientId` | `listFormProjectsByClient` | READ `project_mstr` |
| Load hiring managers | `loadRequisitionFormHiringManagers` | `listFormHiringManagers` | GET `.../form-options/hiring-managers/:projectId` | `listFormHiringManagersByProject` | READ `hiring_manager_mstr` |
| Load recruiters | `loadRequisitionManagementPage` | `listFormRecruiters` | GET `.../form-options/recruiters` | `listFormRecruiters` | READ `user_mstr` |
| Create requisition | `createRequisitionFromForm` | `createRequisitionFromForm` | POST `/api/v1/recruitment/requisitions/legacy-form` | `handleLegacyCreateRequisition` | WRITE `rm_requisitions` (+ optional `req_mstr`) |
| Load assigned recruiters | `loadAssignedRecruiters` | `getAssignedRecruiters` | GET `/api/v1/recruitment/requisitions/:reqId/assigned-recruiters` | `getAssignedRecruitersForRequisition` | READ `rm_recruiter_assignments`, `user_mstr` |
| Assign recruiter | `assignRecruiterOnRequisition` | `assignRecruiterToRequisition` | POST `/api/v1/recruitment/requisitions/:reqId/assign-recruiter` | `assignRecruiter` | READ/WRITE `rm_recruiter_assignments` |
| Remove recruiter | `removeRecruiterFromRequisition` | `removeRecruiterFromRequisition` | DELETE `/api/v1/recruitment/recruiter-assignments/:assignmentId` | `removeRecruiterAssignment` | WRITE `rm_recruiter_assignments` |
| Refresh after mutation | (inline in store actions) | `getAssignedRecruiters` / `listManagementRequisitions` | Same enterprise GETs | Same service methods | Same enterprise tables |
| Recruiter Workspace sync | `refreshRecruitment` | `getRecruiterWorkspaceBundle` | GET `/api/v1/recruitment/my-dashboard` | `getMyRecruiterDashboard` | READ `rm_*` |

**Classification after migration:** All **Enterprise** (operational SoR = `rm_requisitions`, `rm_recruiter_assignments`; form reference data via recruitment service).

---

## Recruiter Assignment Dialog — Single Source of Truth

| Concern | Source |
|---------|--------|
| Assigned list | `rm_recruiter_assignments` + `user_mstr` |
| Duplicate validation | `rm_recruiter_assignments` (in `assignRecruiter`) |
| Assign write | `rm_recruiter_assignments` |
| Remove write | `rm_recruiter_assignments` (`assignment_id`; UI `map_id` = `assignment_id`) |
| Refresh after assign/remove | Same GET assigned-recruiters endpoint |
| Recruiter Workspace KPIs (post-mutation) | `refreshRecruitment()` → `rm_recruiter_assignments` via my-dashboard |

---

## Legacy Dependencies Removed from RequisitionPage

| Removed dependency | Replacement |
|-------------------|-------------|
| `import API from "../api/axios"` | Removed — no direct axios |
| GET `/requisitions` | GET `/api/v1/recruitment/requisitions` |
| GET `/clients` | GET `/api/v1/recruitment/form-options/clients` |
| GET `/projects/:id` | GET `/api/v1/recruitment/form-options/projects/:clientId` |
| GET `/hiring-managers/:id` | GET `/api/v1/recruitment/form-options/hiring-managers/:projectId` |
| GET `/recruiters` | GET `/api/v1/recruitment/form-options/recruiters` |
| POST `/requisition` | POST `/api/v1/recruitment/requisitions/legacy-form` |
| GET `/assigned-recruiters/:reqId` | GET `/api/v1/recruitment/requisitions/:reqId/assigned-recruiters` |
| POST `/assign-recruiter` | POST `/api/v1/recruitment/requisitions/:reqId/assign-recruiter` |
| DELETE `/remove-recruiter/:mapId` | DELETE `/api/v1/recruitment/recruiter-assignments/:assignmentId` |

---

## Backend Changes (Supporting Layer)

### New `recruitmentService` methods
- `listRequisitionsForManagement`
- `getAssignedRecruitersForRequisition`
- `listFormRecruiters`, `listFormClients`, `listFormProjectsByClient`, `listFormHiringManagersByProject`
- `mapRequisitionForManagementUi`, `mapAssignmentForManagementUi`

### New enterprise routes (`recruitmentRoutes.js`)
- GET `/api/v1/recruitment/requisitions` — now always reads `rm_requisitions` with UI field mapping
- GET `/api/v1/recruitment/requisitions/:reqId/assigned-recruiters`
- DELETE `/api/v1/recruitment/recruiter-assignments/:assignmentId`
- POST `/api/v1/recruitment/requisitions/legacy-form`
- GET `/api/v1/recruitment/form-options/*`

Management routes use `verifyToken` only (matching legacy route permissions); role checks remain in `recruitmentService`.

### Legacy route delegation (non-RequisitionPage callers)
- GET `/assigned-recruiters/:reqId` in `index.js` now delegates to `recruitmentService.getAssignedRecruitersForRequisition` (removed inline `req_recruiter_map` SQL)

---

## Files Changed

| File | Change |
|------|--------|
| `ats-frontend/src/pages/RequisitionPage.jsx` | Migrated to enterprise store hook |
| `ats-frontend/src/hooks/useRequisitionManagement.js` | **New** |
| `ats-frontend/src/store/enterpriseStore.js` | `requisitionManagement` slice + actions |
| `ats-frontend/src/repositories/recruitmentRepository.js` | Management + form option methods |
| `ats-frontend/src/api/clients/recruitmentClient.js` | Enterprise API client methods |
| `ats-backend/services/recruitmentService.js` | Management + form service methods |
| `ats-backend/routes/recruitmentRoutes.js` | Enterprise endpoints |
| `ats-backend/handlers/recruitmentLegacyReadHandlers.js` | `handleGetAssignedRecruiters` |
| `ats-backend/index.js` | Delegated GET `/assigned-recruiters` |

---

## Completion Criteria

| Criterion | Status |
|-----------|--------|
| No direct legacy axios in RequisitionPage | PASS |
| No inline legacy GET for assigned recruiters (page + legacy route) | PASS |
| One SoR for requisition operations (`rm_*`) | PASS |
| Assign / Remove / Refresh consistent (same table, store refresh + workspace sync) | PASS |
| UI, UX, workflow, permissions unchanged | PASS (same form, modal, alerts; service-level role checks preserved) |
| Build passes | PASS (`npm run build` exit 0) |

---

## Notes

- **Create Requisition** still requires `approved_position_id` at the service layer (unchanged business rule). The form does not collect this field; behavior is identical to pre-migration.
- Form dropdown reference data (`client_mstr`, `project_mstr`, `hiring_manager_mstr`, `user_mstr`) is exposed through the Recruitment Service for this page only; these are master/reference tables, not operational SoR.
- Legacy POST/DELETE assign/remove routes remain in `index.js` for other screens but are no longer called by RequisitionPage.
