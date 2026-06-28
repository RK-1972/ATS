# System of Record Verification Report

**Sprint 6–8 Operational Duplication Audit**  
**Date:** 2026-06-26  
**Scope:** Analysis only — no code, schema, or data changes.

**Evidence sources:** `migrations/006–008`, `services/recruitmentService.js`, `interviewService.js`, `offerManagementService.js`, `taskService.js`, `workflowService.js`, `index.js` legacy routes, Sprint 6–8 integration docs, read-only row counts from `ats_dev` PostgreSQL.

---

## Row Counts (ats_dev — verified read-only)

| Table | Rows | Origin |
|-------|------|--------|
| **Legacy** | | |
| `req_mstr` | 4 | Production/legacy UI |
| `req_recruiter_map` | 24 | Production/legacy UI |
| `candidate_req_map` | 27 | Production/legacy UI |
| `cand_mstr` | 37 | Production/legacy UI |
| `interview_schedule_trn` | 34 | Production/legacy UI |
| `interview_feedback_hdr` | 9 | Production/legacy UI |
| `interview_feedback_dtl` | 17 | Production/legacy UI |
| `interview_panel_mstr` | 7 | Production/legacy UI |
| **Enterprise (Sprint 6–8)** | | |
| `rm_requisitions` | 1 | Seed (`REQ-2026-1187`) |
| `rm_recruiter_assignments` | 1 | Seed |
| `rm_candidate_mappings` | 0 | Not seeded |
| `rm_pipeline_history` | 0 | — |
| `im_interviews` | 1 | Seed (`INT-2026-00482`) |
| `im_feedback` | 0 | — |
| `et_tasks` | 4 | Seed (interviews + cross-module) |
| `om_offers` | 1 | Seed (`OFF-2026-00482`) |
| `wf_instances` | 1 | Seed |
| `md_enterprise_audit` | 6 | Enterprise service writes |

**Conclusion:** Legacy tables hold operational production volume. Enterprise operational tables hold mostly seed rows with **zero backfill** from legacy. Divergence is already measurable.

---

## Operational Domain Analysis (11-point format)

### 1. Requisitions

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `rm_requisitions` (+ `rm_requisition_snapshots` for versioning — **not** a duplicate) |
| 2 | Legacy table | `req_mstr` |
| 3 | Duplicate? | **YES** (core entity) |
| 4 | Why created / intent | Sprint 6: link requisitions to `wp_approved_positions`, workflow instance IDs, governance fields. **Intent: (a) Replace** legacy over time; dual-write via `insertLegacyRequisition()` during transition. |
| 5 | Permanent SoR | **Recommended:** `rm_requisitions`. **Current de facto:** `req_mstr` (4 rows vs 1). |
| 6 | Data | Legacy 4 / Enterprise 1 (seed). No sync of historical rows. |
| 7 | Reads | Enterprise: `GET /api/v1/recruitment*`. Legacy: `GET /requisitions`, `/my-requisitions`, `/recruiter-dashboard`. |
| 8 | Writes | Enterprise: `POST /api/v1/recruitment/requisitions`, workforce bridge, legacy `POST /requisition` (dual-write). Legacy-only: `PUT /requisition/:id`. |
| 9 | Frontend | Enterprise: Recruiter Workspace. Legacy: RequisitionPage, RecruiterDashboard, InterviewSchedule joins. |
| 10 | Divergence risk | **Critical** — separate read paths; legacy rows never appear in enterprise bundle. |
| 11 | Recommendation | **Replace** reads with enterprise API after backfill; **merge** writes through `recruitmentService` only; retire `req_mstr` reads. |

---

### 2. Candidates

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | **None** — no `rm_candidates` or equivalent |
| 2 | Legacy table | `cand_mstr` |
| 3 | Duplicate? | **NO** — enterprise references `candidate_id` in mappings only |
| 4 | Why / intent | Candidate master was not re-modeled in Sprint 6; intentional deferral, not accidental duplicate. |
| 5 | Permanent SoR | **Recommended:** keep `cand_mstr` as candidate master until enterprise candidate entity is designed OR expose via API view. |
| 6 | Data | Legacy 37 / Enterprise N/A |
| 7 | Reads | Legacy only: `GET /candidates`, interview joins |
| 8 | Writes | Legacy only: `POST/PUT /candidate` |
| 9 | Frontend | CandidatePage (legacy) |
| 10 | Divergence risk | **Medium** — enterprise pipeline rows lack embedded candidate profile; joins must cross schemas. |
| 11 | Recommendation | **Keep** `cand_mstr` as SoR; add FK documentation or future `rm_candidates` only if governance requires it — not a duplicate today. |

