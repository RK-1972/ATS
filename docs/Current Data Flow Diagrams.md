# Current Data Flow Diagrams

**OPTALYNX Enterprise Architecture Audit · Section 4**

All flows verified against current code paths. Dashed lines indicate missing or fallback connections.

---

## 1. Recruiter Workspace (Wave 1 — Enterprise path)

**Business question:** *What work requires my attention today?*

```
RecruiterWorkspacePage
        │
        ▼
useRecruiterWorkspace (hook)
        │
        ├── buildRecruiterWorkspaceData (recruiterSelectors.js)
        │         filters by employee_code ↔ recruiter_code
        │
        ▼
Enterprise Store (Zustand)
  slices: recruitment | taskInbox | interviews | auditEvents
        │
        ▼
Repositories
  recruitmentRepository.getAll()
  taskRepository (via bootstrap / store)
  interviewRepository.getAll()
  auditRepository (in-memory only)
        │
        ▼
API Clients (httpClient — live mode only for real data)
  GET /api/v1/recruitment
  GET /api/v1/tasks
  GET /api/v1/interviews
  GET /api/v1/audit  ─ ─ ─ ▶ NOT IMPLEMENTED
        │
        ▼
Express Routes
  recruitmentRoutes | taskRoutes | interviewRoutes
        │
        ▼
Services
  recruitmentService.getRecruitmentBundle()
  taskService.getTaskBundle()
  interviewService.getInterviewBundle()
        │
        ▼
PostgreSQL
  rm_requisitions
  rm_recruiter_assignments
  rm_candidate_mappings  ◀── often EMPTY (no backfill from legacy)
  et_tasks
  im_interviews
        │
        ▼
Returned DTO (JSON bundle)
  { requisitions[], recruiterAssignments[], pipeline[], summary{} }
  { tasks[], summary{} }
  { interviews[], panelAssignments[], summary{} }
```

### Parallel legacy path (NOT used by Recruiter Workspace)

```
RecruiterDashboard (deprecated landing)
        │
        ▼
axios direct
  GET /recruiter-dashboard  → req_recruiter_map, candidate_req_map
  GET /my-requisitions      → req_recruiter_map, req_mstr
```

**Why zeros appear:** Workspace uses enterprise path only. Legacy operational data never crosses into `rm_*` unless created via dual-write handlers after enterprise migration.

---

## 2. Candidate Management (Legacy ATS)

```
CandidatePage
        │
        ▼
axios (no repository)
  GET /candidates
  POST /candidate-req-map        ──▶ recruitmentLegacyHandlers (dual-write to rm_*)
  PUT /update-ats-stage/:mapId   ──▶ recruitmentLegacyHandlers (dual-write)
        │
        ▼
PostgreSQL
  cand_mstr
  candidate_req_map
  (optional rm_candidate_mappings on write)
```

---

## 3. Requisition Management (Legacy ATS)

```
RequisitionPage
        │
        ▼
axios
  GET /requisitions          → req_mstr
  POST /requisition          → recruitmentLegacyHandlers → rm_* + req_mstr
  POST /assign-recruiter     → recruitmentLegacyHandlers → rm_* + req_recruiter_map
        │
        ▼
PostgreSQL (legacy primary read)
  req_mstr, req_recruiter_map
```

---

## 4. Interview Schedule (Legacy ATS)

```
InterviewSchedulePage
        │
        ▼
axios
  GET /interview-schedules, /interview-requisitions, etc.
  POST /schedule-interview     → interviewLegacyHandlers → im_* + interview_schedule_trn
        │
        ▼
PostgreSQL
  interview_schedule_trn (primary read)
  im_interviews (on schedule write)
```

---

## 5. Interview Feedback (Legacy)

```
InterviewFeedbackPage
        │
        ▼
axios
  GET (schedule/feedback context)
  POST /submit-feedback
        │
        ▼
PostgreSQL
  interview_feedback_hdr
  interview_feedback_dtl
```

---

## 6. Hiring Control Tower

```
HiringControlTowerPage
        │
        ▼
useHiringControlTower
        │
        ▼
Enterprise Store: hiringProcess
        │
        ▼
hiringControlTowerRepository.getAll()
        │
        ├── LIVE: workflowsRepository.getPrimaryHiringProcess()
        │         GET /api/v1/workflows
        │         workflowService → wf_instances, wf_history
        │
        └── FALLBACK: hiringControlTowerClient.getAll()
                  GET /api/v1/hiring-control-tower  ─ ─ ─ ▶ NOT IMPLEMENTED
                  returns mock in mock mode
        │
        ▼
Local mutations (approve, clarify) → workflow API advance/clarification
```

