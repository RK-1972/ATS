# Database Mapping Report

**OPTALYNX Enterprise Architecture Audit · Section 1, 2, 9**

Analysis based on `ats-backend/migrations/*.sql` and `ats-backend/index.js` SQL usage. Legacy tables are not defined in migration files; they pre-date the enterprise sprint migrations.

---

## §1 — Complete Database Inventory

### Legend

- **Sprint:** Enterprise migration sprint (001–008). Legacy = pre-enterprise.
- **SoR:** Intended enterprise System of Record when module is production-backed.
- **Legacy:** Pre-enterprise ATS table.

### Legacy ATS Tables

| Table | Module | Purpose | Sprint | Used | Read By | Written By | SoR | Legacy |
|-------|--------|---------|--------|------|---------|------------|-----|--------|
| `user_mstr` | Authentication | Users, roles, credentials | Legacy | Yes | `/login`, `/users`, legacy joins | `/register`, user CRUD | Yes (auth) | Yes |
| `password_reset_tokens` | Authentication | Password reset tokens | Legacy | Yes | `/reset-password` | forgot/reset flows | Yes | Yes |
| `cand_mstr` | Candidate Management | Candidate master records | Legacy | Yes | `/candidates`, legacy interview joins | `/candidate` POST/PUT | **Yes (de facto)** | Yes |
| `req_mstr` | Requisition Management | Operational requisitions | Legacy | Yes | `/requisitions`, `/my-requisitions`, `/recruiter-dashboard` | `/requisition`, legacy CRUD | **Yes (de facto ops)** | Yes |
| `req_recruiter_map` | Recruitment | Recruiter-to-requisition assignments | Legacy | Yes | `/my-requisitions`, `/recruiter-dashboard` | `/assign-recruiter`, `recruitmentService.assignRecruiter` (dual-write) | No | Yes |
| `candidate_req_map` | Recruitment | Candidate-requisition pipeline | Legacy | Yes | `/candidates`, pipeline APIs, interview joins | `/candidate-req-map`, legacy stage updates, `recruitmentService` (dual-write) | **Yes (de facto ops)** | Yes |
| `stages` | Recruitment | Stage reference (joins) | Legacy | Yes | `/dashboard-funnel` | Unknown / reference | No | Yes |
| `client_mstr` | Master Data (legacy) | Clients | Legacy | Yes | `/clients`, requisition forms | `/client` | Yes (legacy UI) | Yes |
| `project_mstr` | Master Data (legacy) | Projects | Legacy | Yes | `/all-projects` | `/project` | Yes (legacy UI) | Yes |
| `hiring_manager_mstr` | Master Data (legacy) | Hiring managers | Legacy | Yes | `/all-hiring-managers` | `/hiring-manager` | Yes (legacy UI) | Yes |
| `interview_panel_mstr` | Interview | Interviewer panel registry | Legacy | Yes | `/interview-panel`, schedule flows | `/interview-panel` POST/PUT | **Yes (de facto)** | Yes |
| `interview_schedule_trn` | Interview | Scheduled interviews | Legacy | Yes | `/interview-schedules`, `/my-interviews` | `/schedule-interview`, `interviewService` (partial) | **Yes (de facto ops)** | Yes |
| `interview_feedback_hdr` | Interview | Feedback header | Legacy | Yes | `/view-feedback` | `/submit-feedback` | **Yes (de facto)** | Yes |
| `interview_feedback_dtl` | Interview | Feedback line items | Legacy | Yes | feedback views | `/submit-feedback` | **Yes (de facto)** | Yes |
| `requisition_mstr` | Interview (query only) | Referenced in one interviewer query | Legacy | Possibly typo/alias | `/my-interviews` (one query) | — | Unclear | Yes |

### Enterprise Tables — Master Data (Sprint 1 / 001)