---

### 3. Candidate–Requisition Mapping (Pipeline)

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `rm_candidate_mappings` (+ `rm_pipeline_history` = **new** audit trail, not duplicate) |
| 2 | Legacy table | `candidate_req_map` |
| 3 | Duplicate? | **YES** |
| 4 | Why / intent | Sprint 6: workflow linkage, rule evaluation, enterprise audit on stage change. **Intent: (a) Replace** with dual-write on legacy handlers. |
| 5 | Permanent SoR | **Recommended:** `rm_candidate_mappings`. **Current:** `candidate_req_map` (27 vs 0). |
| 6 | Data | Legacy 27 / Enterprise 0 |
| 7 | Reads | Enterprise: `GET /api/v1/recruitment`. Legacy: `/candidates`, `/recruiter-dashboard`, `/pipeline-details`, interview joins. |
| 8 | Writes | Dual-write: `/candidate-req-map`, `/update-ats-stage/:mapId`, v1 mapping endpoints. |
| 9 | Frontend | CandidatePage (legacy); Recruiter Workspace (enterprise — empty). |
| 10 | Divergence risk | **Critical** — 100% of pipeline ops invisible to enterprise UI today. |
| 11 | Recommendation | **Backfill** `rm_candidate_mappings` from legacy; **replace** legacy reads; keep `rm_pipeline_history` as supplementary (valid new capability). |

---

### 4. Recruiter Assignment

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `rm_recruiter_assignments` |
| 2 | Legacy table | `req_recruiter_map` |
| 3 | Duplicate? | **YES** |
| 4 | Why / intent | Sprint 6: version fields, workflow linkage, enterprise audit. **Intent: (a) Replace** with dual-write on assign. |
| 5 | Permanent SoR | **Recommended:** `rm_recruiter_assignments`. **Current:** `req_recruiter_map` (24 vs 1). |
| 6 | Data | Legacy 24 / Enterprise 1 (seed) |
| 7 | Reads | Enterprise: `/api/v1/recruitment`. Legacy: `/my-requisitions`, `/recruiter-dashboard`. |
| 8 | Writes | Dual-write: `/assign-recruiter`, v1 assign-recruiter. |
| 9 | Frontend | RequisitionPage (legacy); Recruiter Workspace (enterprise). |
| 10 | Divergence risk | **High** |
| 11 | Recommendation | **Backfill + replace** legacy reads; single write path via `recruitmentService.assignRecruiter()`. |

---

### 5. Interview Scheduling

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `im_interviews` (+ `im_interview_history` = **new** event log, not duplicate) |
| 2 | Legacy table | `interview_schedule_trn` |
| 3 | Duplicate? | **YES** |
| 4 | Why / intent | Sprint 7: workflow orchestration, enterprise tasks, panel model. **Intent: (a) Replace**; legacy handler dual-writes schedule. |
| 5 | Permanent SoR | **Recommended:** `im_interviews`. **Current:** `interview_schedule_trn` (34 vs 1). |
| 6 | Data | Legacy 34 / Enterprise 1 (seed) |
| 7 | Reads | Enterprise: `GET /api/v1/interviews`. Legacy: `/interview-schedules`, `/my-interviews`. |
| 8 | Writes | Dual-write: `POST /schedule-interview` → `interviewService` + legacy trn update; v1 `/interviews/schedule`. |
| 9 | Frontend | InterviewSchedulePage, InterviewerHome (legacy); Recruiter Workspace partial (enterprise). |
| 10 | Divergence risk | **Critical** |
| 11 | Recommendation | **Backfill** `im_interviews`; route legacy list APIs through enterprise service or deprecate. |

---

