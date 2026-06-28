# Recruiter Workspace Runtime Verification Report

**Date:** 2026-06-27  
**Recruiter:** Sachin (`IGS0506`, `sachin.s@igsglobal.com`)  
**Fix type:** Runtime integration (no architecture changes)

---

## Changes Applied

| Task | Deliverable | Status |
|------|-------------|--------|
| 1 | `ats-frontend/.env.local` with `VITE_API_MODE=live` | ✓ |
| 2 | `GET /api/v1/recruitment/my-dashboard` (`verifyToken` only) | ✓ |
| 3 | SQL-scoped backend filtering by `req.user.employee_code` | ✓ |
| 4 | `recruitmentRepository` → my-dashboard endpoint | ✓ |
| 5 | `refreshRecruitment()` updates recruitment + taskInbox + interviews + error logging | ✓ |
| 6 | Sachin verification (service + API on fresh server) | ✓ |
| 7 | No enterprise-wide download for workspace path | ✓ |

---

## Execution Trace — Sachin (IGS0506)

### 1. Authentication

| Field | Value |
|-------|-------|
| employee_code | `IGS0506` |
| role_name | `Recruiter` |
| JWT source | `req.user.employee_code` (never from frontend body) |

### 2. SQL Rows Returned (`getMyRecruiterDashboard`)

| Entity | SQL Filter | Rows |
|--------|------------|-----:|
| Recruiter Assignments | `recruiter_code = 'IGS0506' AND is_active` | **4** |
| Requisitions | JOIN assignments on `requisition_code` | **4** |
| Candidate Pipeline | JOIN assignments, `m.is_active` | **27** |
| Interviews | JOIN assignments on `requisition_code` | **34** |
| Pending Tasks | Recruitment/Interview modules linked to assigned requisition codes | **0** |

**Isolation:** Returned assignments contain only `IGS0506`. Other active recruiters in DB: **9** (not returned).

**Enterprise-wide bundle (not used by workspace):** 5 requisitions, 27 pipeline — confirms recruiter endpoint is narrower.

### 3. API Response (`GET /api/v1/recruitment/my-dashboard`)

Verified on isolated server with route registered:

```json
{
  "openRequisitions": 4,
  "activeCandidates": 27,
  "pendingTasks": 0,
  "interviewsToday": 0
}
```

**Note:** Restart the backend on port 5000 to pick up the new route if an older process is still running.

### 4. Enterprise Store (after `refreshRecruitment()`)

| Slice | Expected records |
|-------|-----------------:|
| `recruitment.requisitions` | 4 |
| `recruitment.recruiterAssignments` | 4 |
| `recruitment.pipeline` | 27 |
| `taskInbox.tasks` | 0 |
| `interviews.interviews` | 34 |

### 5. Selector / KPI (no recruiter filtering in React)

| KPI | Value | Source |
|-----|------:|--------|
| My Requisitions | **4** | `recruitment.requisitions.length` |
| My Candidates | **27** | `recruitment.pipeline.length` |
| Interviews Today | **0** | No interviews on `2026-06-27` |
| Pending Actions | **0** | No pending tasks linked to Sachin's requisition codes |

KPIs use the **backend-scoped dataset** directly. Only search-box text filtering remains in React.

### 6. DataGrid Rows

| Tab | Rows rendered |
|-----|--------------:|
| Requisitions | 4 (Sachin's assigned reqs only) |
| Pipeline | 27 (candidates on those requisitions) |

No other recruiter's assignment codes appear in the response.

---

## Pending Tasks = 0 (Expected)

Pending tasks in DB:

| task_id | module | assignee_role | business_object_id | Linked to IGS0506 reqs? |
|--------:|--------|---------------|--------------------|-------------------------|
| 1 | Interview Management | Interviewer | INT-2026-00482 | No |
| 2 | Recruitment Management | TA Leader | REQ-2026-1187 | No (seed req) |
| 3 | Offer Management | Finance Director | OFF-2026-00482 | No |
| 4 | Offer Management | Recruiter | OFF-2026-00482 | No |

None of the pending tasks are linked to Sachin's four requisition codes (`REQ0906261`, `REQ2205261`, `REQ2705261`, `REQ0206261`).

---

## Live Mode Verification

```
ats-frontend/.env.local
  VITE_API_MODE=live
  VITE_API_BASE_URL=http://localhost:5000
```

`bootstrapEnterpriseData()` loads recruiter workspace when a JWT exists in `localStorage`, using `Promise.allSettled` for admin modules so recruiter data is not blocked by admin-only 403 responses.

---

## Verification Command

```bash
cd ats-backend
node scripts/verifyRecruiterDashboard.js
```

---

## Manual UI Verification

1. Restart backend: `cd ats-backend && node index.js`
2. Restart frontend dev server (to load `.env.local`): `cd ats-frontend && npm run dev`
3. Log in as `sachin.s@igsglobal.com`
4. Open `/recruiter`
5. Confirm KPIs: **4** requisitions, **27** candidates, **0** interviews today, **0** pending tasks