| Table | Module | Purpose | Used | Read By | Written By | SoR | Legacy |
|-------|--------|---------|------|---------|------------|-----|--------|
| `md_entity_types` | Master Data | Entity type registry | Yes | `masterDataService` | Seed/migration | Yes | No |
| `md_records` | Master Data | Versioned master records | Yes | `/api/v1/master` | masterDataService | Yes | No |
| `md_record_history` | Master Data | Record version history | Yes | masterDataService | masterDataService | Yes | No |
| `md_enterprise_audit` | Enterprise Audit | Persistent audit events | Yes | **No read API** | All enterprise services via `enterpriseAuditService` | Yes (write-only today) | No |

### Enterprise Tables — Platform Configuration (Sprint 2 / 002)

| Table | Purpose | Used | SoR |
|-------|---------|------|-----|
| `pc_config_state` | Draft/published state | Yes | Yes |
| `pc_config_snapshots` | Config snapshots | Yes | Yes |
| `pc_general_settings` | Org settings | Yes | Yes |
| `pc_modules` | Module enablement | Yes | Yes |
| `pc_workflows` | Workflow toggles (config UI) | Yes | Partial (config mirror) |
| `pc_budget_governance` | Budget thresholds | Yes | Yes |
| `pc_notification_channels` | Channel config | Yes | Yes |
| `pc_notification_settings` | Notification policies | Yes | Yes |
| `pc_ai_features` | AI feature flags | Yes | Yes |
| `pc_ai_governance` | AI governance | Yes | Yes |
| `pc_role_visibility` | Role-module matrix | Yes | Yes |
| `pc_approval_policies` | Approval policies | Yes | Yes |

### Enterprise Tables — Business Rules (Sprint 3 / 003)

| Table | Purpose | Used | SoR |
|-------|---------|------|-----|
| `br_config_state` | Draft/published | Yes | Yes |
| `br_bundle_snapshots` | Snapshots | Yes | Yes |
| `br_general_settings` | Settings | Yes | Yes |
| `br_categories` | Rule categories | Yes | Yes |
| `br_rules` | Rules | Yes | Yes |
| `br_rule_conditions` | Conditions | Yes | Yes |
| `br_rule_actions` | Actions | Yes | Yes |
| `br_rule_parameters` | Parameters | Yes | Yes |
| `br_rule_versions` | Versions | Yes | Yes |
| `br_rule_dependencies` | Dependencies | Yes | Yes |
| `br_approval_matrix` | Approval matrix | Yes | Yes |
| `br_rule_execution_history` | Execution log | Yes | Yes |

### Enterprise Tables — Workflow Engine (Sprint 4 / 004)

| Table | Purpose | Used | SoR |
|-------|---------|------|-----|
| `wf_config_state` | Config state | Yes | Yes |
| `wf_bundle_snapshots` | Snapshots | Yes | Yes |
| `wf_definitions` | Workflow definitions | Yes | Yes |
| `wf_stages` | Stages | Yes | Yes |
| `wf_stage_transitions` | Transitions | Yes | Yes |
| `wf_transition_conditions` | Conditions | Yes | Yes |
| `wf_versions` | Versions | Yes | Yes |
| `wf_sla_definitions` | SLA | Yes | Yes |
| `wf_escalation_policies` | Escalation | Yes | Yes |
| `wf_instances` | Running instances | Yes | Yes |
| `wf_tasks` | Workflow-internal tasks | Yes | Yes (workflow scope) |
| `wf_assignments` | Assignments | Yes | Yes |
| `wf_history` | Instance history | Yes | Yes |

### Enterprise Tables — Workforce Planning (Sprint 5 / 005)

| Table | Purpose | Used | SoR |
|-------|---------|------|-----|
| `wp_config_state` | Config state | Yes | Yes |
| `wp_bundle_snapshots` | Snapshots | Yes | Yes |
| `wp_workforce_plans` | Plans | Yes | Yes |
| `wp_budget_requests` | Budget requests | Yes | Yes |
| `wp_position_requests` | Position requests | Yes | Yes |
| `wp_approved_positions` | Approved catalogue | Yes | Yes |
| `wp_budget_utilization` | Utilization | Yes | Yes |
| `wp_department_headcount` | Headcount | Yes | Yes |
| `wp_budget_exceptions` | Exceptions | Yes | Yes |
| `wp_position_lifecycle` | Lifecycle | Yes | Yes |

### Enterprise Tables — Recruitment (Sprint 6 / 006)

