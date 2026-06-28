# Production Readiness Assessment

**OPTALYNX Enterprise Architecture Audit · Sections 10, 11, 12**

Assessment date: 2026-06-26. Based on codebase inspection only — not runtime deployment testing.

---

## §10 — Module Integration Status

| Module | Frontend | Backend | API Connected | Repository | Store | Live Data | Mock Data | Production Ready |
|--------|----------|---------|---------------|------------|-------|-----------|-----------|------------------|
| Authentication | Legacy UI | Yes | Yes (`/login`) | No | No | Yes | No | **Partial** — no enterprise integration |
| Enterprise Master Data | Enterprise UI | Yes | Yes | Yes | Yes | Yes (live mode) | Yes (mock file) | **Yes** (enterprise scope) |
| Platform Configuration | Enterprise UI | Yes | Yes | Yes | Yes | Yes | Yes | **Yes** |
| Business Rules | Enterprise UI | Yes | Yes | Yes | Yes | Yes | Yes | **Yes** |
| Workflow Engine | Config UI + HCT | Yes | Yes | Yes | Yes | Partial (HCT) | Yes (HCT mock) | **Partial** |
| Workforce Planning | Enterprise UI | Yes | Yes | Yes | Yes | Yes | Yes | **Yes** |
| Recruitment (enterprise) | Recruiter Workspace only | Yes | Yes | Yes | Yes | **If rm_* populated** | Empty | **No** — split SoR |
| Recruitment (legacy ATS) | Candidate/Requisition pages | Yes | Yes (legacy) | **No** | **No** | Yes | No | **Operational but parallel** |
| Interview (enterprise) | Store only + WS partial | Yes | Yes | Yes | Yes | If seeded | Empty | **Partial** |
| Interview (legacy) | Schedule/Feedback pages | Yes | Yes (legacy) | No | No | Yes | No | **Operational but parallel** |
| Enterprise Task Inbox | Recruiter WS partial | Yes | Yes | Yes | Yes | If seeded | Empty | **Partial** — no dedicated inbox UI |
| Offer Governance | **No UI** | Yes | Yes | Yes | Yes | If seeded | Empty | **Backend only** |
| Hiring Control Tower | Enterprise UI | Partial | Partial | Yes | Yes | Workflow instance | Full mock | **Partial** — no HCT API |
| Enterprise Audit | In-memory UI only | Write-only DB | **No read API** | Yes (client) | Yes | **No** | Session only | **No** |
| Recruiter Workspace (Wave 1) | Yes | Depends on rm_* | Yes | Yes | Yes | **Often empty** | Empty | **No** — blocked on SoR |
| Legacy Master Management | Yes | Yes | Legacy | No | No | Yes | No | Legacy only |

### Legend

- **Production Ready Yes:** Enterprise module end-to-end with consistent SoR in live mode.
- **Partial:** Implemented but parallel systems, missing API, or UI gaps.
- **No:** Cannot be relied on as sole operational path today.

---

## §11 — Architecture Risks (Expanded)

### Critical

| ID | Risk | Impact |
|----|------|--------|
| C1 | **Dual System of Record** for requisitions, pipeline, interviews | Recruiter Workspace and legacy ATS show different truths |
| C2 | **No legacy→enterprise backfill** | Existing operational data invisible to enterprise workspaces |
| C3 | **Recruiter Workspace assumes enterprise SoR** while ops teams use legacy UI | Wave 2+ workspaces will repeat same failure mode |

### High

| ID | Risk | Impact |
|----|------|--------|
| H1 | Missing `GET /api/v1/audit` | Audit UI cannot reflect persisted enterprise audit |
| H2 | Missing `GET /api/v1/hiring-control-tower` | HCT relies on workflow instance shape or mock |
| H3 | Legacy pages write/read legacy tables **without** mandatory enterprise path | Data divergence on every legacy-only operation |
| H4 | `VITE_API_MODE=mock` default | Developers see populated mocks for workforce/HCT but empty recruitment |
| H5 | Candidate master only in `cand_mstr` | Enterprise pipeline rows lack canonical candidate entity in enterprise schema |

### Medium

