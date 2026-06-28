# Sprint 9.1 — Legacy Write Path Migration Audit

**Date:** 2026-06-27  
**Scope:** Direct controller/SQL writes to deprecated operational tables

---

## Summary

| Table | Direct writes remaining in `index.js` | Service-migrated | Sprint 9.1 change |
|-------|--------------------------------------:|------------------|-------------------|
| `req_recruiter_map` | **0** | Yes | **DELETE migrated** |
| `req_mstr` | 1 | Partial | Unchanged |
| `candidate_req_map` | 1 | Partial | Unchanged |
| `interview_schedule_trn` | 0 | Yes (handler) | Unchanged |
| `interview_feedback_hdr` | 0 | Yes (service) | Unchanged |
| `interview_feedback_dtl` | 0 | Yes (service) | Unchanged |

---

## req_recruiter_map

| Location | Operation | Status |
|----------|-----------|--------|
| `index.js` DELETE `/remove-recruiter/:mapId` | UPDATE is_active | **Migrated (Sprint 9.1)** → `recruitmentService.removeRecruiterAssignment()` |
| `recruitmentService.assignRecruiter()` | INSERT | **Already migrated** — dual-write when `LEGACY_DUAL_WRITE=true` |
| `recruitmentService.removeRecruiterAssignment()` | UPDATE is_active | **New (Sprint 9.1)** — dual-write when `LEGACY_DUAL_WRITE=true` |
| `index.js` GET `/assigned-recruiters/:reqId` | SELECT | **Intentionally legacy read** (Requisition page UI) |
| `legacyOperationalAdapter.js` | SELECT | **Intentionally legacy read** (delegates to enterprise when SoR=enterprise) |

**Confirmation:** No controller performs direct `req_recruiter_map` writes.

---

## req_mstr

| Location | Operation | Status |
|----------|-----------|--------|
| `recruitmentService.insertLegacyRequisition()` | INSERT | **Already migrated** — gated by `LEGACY_DUAL_WRITE` |
| `recruitmentService.approveRequisition()` | UPDATE status | **Already migrated** — gated by `LEGACY_DUAL_WRITE` |
| `recruitmentService.handleLegacyCreateRequisition()` | via service | **Already migrated** |
| `index.js` PUT `/requisition/:id` | UPDATE | **Must migrate** — inline SQL, enterprise not updated |
| `legacyOperationalAdapter.js` | SELECT | **Intentionally legacy read path** |

---

## candidate_req_map

| Location | Operation | Status |
|----------|-----------|--------|
| `recruitmentService.mapCandidate()` | INSERT | **Already migrated** — dual-write when enabled |
| `recruitmentService.updateCandidateStage()` | UPDATE | **Already migrated** — dual-write when enabled |
| `index.js` POST `/candidate-req-map` | — | **Already migrated** → `recruitmentLegacyHandlers.handleLegacyMapCandidate` |
| `index.js` PUT `/update-ats-stage/:mapId` | — | **Already migrated** → `recruitmentLegacyHandlers.handleLegacyUpdateStage` |
| `index.js` POST `/map-existing-candidate` | INSERT | **Must migrate** — inline SQL bypasses enterprise service |
| `interviewService` | UPDATE stage | **Already migrated** — gated dual-write |
| `legacyOperationalAdapter.js` | SELECT | **Intentionally legacy read** |

---

## interview_schedule_trn

| Location | Operation | Status |
|----------|-----------|--------|
| `interviewService.scheduleInterview()` | via enterprise | **Primary SoR:** `im_interviews` |
| `interviewLegacyHandlers.handleScheduleInterview()` | INSERT | **Already migrated** — dual-write path |
| `interviewService` reschedule/complete/feedback | UPDATE | **Already migrated** — gated dual-write |
| `index.js` | SELECT only | **Intentionally legacy read** (some routes delegate to adapter) |

---

## interview_feedback_hdr / interview_feedback_dtl

| Location | Operation | Status |
|----------|-----------|--------|
| `interviewService.syncLegacyFeedback()` | INSERT hdr/dtl | **Already migrated** — gated by `LEGACY_DUAL_WRITE` |
| `index.js` | SELECT only | **Intentionally legacy read** |
| Primary SoR | `im_feedback` | **Already migrated** |

---

## Recruiter Assignment Write Path (Post Sprint 9.1)

All recruiter assignment **mutations** now pass through `recruitmentService`:

| Action | Endpoint | Service method |
|--------|----------|----------------|
| Assign | POST `/assign-recruiter` | `assignRecruiter()` |
| Assign | POST `/api/v1/recruitment/requisitions/:code/assign-recruiter` | `assignRecruiter()` |
| Remove | DELETE `/remove-recruiter/:mapId` | `removeRecruiterAssignment()` |

---

## ID Mapping (legacy map_id → enterprise assignment_id)

Documented in `recruitmentService.resolveRecruiterAssignmentTarget()`:

1. If `mapId` matches an active `rm_recruiter_assignments.assignment_id` → use directly.
2. Else lookup `req_recruiter_map.map_id` → obtain `(req_id, recruiter_code)`.
3. Resolve latest active `rm_recruiter_assignments` row for that pair.
4. Deactivate enterprise row; optionally sync legacy when `LEGACY_DUAL_WRITE=true`.

No duplicate assignment rows are created on remove.

---

## Recommended Follow-up (Out of Sprint 9.1 Scope)

1. Migrate `PUT /requisition/:id` to `recruitmentService`
2. Migrate `POST /map-existing-candidate` to `recruitmentService.mapCandidate()`