| Table | Purpose | Used | Read By | Written By | SoR | Legacy |
|-------|---------|------|---------|------------|-----|--------|
| `rm_requisitions` | Enterprise requisitions | Yes | `/api/v1/recruitment` | `recruitmentService`, seed | **Yes (intended)** | No |
| `rm_recruiter_assignments` | Recruiter assignments | Yes | `/api/v1/recruitment` | `recruitmentService`, seed | **Yes (intended)** | No |
| `rm_candidate_mappings` | Pipeline mappings | Yes | `/api/v1/recruitment` | `recruitmentService`, seed (none in seed file) | **Yes (intended)** | No |
| `rm_pipeline_history` | Pipeline audit trail | Yes | Service internal | `recruitmentService` | Yes | No |
| `rm_requisition_snapshots` | Requisition versions | Yes | Service | `recruitmentService` | Yes | No |

### Enterprise Tables — Interview + Task Inbox (Sprint 7 / 007)

| Table | Purpose | Used | SoR |
|-------|---------|------|-----|
| `et_tasks` | Enterprise task inbox | Yes | Yes |
| `et_task_history` | Task history | Yes | Yes |
| `im_interviews` | Interviews | Yes | Yes |
| `im_panel_assignments` | Panel assignments | Yes | Yes |
| `im_feedback` | Feedback | Yes | Yes |
| `im_interview_history` | Interview history | Yes | Yes |

### Enterprise Tables — Offer Management (Sprint 8 / 008)

| Table | Purpose | Used | SoR |
|-------|---------|------|-----|
| `om_offers` | Offers | Yes | Yes |
| `om_offer_compensation` | Compensation | Yes | Yes |
| `om_offer_approvals` | Approvals | Yes | Yes |
| `om_offer_negotiations` | Negotiations | Yes | Yes |
| `om_offer_revisions` | Revisions | Yes | Yes |
| `om_offer_documents` | Documents | Yes | Yes |
| `om_offer_acceptance` | Acceptance | Yes | Yes |
| `om_offer_history` | History | Yes | Yes |

---

## §2 — Legacy vs Enterprise Mapping

```
LEGACY                          ENTERPRISE                    RELATIONSHIP
─────────────────────────────────────────────────────────────────────────────
req_mstr                   →    rm_requisitions              Dual-write on enterprise create;
                                                               partial status sync on approve.
                                                               Legacy-only rows NOT backfilled.

req_recruiter_map          →    rm_recruiter_assignments     Dual-write on assignRecruiter().
                                                               Legacy reads use req_recruiter_map only.

candidate_req_map          →    rm_candidate_mappings        Dual-write on mapCandidate() and
                                                               updateCandidateStage() via legacy handlers.
                                                               Legacy reads use candidate_req_map only.

cand_mstr                  →    (no enterprise table)        candidate_id referenced in rm_* / im_*
                                                               but candidate master stays legacy-only.

interview_schedule_trn     →    im_interviews                Dual-write on schedule via legacy handler.
                                                               Legacy list APIs read interview_schedule_trn.

interview_feedback_hdr/dtl →    im_feedback                  Partial — enterprise path via
                                                               interviewService.submitFeedback.

interview_panel_mstr       →    im_panel_assignments         Panel data sourced from legacy on schedule;
                                                               enterprise stores assignment separately.

client_mstr / project_mstr →    md_records (optional)        Parallel — legacy masters pages vs
 / hiring_manager_mstr          enterprise master data UI      enterprise Master Data module.

pc_workflows               ↔    wf_definitions               Overlap — platform toggles vs engine defs.

wf_tasks                   ↔    et_tasks                     Different scopes — workflow engine vs inbox.
```

### Status per pair

| Pair | Both active? | Replacing? | Synchronized? | Deprecated? | Migration-only? |
|------|-------------|------------|---------------|-------------|-----------------|
| req_mstr ↔ rm_requisitions | **Yes** | Enterprise intended | **Partial** (new writes only) | Neither marked | No |
| req_recruiter_map ↔ rm_recruiter_assignments | **Yes** | Enterprise intended | **Partial** | Neither | No |
| candidate_req_map ↔ rm_candidate_mappings | **Yes** | Enterprise intended | **Partial** | Neither | No |
| interview_schedule_trn ↔ im_interviews | **Yes** | Enterprise intended | **Partial** | Neither | No |
| cand_mstr ↔ (none) | Legacy only | N/A | N/A | N/A | Candidate master not migrated |