---

## 7. Workforce Planning

```
WorkforcePlanningPage(s)
        │
        ▼
useWorkforcePlanning → Outlet context
        │
        ▼
Enterprise Store: workforce
        │
        ▼
workforcePlanningRepository
        │
        ▼
GET /api/v1/workforce
        │
        ▼
workforcePlanningService → wp_* tables
        │
        ▼
createRequisition (store action)
  → workforcePlanningRepository / recruitmentRepository
  → POST /api/v1/workforce/approved-positions/:id/requisitions
  → recruitmentService (rm_* + optional req_mstr)
```

---

## 8. Business Rules

```
Business Rules Pages
        │
        ▼
useBusinessRules
        │
        ▼
Enterprise Store: businessRules
        │
        ▼
businessRulesRepository
        │
        ▼
GET /api/v1/business-rules (+ mutate endpoints)
        │
        ▼
businessRulesService → br_* tables
```

---

## 9. Platform Configuration

```
Platform Config Pages
        │
        ▼
usePlatformConfig
        │
        ▼
platformConfigRepository (+ notificationsRepository delegate)
        │
        ▼
GET /api/v1/platform-config
        │
        ▼
platformConfigService → pc_* tables
```

---

## 10. Master Data (Enterprise UI)

```
MasterDataPage
        │
        ▼
useMasterData
        │
        ▼
masterDataRepository
        │
        ▼
GET /api/v1/master
        │
        ▼
masterDataService → md_records, md_record_history
```

**Parallel:** `MasterManagementPage` → legacy `/clients`, `/projects` → `client_mstr`, etc.

---

## 11. Offer Management (Backend only — no UI workspace yet)

```
enterpriseStore actions (createOffer, submitOffer, …)
        │
        ▼
offerRepository
        │
        ▼
/api/v1/offers/*
        │
        ▼
offerManagementService
        │
        ▼
om_* tables + workflow + taskService + businessRulesService
```

HCT displays offer *stages* from workflow/mock process — not `offerRepository` directly.

---

## 12. Enterprise Bootstrap (Live mode)

```
main.jsx
        │
        ▼
bootstrapEnterpriseData()  [only if VITE_API_MODE=live]
        │
        ▼
Parallel repository.getAll() for all domains
        │
        ▼
useEnterpriseStore.setState({ … all slices … })
```

**Mock mode:** Bootstrap skipped → recruitment/tasks/interviews remain empty unless mocks exist in slice initial state.

---

## Architecture Diagram — Dual System Overview

```mermaid
flowchart TB
  subgraph legacy_ui [Legacy ATS UI]
    CP[CandidatePage]
    RP[RequisitionPage]
    IS[InterviewSchedulePage]
    RD[RecruiterDashboard]
  end

  subgraph enterprise_ui [Enterprise UI]
    RW[Recruiter Workspace]
    WP[Workforce Planning]
    HCT[Hiring Control Tower]
    MD[Master Data]
  end

  subgraph legacy_api [Legacy REST index.js]
    L1[/candidates /requisitions]
    L2[/recruiter-dashboard]
    L3[/schedule-interview]
  end

  subgraph v1_api [Enterprise REST /api/v1]
    V1[/recruitment /tasks /interviews]
    V2[/workforce /workflows]
    V3[/master /platform-config]
  end

  subgraph legacy_db [Legacy PostgreSQL]
    req[req_mstr]
    crm[candidate_req_map]
    rrm[req_recruiter_map]
    ist[interview_schedule_trn]
  end

  subgraph enterprise_db [Enterprise PostgreSQL]
    rm[rm_*]
    im[im_*]
    et[et_tasks]
    wp[wp_*]
    wf[wf_*]
  end

  CP --> L1 --> req
  CP --> L1 --> crm
  RP --> L1 --> req
  RD --> L2 --> rrm
  RD --> L2 --> crm
  IS --> L3 --> ist

  RW --> V1 --> rm
  RW --> V1 --> et
  WP --> V2 --> wp
  HCT --> V2 --> wf

  L1 -. dual-write .-> rm
  L3 -. dual-write .-> im
```

---

## Recruiter Workspace Zero-Data — Decision Tree

```
Is VITE_API_MODE=live?
├── NO  → bootstrap skipped → recruitment slice empty → 0 counts
└── YES → bootstrap loads /api/v1/recruitment
          ├── rm_requisitions empty? → legacy data not in enterprise tables
          ├── rm_* seeded but employee_code ≠ recruiter_code? → filter excludes all
          ├── rm_candidate_mappings empty? → 0 candidates (seed has none)
          └── et_tasks / im_interviews empty? → seeds not run or filtered out
```