| ID | Risk | Impact |
|----|------|--------|
| M1 | `wf_tasks` vs `et_tasks` — two task models | User confusion; incomplete inbox |
| M2 | `pc_workflows` vs `wf_definitions` overlap | Config drift |
| M3 | Recruitment seed lacks pipeline/candidates | False negative in testing |
| M4 | Recruiter filter by `employee_code` | Mismatch with seed recruiter `EMP-1042` |
| M5 | Offer backend with no UI | Untested user journeys |
| M6 | `notificationsClient` endpoint unused | Dead client surface |

### Low

| ID | Risk | Impact |
|----|------|--------|
| L1 | `RecruiterDashboard` dead code path | Maintenance noise |
| L2 | Large `index.js` monolith | Operational risk, hard to trace |
| L3 | `requisition_mstr` typo in one SQL query | Potential query failure edge case |

---

## §12 — Recommendations (Prioritized)

### Critical — Block Wave 2 until resolved or explicitly accepted

| # | Issue | Action | Rationale |
|---|-------|--------|-----------|
| 1 | Dual SoR (req vs rm, crm vs rm pipeline, ist vs im) | **Synchronize** — one-time backfill + single write path | Enterprise workspaces cannot show operational truth otherwise |
| 2 | Recruiter Workspace empty | **Replace** data source with unified SoR OR **Synchronize** tables first | User-reported defect; architectural not cosmetic |
| 3 | Legacy UI bypasses enterprise for reads | **Deprecate** legacy read endpoints after migration; **Refactor** pages to repositories | Prevents divergence |

### High — Address in architecture sprint before Wave 2–3

| # | Issue | Action |
|---|-------|--------|
| 4 | No audit read API | **Keep** `md_enterprise_audit`; implement `GET /api/v1/audit`; **Merge** frontend hydration |
| 5 | No HCT API | **Replace** mock fallback with workflow instance API contract OR implement HCT route |
| 6 | Legacy mutations without enterprise | **Merge** all writes through existing legacy handlers (extend coverage) |
| 7 | Mock mode recruitment empty | **Keep** mock mode; add recruitment mock bundle OR document live-only for ops modules |

### Medium — Plan for Wave 2–5

| # | Issue | Action |
|---|-------|--------|
| 8 | Task inbox UI missing | **Keep** `et_tasks`; build Wave 2 inbox workspace |
| 9 | Incomplete seeds | **Synchronize** seed scripts with HCT narrative (candidates, pipeline, tasks) |
| 10 | Offer UI missing | **Keep** backend; Wave 3 workspace per charter |
| 11 | Two master data UIs | **Deprecate** legacy Master Management; **Merge** into enterprise Master Data |
| 12 | wf_tasks vs et_tasks | **Refactor** documentation and UI labeling; consider **Merge** visibility in single inbox |

### Low — Backlog

| # | Issue | Action |
|---|-------|--------|
| 13 | Dead RecruiterDashboard | **Delete** or **Merge** into workspace after SoR fix |
| 14 | index.js monolith | **Refactor** extract legacy routes to modules (no behavior change) |
| 15 | notificationsClient orphan | **Delete** unused endpoint constant or wire to platform-config |

---

## Pre-Wave 2 Gate Criteria (Recommended)

Before implementing Wave 2 (Enterprise Task Inbox + Interviewer Workspace):

1. **Decision recorded:** Which tables are authoritative for requisitions, candidates, interviews, tasks.
2. **Data verified:** Count legacy vs enterprise rows in target environment; backfill plan approved if needed.
3. **`VITE_API_MODE=live` verified** with seeds applied for recruitment, interviews, tasks.
4. **Recruiter Workspace shows non-zero data** when legacy ATS has operational assignments — OR explicit acceptance of empty enterprise until migration.
5. **Audit read path** scoped (even if deferred, document as known gap).

---

## Answer to User Question

> The Recruiter Workspace shows 0 while ATS has operational data. Is the Enterprise Platform consuming the same data?

**No.** The Recruiter Workspace consumes **enterprise tables** (`rm_*`, `et_tasks`, `im_interviews`) via `/api/v1/*`. The legacy ATS UI consumes **legacy tables** (`req_mstr`, `candidate_req_map`, `req_recruiter_map`, `interview_schedule_trn`). Dual-write applies only to **specific mutation endpoints** routed through enterprise legacy handlers; it does **not** synchronize existing historical data or unify read paths. The enterprise platform is **architecturally complete** for governance modules but **not yet a unified System of Record** for day-to-day recruiting operations.

**Await approval before making architectural changes.**