---

## §4 — Duplicate Data Detection (Section 9 detail)

### Requisition

**Stored in:** `req_mstr`, `rm_requisitions`

**Should both exist?** No for a single System of Record.

**Explanation:** Enterprise sprint designed `rm_requisitions` as governance SoR linked to workforce planning and workflow. Legacy ATS continues to create and query `req_mstr` independently. `recruitmentService.createFromApprovedPosition` inserts into both. Historical requisitions created only through legacy UI exist only in `req_mstr`. Recruiter Workspace reads only `rm_requisitions`.

---

### Recruiter Assignment

**Stored in:** `req_recruiter_map`, `rm_recruiter_assignments`

**Should both exist?** No.

**Explanation:** `assignRecruiter()` writes both when tables exist. `/my-requisitions` and `/recruiter-dashboard` count from `req_recruiter_map` only. Enterprise bundle reads `rm_recruiter_assignments` only.

---

### Candidate Pipeline / Mapping

**Stored in:** `candidate_req_map`, `rm_candidate_mappings`

**Should both exist?** No.

**Explanation:** Legacy candidate page and dashboard funnel use `candidate_req_map`. Enterprise recruitment bundle uses `rm_candidate_mappings`. Seed file does not populate enterprise pipeline. Legacy mappings are not backfilled.

---

### Interview

**Stored in:** `interview_schedule_trn`, `im_interviews`

**Should both exist?** No for single SoR.

**Explanation:** Legacy schedule/list/feedback pages use `interview_schedule_trn`. Enterprise interview module uses `im_interviews`. Legacy handler schedules into enterprise then optionally updates legacy transaction table.

---

### Interview Feedback

**Stored in:** `interview_feedback_hdr`, `interview_feedback_dtl`, `im_feedback`

**Should both exist?** No.

**Explanation:** Legacy feedback form writes hdr/dtl tables. Enterprise service can write `im_feedback`. No unified read path.

---

### Candidate Master

**Stored in:** `cand_mstr` only

**Should both exist?** Enterprise references `candidate_id` without a dedicated `rm_candidates` table.

**Explanation:** Candidate identity remains legacy. Enterprise mappings store foreign keys only.

---

### Workflow Tasks vs Enterprise Tasks

**Stored in:** `wf_tasks`, `et_tasks`

**Should both exist?** Yes, with clear boundaries — **but boundaries are not documented in UI**.

**Explanation:** `workflowService` manages `wf_tasks`. `taskService` manages `et_tasks` for cross-module inbox. Recruiter Workspace reads `et_tasks` only.

---

### Audit

**Stored in:** `md_enterprise_audit` (backend), `auditEvents` (frontend Zustand array)

**Should both exist?** No — should be one read/write path.

**Explanation:** Backend persists audit on enterprise mutations. Frontend appends to in-memory store via `auditRepository.create`. No API connects them. Recruiter activity timeline reads frontend store only (empty unless user actions in session).

---

### Master Data

**Stored in:** `client_mstr`, `project_mstr`, `hiring_manager_mstr`, `md_records`

**Should both exist?** No long-term.

**Explanation:** Legacy Master Management page uses legacy tables. Enterprise Master Data module uses `md_records`. No synchronization observed.

---

## Seed Data vs Legacy Operational Data

| Seed script | Tables populated | Not populated |
|-------------|------------------|---------------|
| `seedRecruitment.js` | `rm_requisitions`, `rm_recruiter_assignments` | `rm_candidate_mappings`, legacy tables |
| `seedInterviews.js` | `im_interviews`, `et_tasks` | `interview_schedule_trn`, legacy mappings |
| `seedOffers.js` | `om_*` | — |

Operational ATS data created through legacy UI populates **legacy tables only** unless mutation routes through enterprise legacy handlers.