### 6. Interview Feedback

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `im_feedback` |
| 2 | Legacy table | `interview_feedback_hdr`, `interview_feedback_dtl` |
| 3 | Duplicate? | **YES** (same business entity, different normalization) |
| 4 | Why / intent | Sprint 7: unified enterprise feedback model linked to `im_interviews`. **Intent: (a) Replace**; legacy `/submit-feedback` still primary for UI. |
| 5 | Permanent SoR | **Recommended:** `im_feedback`. **Current:** legacy hdr/dtl (9/17 vs 0). |
| 6 | Data | Legacy 9+17 / Enterprise 0 |
| 7 | Reads | Legacy: `/view-feedback`. Enterprise: bundle includes feedback when populated. |
| 8 | Writes | Legacy: `POST /submit-feedback`. Enterprise: `POST /api/v1/interviews/:id/feedback`. |
| 9 | Frontend | InterviewFeedbackPage (legacy only today). |
| 10 | Divergence risk | **High** |
| 11 | Recommendation | **Delegate** `/submit-feedback` fully to `interviewService`; **backfill** `im_feedback`. |

---

### 7. Interview Panel (related — partial overlap)

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `im_panel_assignments` |
| 2 | Legacy table | `interview_panel_mstr` |
| 3 | Duplicate? | **NO** (different grain — registry vs per-interview assignment) |
| 4 | Why | Sprint 7 assignment model; legacy table is interviewer master used when scheduling. |
| 5 | SoR | **Keep both:** `interview_panel_mstr` = interviewer registry; `im_panel_assignments` = interview-specific assignment. |
| 6 | Data | Legacy panel 7 / Enterprise assignments 0 |
| 11 | Recommendation | **Keep** both; schedule flow should read panel from legacy master until master data migration. |

---

### 8. Offers

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise tables | `om_offers`, `om_offer_compensation`, `om_offer_approvals`, `om_offer_negotiations`, `om_offer_revisions`, `om_offer_documents`, `om_offer_acceptance`, `om_offer_history` |
| 2 | Legacy table | **None** — no offer tables in legacy ATS |
| 3 | Duplicate? | **NO** — entirely new Offer Governance domain (Sprint 8) |
| 4 | Why | New platform capability: budget validation, approval chain, negotiations, workflow — not ATS duplication. |
| 5 | SoR | `om_*` (only store) |
| 6 | Data | 1 offer seeded; no legacy counterpart |
| 7–9 | APIs/UI | `/api/v1/offers`; store only; HCT shows offer *stage* via workflow mock/instance |
| 10 | Divergence | **Low** with legacy (no legacy offer data). **Medium** with pipeline — offers link to `rm_*` which may be empty. |
| 11 | Recommendation | **Keep** all `om_*` tables exactly as designed. |

---

### 9. Tasks (Enterprise Task Inbox)

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise tables | `et_tasks`, `et_task_history` |
| 2 | Legacy table | **None** |
| 3 | Duplicate? | **NO** |
| 4 | Why | Sprint 7 platform-wide inbox — new capability. |
| 5 | SoR | `et_tasks` |
| 6 | Data | 4 seeded tasks |
| 7 | Reads | `GET /api/v1/tasks`, `/tasks/my`, `/tasks/inbox` |
| 8 | Writes | Task complete/reassign/escalate; created by recruitment/interview/offer/workflow services |
| 9 | Frontend | Recruiter Workspace TaskSummary; no full inbox UI yet |
| 10 | Divergence | **Low** vs legacy. **Medium:** `wf_tasks` (1 row) is separate workflow-internal task store — not legacy duplicate but dual task model inside enterprise. |
| 11 | Recommendation | **Keep** `et_tasks`; clarify relationship to `wf_tasks` in architecture (both valid). |

---

### 10. Workflow Instances

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise tables | `wf_instances`, `wf_tasks`, `wf_history`, `wf_definitions`, … (full engine) |
| 2 | Legacy table | **None** |
| 3 | Duplicate? | **NO** |
| 4 | Why | Sprint 4 Workflow Engine — new platform capability. |
| 5 | SoR | `wf_*` |
| 6 | Data | 1 instance seeded |
| 7 | Reads | `GET /api/v1/workflows`, instance endpoints; HCT via `workflowsRepository` |
| 8 | Writes | Workflow start/advance/clarification across modules |
| 9 | Frontend | HCT, Workforce approvals, config UI |
| 10 | Divergence | **Low** vs legacy. `pc_workflows` is config mirror — overlapping concern but not ATS ops duplicate. |
| 11 | Recommendation | **Keep** entire `wf_*` schema. |

---

