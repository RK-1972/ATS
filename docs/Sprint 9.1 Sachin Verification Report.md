# Sprint 9.1 — Sachin Verification Report

**Recruiter:** Sachin (`IGS0506`)  
**Date:** 2026-06-27  
**Scenario:** Remove one recruiter assignment; verify dashboard counts update without app restart

---

## Test Execution

Command:

```bash
cd ats-backend
node scripts/verifySprint91RemoveRecruiter.js
```

Service call: `recruitmentService.removeRecruiterAssignment(pool, mapId=21, TA Lead user)`

---

## Results

| Layer | Before | After | Expected | Status |
|-------|-------:|------:|----------|--------|
| **Enterprise DB** active assignments | 4 | **3** | 3 | **PASS** |
| **my-dashboard SQL** requisitions | 4 | **3** | 3 | **PASS** |
| **my-dashboard SQL** assignments | 4 | **3** | 3 | **PASS** |
| **API** `GET /api/v1/recruitment/my-dashboard` | 4 | **3** | 3 | **PASS** |
| Recruiter Workspace KPI (derived) | 4 | **3** | 3 | **PASS** |

### Removed assignment detail

| Field | Value |
|-------|-------|
| Legacy map_id (input) | 21 |
| Enterprise assignment_id | 46 |
| requisition_code | REQ0206261 |
| recruiter_code | IGS0506 |
| Resolution | `legacy_map_id` |

### Side effects (expected)

| Metric | Before | After |
|--------|-------:|------:|
| Pipeline candidates (my reqs) | 27 | 14 |
| Legacy active assignments | 3 | 3* |

\* Legacy count unchanged because `LEGACY_DUAL_WRITE=false` (enterprise-only write). Legacy map_id 21 was already inactive prior to test in some environments; enterprise row 46 was the active SoR record.

---

## Confirmation

- **Enterprise SoR updated:** `rm_recruiter_assignments.is_active = false` for assignment_id 46
- **No application restart required:** my-dashboard reflects new count immediately
- **Recruiter Workspace KPI** reads from my-dashboard via store refresh — will show **3** after `refreshRecruitment()` or page navigation with refresh
- **All recruiter assignment writes** now go through `recruitmentService` (assign + remove)

---

## Manual UI Verification

1. Restart backend (pick up Sprint 9.1 route handler)
2. Log in as TA Lead → Requisition page → remove Sachin from a requisition
3. Log in as Sachin → Recruiter Workspace → click Refresh (or re-open `/recruiter`)
4. Confirm **My Requisitions = 3**

---

## Verdict

**Sprint 9.1 verification: PASS**

The last remaining legacy-only write path for recruiter removal is eliminated. Dashboard staleness caused by enterprise/legacy drift is resolved for this operation.