### 11. Audit

| # | Field | Value |
|---|-------|-------|
| 1 | Enterprise table | `md_enterprise_audit` |
| 2 | Legacy table | **None** (no legacy audit log table) |
| 3 | Duplicate? | **NO** |
| 4 | Why | Sprint 1+ enterprise audit for governance events — new capability. |
| 5 | SoR | `md_enterprise_audit` (backend write). Frontend `auditEvents` slice is **not** synced — separate concern. |
| 6 | Data | 6 rows in DB; frontend in-memory separate |
| 7 | Reads | **No REST read API implemented** |
| 8 | Writes | All enterprise services via `writeEnterpriseAudit()` |
| 9 | Frontend | Activity timelines read in-memory store only |
| 10 | Divergence | **High** between DB audit and UI audit slice — not legacy duplication. |
| 11 | Recommendation | **Keep** table; add read API (architecture gap, not SoR duplication). |

---

## Non-Operational Enterprise Tables (Sprint 1–5, 6–8 extensions)

These were reviewed against legacy ATS. **None duplicate legacy operational ATS tables.**

| Prefix / tables | Legacy counterpart | Duplicate? | Verdict |
|-----------------|-------------------|------------|---------|
| `md_entity_types`, `md_records`, `md_record_history` | `client_mstr`, `project_mstr`, `hiring_manager_mstr` (conceptual overlap with legacy *masters*, not ops) | Partial overlap with legacy master UI only | **Keep** — enterprise master data is new SoR for reference data |
| `pc_*` (10 tables) | None | NO | **Keep** — platform configuration |
| `br_*` (12 tables) | None | NO | **Keep** — business rules engine |
| `wf_*` (13 tables) | None | NO | **Keep** — workflow engine |
| `wp_*` (9 tables) | None | NO | **Keep** — workforce planning (new module) |
| `rm_pipeline_history` | None | NO | **Keep** — governance audit trail |
| `rm_requisition_snapshots` | None | NO | **Keep** — versioning |
| `im_interview_history` | None | NO | **Keep** — event history |
| `om_offer_*` (7 child tables) | None | NO | **Keep** — offer governance decomposition |

---

## Final Summary Table (Operational Duplicates Only)

```
Enterprise Table          | Legacy Table              | Duplicate? | Current SoR      | Recommended SoR           | Action
--------------------------|---------------------------|------------|------------------|---------------------------|----------------------------------
rm_requisitions           | req_mstr                  | YES        | req_mstr (4)     | rm_requisitions           | Backfill → Replace legacy reads
rm_recruiter_assignments  | req_recruiter_map         | YES        | req_recruiter_map (24) | rm_recruiter_assignments | Backfill → Replace legacy reads
rm_candidate_mappings     | candidate_req_map         | YES        | candidate_req_map (27) | rm_candidate_mappings   | Backfill → Replace legacy reads
(candidates — no ent.)    | cand_mstr                 | NO (gap)   | cand_mstr (37)   | cand_mstr (until designed)| Keep; link from rm_*
im_interviews             | interview_schedule_trn    | YES        | interview_schedule_trn (34) | im_interviews      | Backfill → Replace legacy reads
im_feedback               | interview_feedback_hdr/dtl| YES        | legacy (9/17)    | im_feedback               | Delegate submit → Backfill
im_panel_assignments      | interview_panel_mstr      | NO         | panel_mstr (7)   | Both (registry + assign)  | Keep both
rm_pipeline_history       | —                         | NO         | —                | rm_pipeline_history       | Keep (new)
rm_requisition_snapshots  | —                         | NO         | —                | rm_requisition_snapshots  | Keep (new)
im_interview_history      | —                         | NO         | —                | im_interview_history      | Keep (new)
et_tasks / et_task_history| —                         | NO         | et_tasks (4)     | et_tasks                  | Keep (new platform)
om_* (8 tables)           | —                         | NO         | om_offers (1)    | om_*                      | Keep (new platform)
wf_* (13 tables)          | —                         | NO         | wf_instances (1) | wf_*                      | Keep (new platform)
md_enterprise_audit       | —                         | NO         | DB (6)           | md_enterprise_audit       | Keep; add read API
```

---

## Final Questions — Direct Answers

### 1. Exactly how many duplicate operational tables exist?

**Five enterprise tables** duplicate legacy operational ATS entities:

1. `rm_requisitions`
2. `rm_recruiter_assignments`
3. `rm_candidate_mappings`
4. `im_interviews`
5. `im_feedback`

(Plus **one gap**, not a duplicate: no enterprise candidate master vs `cand_mstr`.)

Supporting enterprise tables (`rm_pipeline_history`, `rm_requisition_snapshots`, `im_interview_history`, all `om_*`, `et_*`, `wf_*`) are **not** operational duplicates.

---

### 2. Are they intentional or accidental?

**Intentional.** Sprint 6 and 7 documentation explicitly states replacing mock persistence with PostgreSQL-backed enterprise services, linking to workforce planning, workflow, and business rules. `recruitmentService` and `interviewService` implement **dual-write** to legacy tables when they exist — a classic **strangler-fig migration** pattern meant to **(a) replace** legacy tables, not coexist permanently.

Accidental aspect: **backfill and read-path cutover were not completed**, leaving legacy as de facto SoR while enterprise tables hold mostly seed data.

---

### 3. Can existing ATS tables continue as the permanent System of Record?

**Technically yes, short term** — they hold all operational volume today (27 mappings, 34 interviews, etc.).

**Architecturally no, long term** — if legacy remains SoR:

- Workforce → requisition governance chain breaks (`wp_approved_positions` → `rm_requisitions`)
- Offer Governance (`om_*`) cannot anchor to enterprise pipeline
- Workflow instances link to enterprise codes, not legacy IDs consistently
- Business rules and audit on enterprise writes bypass legacy-only operations
- Recruiter Workspace and future workspaces remain empty or wrong

Legacy tables can remain as **archive/read replicas during migration**, not as permanent SoR for a Talent Operations Platform.

---

### 4. Which enterprise tables should remain (new capabilities, not ATS duplication)?

**Keep without merge into legacy:**

| Category | Tables |
|----------|--------|
| Master Data | `md_*` |
| Platform Config | `pc_*` |
| Business Rules | `br_*` |
| Workflow Engine | `wf_*` |
| Workforce Planning | `wp_*` |
| Offer Governance | all `om_*` |
| Enterprise Task Inbox | `et_tasks`, `et_task_history` |
| Enterprise Audit | `md_enterprise_audit` |
| Governance extensions | `rm_pipeline_history`, `rm_requisition_snapshots`, `im_interview_history` |

---

### 5. Chief Architect — Recommended Final Production Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 ENTERPRISE TALENT OPERATIONS PLATFORM            │
├─────────────────────────────────────────────────────────────────┤
│  Workspaces (UI) → Repository → /api/v1/* ONLY for ops data   │
├─────────────────────────────────────────────────────────────────┤
│  SYSTEM OF RECORD (operational)                                  │
│    wp_* → rm_requisitions → rm_candidate_mappings              │
│         → im_interviews → im_feedback → om_offers              │
│    cand_mstr (candidate master until optional rm_candidates)   │
│    et_tasks (inbox) + wf_* (orchestration)                     │
│    md_enterprise_audit (audit)                                   │
├─────────────────────────────────────────────────────────────────┤
│  SYSTEM OF RECORD (platform)                                     │
│    md_*, pc_*, br_* — unchanged                                │
├─────────────────────────────────────────────────────────────────┤
│  LEGACY ATS TABLES — DEPRECATED after one-time backfill         │
│    req_mstr, req_recruiter_map, candidate_req_map,              │
│    interview_schedule_trn, interview_feedback_*                 │
│    → read-only archive or dropped after validation              │
├─────────────────────────────────────────────────────────────────┤
│  ALL WRITES → enterprise services (single path, rules, workflow) │
│  ALL READS  → enterprise APIs (single path)                     │
│  interview_panel_mstr → migrate to md_records or keep as ref   │
└─────────────────────────────────────────────────────────────────┘
```

**Migration sequence (recommendation only):**

1. Backfill `rm_*` and `im_*` from legacy (one-time ETL).
2. Switch legacy UI pages to repositories / v1 APIs (reads).
3. Remove legacy direct SQL reads from `index.js` operational endpoints.
4. Freeze legacy tables; dual-write already in place for new mutations.
5. Proceed with Wave 2+ workspaces on unified SoR.

---

**No code, schema, or data modifications were made in producing this report.**
