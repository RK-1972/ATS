# OPTALYNX MASTER DATA INVENTORY

**Sprint:** Enterprise Migration Sprint 1 — Master Data Migration  
**Type:** Analysis only (no application code or UI changes)  
**Environment audited:** `ats_dev` (PostgreSQL), frontend `VITE_API_MODE=live`  
**Audit date:** 2026-06-29  
**Status:** Official Master Data specification baseline for Optalynx

---

## Executive summary

Optalynx defines **35 Master Data entity types** stored in **`md_records`** (logical views `md_<entity_type>`). The enterprise API surface is **`/api/v1/master/*`**.

**Critical findings:**

| Finding | Severity |
|---------|----------|
| **`md_records` contains 0 rows** (all 35 entities empty) | P0 |
| Legacy screens use **hardcoded dropdowns** instead of Master Data APIs | P0 |
| Backend validators reference **`locations`** — **not a registered entity** (correct key: `work_locations`) | P0 |
| UI values (e.g. `HR Round`, `Full Time`) **do not match** seed template names (e.g. `Hiring Manager`, `Full-time`) | P1 |
| Several UI dropdowns (ATS stages, priorities, feedback outcomes) have **no Master Data entity defined** | P1 |

---

## Architecture reference

| Layer | Detail |
|-------|--------|
| **Physical table** | `md_records` |
| **Registry** | `md_entity_types` (35 rows — entity metadata only) |
| **History** | `md_record_history` |
| **Audit** | `md_enterprise_audit` |
| **Logical views** | `md_<entity_type>` (e.g. `md_interview_types`) |
| **Bundle API** | `GET /api/v1/master` |
| **Entity list API** | `GET /api/v1/master/:entityType` (kebab-case URL, snake_case key) |
| **CRUD / lifecycle** | POST/PUT/DELETE + publish/archive/rollback on `/api/v1/master/:entityType/:id` |
| **Import/export** | `/api/v1/master/:entityType/export`, `/import/preview`, `/import` |
| **Seed script (not executed in prod audit)** | `ats-backend/scripts/seedMasterData.js` |

---

## TASK 1 — Complete Master Data Inventory

**Current record count source:** `node scripts/masterDataInventoryCounts.js` against `ats_dev`.

### Organization domain

| Entity Name | Purpose | Database Table / View | API | Screens Using It | Current Count | Missing Records |
|-------------|---------|----------------------|-----|------------------|---------------|-----------------|
| **business_units** | Organizational BU hierarchy for requisitions, offers, reporting | `md_records` / `md_business_units` | `GET /api/v1/master/business-units` | Master Data UI; backend: recruitment create, offer create | **0** | All (seed: 3) |
| **departments** | Department dimension for workforce, requisitions, business rules | `md_records` / `md_departments` | `GET /api/v1/master/departments` | Master Data UI; Business Rules Simulator (with fallback); Workforce Planning validation | **0** | All (seed: 5) |
| **cost_centers** | Financial cost allocation | `md_records` / `md_cost_centers` | `GET /api/v1/master/cost-centers` | Master Data UI | **0** | All (seed: 3) |
| **legal_entities** | Legal employer entities | `md_records` / `md_legal_entities` | `GET /api/v1/master/legal-entities` | Master Data UI | **0** | All (seed: 2) |
| **delivery_units** | Delivery organization units | `md_records` / `md_delivery_units` | `GET /api/v1/master/delivery-units` | Master Data UI | **0** | All (seed: 2) |
| **practice_areas** | Practice / capability grouping | `md_records` / `md_practice_areas` | `GET /api/v1/master/practice-areas` | Master Data UI | **0** | All (seed: 2) |

### Workforce domain

| Entity Name | Purpose | Database Table / View | API | Screens Using It | Current Count | Missing Records |
|-------------|---------|----------------------|-----|------------------|---------------|-----------------|
| **grades** | Grade band for headcount, offers, rules, requisitions | `md_records` / `md_grades` | `GET /api/v1/master/grades` | Master Data UI; Business Rules Simulator (fallback); Workforce Planning validation; Offer validation | **0** | All (seed: 7) |
| **job_levels** | Job level taxonomy | `md_records` / `md_job_levels` | `GET /api/v1/master/job-levels` | Master Data UI | **0** | All (seed: 4) |
| **designations** | Job title designations | `md_records` / `md_designations` | `GET /api/v1/master/designations` | Master Data UI | **0** | All (seed: 3) |
| **employment_types** | Full-time / contract / intern classification | `md_records` / `md_employment_types` | `GET /api/v1/master/employment-types` | Master Data UI; Business Rules Simulator (fallback); RequisitionPage (hardcoded); recruitment/offer validation | **0** | All (seed: 3) + UI extras (`Full Time` vs `Full-time`) |
| **position_types** | New hire vs replacement | `md_records` / `md_position_types` | `GET /api/v1/master/position-types` | Master Data UI | **0** | All (seed: 2) |
| **workforce_categories** | Billable vs non-billable | `md_records` / `md_workforce_categories` | `GET /api/v1/master/workforce-categories` | Master Data UI | **0** | All (seed: 2) |

### Recruitment domain

| Entity Name | Purpose | Database Table / View | API | Screens Using It | Current Count | Missing Records |
|-------------|---------|----------------------|-----|------------------|---------------|-----------------|
| **skills** | Primary/secondary skills on requisitions & interviews | `md_records` / `md_skills` | `GET /api/v1/master/skills` | Master Data UI; recruitment & interview validation | **0** | All (seed: 3) |
| **skill_categories** | Skill grouping | `md_records` / `md_skill_categories` | `GET /api/v1/master/skill-categories` | Master Data UI | **0** | All (seed: 2) |
| **interview_types** | Interview round types (L1, HR, Client, etc.) | `md_records` / `md_interview_types` | `GET /api/v1/master/interview-types` | Master Data UI; **should** drive InterviewSchedulePage; interview schedule validation | **0** | All (seed: 3) + **6+ UI-only rounds** |
| **interview_modes** | F2F / video / telephonic | `md_records` / `md_interview_modes` | `GET /api/v1/master/interview-modes` | Master Data UI; interview validation (optional field) | **0** | All (seed: 3) |
| **candidate_sources** | Sourcing channel | `md_records` / `md_candidate_sources` | `GET /api/v1/master/candidate-sources` | Master Data UI; CandidatePage (hardcoded); map-candidate validation | **0** | All (seed: 3) + UI portals (`LinkedIn`, `Naukri`, `Career Portal`) |
| **vendor_partners** | Staffing vendor master | `md_records` / `md_vendor_partners` | `GET /api/v1/master/vendor-partners` | Master Data UI | **0** | All (seed: 2) |
| **referral_programs** | Referral program definitions | `md_records` / `md_referral_programs` | `GET /api/v1/master/referral-programs` | Master Data UI | **0** | All (seed: 1) |

### Geography domain

| Entity Name | Purpose | Database Table / View | API | Screens Using It | Current Count | Missing Records |
|-------------|---------|----------------------|-----|------------------|---------------|-----------------|
| **countries** | Country reference | `md_records` / `md_countries` | `GET /api/v1/master/countries` | Master Data UI | **0** | All (seed: 2) |
| **states** | State/province | `md_records` / `md_states` | `GET /api/v1/master/states` | Master Data UI | **0** | All (seed: 3) |
| **cities** | City reference | `md_records` / `md_cities` | `GET /api/v1/master/cities` | Master Data UI; Business Rules Simulator uses **cities** as location fallback (not `work_locations`) | **0** | All (seed: 6) |
| **work_locations** | Work / site locations for reqs & offers | `md_records` / `md_work_locations` | `GET /api/v1/master/work-locations` | Master Data UI; recruitment/offer validation (**via broken `locations` key**) | **0** | All (seed: 3) |
| **regions** | Geographic regions | `md_records` / `md_regions` | `GET /api/v1/master/regions` | Master Data UI | **0** | All (seed: 2) |
| **time_zones** | TZ reference | `md_records` / `md_time_zones` | `GET /api/v1/master/time-zones` | Master Data UI | **0** | All (seed: 2) |

### Financial domain

| Entity Name | Purpose | Database Table / View | API | Screens Using It | Current Count | Missing Records |
|-------------|---------|----------------------|-----|------------------|---------------|-----------------|
| **currencies** | Offer & budget currency | `md_records` / `md_currencies` | `GET /api/v1/master/currencies` | Master Data UI; Platform Budget console (hardcoded INR/USD/EUR); Offer validation | **0** | All (seed: 2) + UI `EUR` |
| **salary_bands** | Compensation bands | `md_records` / `md_salary_bands` | `GET /api/v1/master/salary-bands` | Master Data UI; Offer validation | **0** | All (seed: 2) |
| **budget_categories** | Budget classification | `md_records` / `md_budget_categories` | `GET /api/v1/master/budget-categories` | Master Data UI | **0** | All (seed: 2) |
| **cost_types** | Direct vs overhead cost | `md_records` / `md_cost_types` | `GET /api/v1/master/cost-types` | Master Data UI | **0** | All (seed: 2) |

### System domain

| Entity Name | Purpose | Database Table / View | API | Screens Using It | Current Count | Missing Records |
|-------------|---------|----------------------|-----|------------------|---------------|-----------------|
| **document_types** | Document classification | `md_records` / `md_document_types` | `GET /api/v1/master/document-types` | Master Data UI | **0** | All (seed: 2) |
| **notification_templates** | Notification templates | `md_records` / `md_notification_templates` | `GET /api/v1/master/notification-templates` | Master Data UI | **0** | All (seed: 2) |
| **email_templates** | Email templates | `md_records` / `md_email_templates` | `GET /api/v1/master/email-templates` | Master Data UI | **0** | All (seed: 2) |
| **offer_templates** | Offer letter templates | `md_records` / `md_offer_templates` | `GET /api/v1/master/offer-templates` | Master Data UI; Offer validation | **0** | All (seed: 2) |
| **calendar_types** | Business calendar types | `md_records` / `md_calendar_types` | `GET /api/v1/master/calendar-types` | Master Data UI | **0** | All (seed: 2) |
| **holiday_calendars** | Holiday calendars | `md_records` / `md_holiday_calendars` | `GET /api/v1/master/holiday-calendars` | Master Data UI | **0** | All (seed: 2) |

**Total published master records in DB:** **0 / ~97 seed baseline**

---

## TASK 2 — Frontend hardcoded dropdown audit

Legend: **MD** = existing Master Data entity. **GAP** = no entity defined in `md_entity_types` (requires schema/spec decision).

### Legacy ATS pages (highest migration priority)

| File | Line(s) | Hardcoded values | Should use (MD entity) |
|------|---------|------------------|------------------------|
| `pages/InterviewSchedulePage.jsx` | 456–478 | `L1 Technical`, `L1 Non-Technical`, `L2 Technical`, `L2 Non-Technical`, `HR Round`, `Client Round` | **interview_types** |
| `pages/CandidatePage.jsx` | 7–57 | Full ATS status list (Applied → Joined incl. Cleared/Rejected/On Hold variants) | **GAP — `ats_pipeline_stages`** (or Workflow config; not in current MD model) |
| `pages/CandidatePage.jsx` | 1370–1388 | Same array rendered as `<option>` per pipeline row | **GAP — `ats_pipeline_stages`** |
| `pages/CandidatePage.jsx` | 1007–1019 | `LinkedIn`, `Naukri`, `Referral`, `Career Portal` | **candidate_sources** |
| `pages/RequisitionPage.jsx` | 348–356 | `Full Time`, `Contract`, `Intern` | **employment_types** (align naming to published MD names) |
| `pages/RequisitionPage.jsx` | 368–376 | `High`, `Medium`, `Low` | **GAP — `priority_levels`** |
| `pages/InterviewPanelPage.jsx` | 491–507 | `Technical`, `Non Technical`, `Managerial`, `HR`, `Client` | **GAP — `interviewer_types`** (or map subset of **interview_types**) |
| `pages/InterviewFeedbackPage.jsx` | 360–374 | `Technical`, `Functional`, `Managerial`, `HR` | **GAP — `interview_areas`** or **skill_categories** |
| `pages/InterviewFeedbackPage.jsx` | 404–418 | `Excellent`, `Good`, `Average`, `Poor` | **GAP — `feedback_ratings`** |
| `pages/InterviewFeedbackPage.jsx` | 587–597 | `Selected`, `Rejected`, `Hold` | **GAP — `interview_outcomes`** |

### Administration & reporting

| File | Line(s) | Hardcoded values | Should use (MD entity) |
|------|---------|------------------|------------------------|
| `pages/UserManagementPage.jsx` | 279–299 | `Admin`, `Hiring Manager`, `TA Leader`, `TA Lead`, `Recruiter`, `Interviewer` | **Platform Configuration — roles** (not MD; document separately) |
| `pages/ReportsAnalyticsPage.jsx` | 206–222 | `today`, `week`, `month`, `quarter`, `year` | N/A (UI date presets, not MD) |

### Enterprise modules (partial MD / fallbacks)

| File | Line(s) | Hardcoded values | Should use (MD entity) |
|------|---------|------------------|------------------------|
| `components/business-rules/RuleSimulatorPanel.jsx` | 23–27 | FALLBACK departments: Engineering, Sales, Operations, Finance | **departments** (uses MD when published; fallback when empty) |
| `components/business-rules/RuleSimulatorPanel.jsx` | 30–37 | FALLBACK grades: G6–G12 | **grades** |
| `components/business-rules/RuleSimulatorPanel.jsx` | 40–46 | FALLBACK locations: Bangalore, Mumbai, Delhi, Hyderabad, Chennai, Pune | **work_locations** (currently reads **cities** — misaligned) |
| `components/business-rules/RuleSimulatorPanel.jsx` | 49–52 | FALLBACK employment: Full-time, Contract, Intern | **employment_types** |
| `components/business-rules/RuleDesignerForm.jsx` | 17–26 | Rule categories: Budget, Approval, SLA, etc. | Rule metadata (not MD) |
| `components/business-rules/RuleDesignerForm.jsx` | 28 | Priorities: High, Medium, Low | **GAP — `priority_levels`** |
| `components/business-rules/RuleDesignerForm.jsx` | 30 | Statuses: Draft, Pending Approval, Active | Rule lifecycle (not MD) |
| `components/platform-config/BudgetGovernanceConsole.jsx` | 189–191 | `INR`, `USD`, `EUR` | **currencies** |
| `components/platform-config/AiGovernanceConsole.jsx` | 136–157 | AI providers & model names | Platform config (not MD) |
| `components/hiring-control-tower/StageApprovalPanel.jsx` | 220–222 | `Normal`, `High`, `Urgent` | **GAP — `priority_levels`** |

### Recruiter / pipeline display constants (not dropdowns but hardcoded domain values)

| File | Line(s) | Hardcoded values | Should use |
|------|---------|------------------|------------|
| `enterprise/recruiterSelectors.js` | 1–8 | PIPELINE_STAGES: Applied, Screening, L1/L2/Client Interview, Offer, Joined | **GAP — `ats_pipeline_stages`** or derived from workflow |
| `pages/recruiter-home/recruiterHomeViewModel.js` | 15 | LIFECYCLE_STAGES: Sourcing, Screening, Interviewing, Offer, Filled | Display taxonomy (not MD) |

### Correctly driven by API (not hardcoded business values)

| File | Notes |
|------|-------|
| `pages/RequisitionPage.jsx` | 213–334 — Client, Project, Hiring Manager, Recruiter from enterprise form APIs |
| `pages/InterviewSchedulePage.jsx` | 430–443 — Interviewers from `/active-interviewers` |
| `pages/master-data/*` | All entity grids from `/api/v1/master` |
| `components/master-data/MasterDataToolbar.jsx` | Status filters are **record lifecycle** enums (Valid UI pattern) |

---

## TASK 3 — Backend Master Data validation audit

### Validators identified

| Service | Method | Fields validated | Entity type key used | MD exists in DB? | Mismatch |
|---------|--------|------------------|----------------------|------------------|----------|
| **recruitmentService** | `validateMasterDataReferences` | department, grade, location, primary_skill, employment_type, source_type, business_unit | departments, grades, **locations**, skills, employment_types, candidate_sources, business_units | **0 rows all** | **`locations` is invalid entity** — registry has `work_locations` only |
| **interviewService** | `validateMasterDataReferences` | round_type, interview_mode, primary_skill | interview_types, interview_modes, skills | **0 rows all** | UI sends `HR Round` etc.; seed has `Hiring Manager` not `HR Round` |
| **offerManagementService** | `validateMasterDataReferences` | grade, location, employment_type, currency, template_code, business_unit, salary_band_code | grades, **locations**, employment_types, currencies, offer_templates, business_units, salary_bands | **0 rows all** | **`locations` invalid entity key** |
| **workforcePlanningService** | `validateMasterDataReferences` | department, grade | departments, grades | **0 rows all** | Validation correct; data missing |

### Validation call sites

| Operation | Service | Trigger |
|-----------|---------|---------|
| Create requisition (enterprise) | recruitmentService | `createFromApprovedPosition` / legacy create |
| Map candidate | recruitmentService | `mapCandidate` — validates `source_type` |
| Schedule interview | interviewService | `scheduleInterview` — validates `round_type` |
| Create offer | offerManagementService | `createOffer` |
| Create budget request | workforcePlanningService | budget request create |

### Business rules engine

`businessRulesService.simulateRules` does **not** directly query Master Data. Rules may **reference** department/grade values passed in context from callers. Empty MD causes rule simulations to use UI fallbacks or free-text that may not match rule definitions.

### Backend hardcoded mappings (not MD lookups)

| File | Issue |
|------|-------|
| `interviewService.js` `stageNameForRound()` | Hardcoded switch on round names (`HR Round`, `L1 Technical`, etc.) |

---

## TASK 4 — SQL to populate missing Master Data

**DO NOT EXECUTE without change control.**  
Combines baseline seed (`seedMasterData.js`) plus **UI-aligned supplement** records.

```sql
-- OPTALYNX MASTER DATA INVENTORY — Baseline + UI supplement
-- Target: md_records (entity_type must exist in md_entity_types)
-- Status: Published / Active for immediate validation use
-- DO NOT EXECUTE IN PRODUCTION WITHOUT REVIEW

BEGIN;

-- Helper: id format md-{entity_type}-{code-slug}

-- ============================================================
-- ORGANIZATION (seed baseline)
-- ============================================================
INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-business_units-bu-eng', 'business_units', 'BU-ENG', 'Engineering BU', 'Primary engineering delivery unit', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-business_units-bu-del', 'business_units', 'BU-DEL', 'Delivery Excellence', 'Global delivery operations', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-business_units-bu-sal', 'business_units', 'BU-SAL', 'Sales & Marketing', 'Revenue and client acquisition', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-departments-dept-eng', 'departments', 'DEPT-ENG', 'Engineering', 'Software product engineering', 'Active', 1.0, 'Published', '["Workforce Planning","Requisitions","Business Rules"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-departments-dept-qa', 'departments', 'DEPT-QA', 'Quality Assurance', 'Quality engineering and testing', 'Active', 1.0, 'Published', '["Workforce Planning","Requisitions","Business Rules"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-departments-dept-hr', 'departments', 'DEPT-HR', 'Human Resources', 'People operations and TA', 'Active', 1.0, 'Published', '["Workforce Planning","Requisitions","Business Rules"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-departments-dept-fin', 'departments', 'DEPT-FIN', 'Finance', 'Financial planning and control', 'Active', 1.0, 'Published', '["Workforce Planning","Requisitions","Business Rules"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-departments-dept-sal', 'departments', 'DEPT-SAL', 'Sales', 'Enterprise sales division', 'Active', 1.0, 'Published', '["Workforce Planning","Requisitions","Business Rules"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- WORKFORCE (seed + UI naming alignment)
-- ============================================================
INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-grades-g6', 'grades', 'G6', 'Grade G6', 'Individual contributor — entry', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-grades-g7', 'grades', 'G7', 'Grade G7', 'Individual contributor — mid', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-grades-g8', 'grades', 'G8', 'Grade G8', 'Senior individual contributor', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-grades-g9', 'grades', 'G9', 'Grade G9', 'Lead / specialist', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-grades-g10', 'grades', 'G10', 'Grade G10', 'Manager / senior lead', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-grades-g11', 'grades', 'G11', 'Grade G11', 'Senior manager', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-grades-g12', 'grades', 'G12', 'Grade G12', 'Director level', 'Active', 1.0, 'Published', '["Business Rules","Requisitions","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-employment_types-et-ft', 'employment_types', 'ET-FT', 'Full-time', 'Permanent full-time employment', 'Active', 1.0, 'Published', '["Requisitions","Business Rules","Workforce Planning"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-employment_types-et-ct', 'employment_types', 'ET-CT', 'Contract', 'Fixed-term contract', 'Active', 1.0, 'Published', '["Requisitions","Business Rules","Workforce Planning"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-employment_types-et-in', 'employment_types', 'ET-IN', 'Intern', 'Internship engagement', 'Active', 1.0, 'Published', '["Requisitions","Business Rules","Workforce Planning"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  -- UI alias record for legacy RequisitionPage label (until UI migrated)
  ('md-employment_types-et-ft-alias', 'employment_types', 'ET-FT-UI', 'Full Time', 'UI alias — migrate to Full-time', 'Active', 1.0, 'Published', '["Requisitions"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- RECRUITMENT — interview_types (seed + InterviewSchedulePage UI)
-- ============================================================
INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-interview_types-it-l1', 'interview_types', 'IT-L1', 'L1 Technical', 'First-level technical interview', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_types-it-l1nt', 'interview_types', 'IT-L1NT', 'L1 Non-Technical', 'First-level non-technical interview', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_types-it-l2', 'interview_types', 'IT-L2', 'L2 Technical', 'Second-level technical interview', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_types-it-l2nt', 'interview_types', 'IT-L2NT', 'L2 Non-Technical', 'Second-level non-technical interview', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_types-it-hr', 'interview_types', 'IT-HR', 'HR Round', 'HR interview round', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_types-it-client', 'interview_types', 'IT-CLIENT', 'Client Round', 'Client interview round', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_types-it-hm', 'interview_types', 'IT-HM', 'Hiring Manager', 'HM culture and fit round', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-interview_modes-im-ftf', 'interview_modes', 'IM-FTF', 'Face to Face', 'In-person interview', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_modes-im-vid', 'interview_modes', 'IM-VID', 'Video', 'Remote video interview', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-interview_modes-im-tel', 'interview_modes', 'IM-TEL', 'Telephonic', 'Phone screening', 'Active', 1.0, 'Published', '["Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

-- candidate_sources (seed + CandidatePage UI)
INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-candidate_sources-cs-port', 'candidate_sources', 'CS-PORT', 'Job Portal', 'External job board sourcing', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-candidate_sources-cs-ref', 'candidate_sources', 'CS-REF', 'Employee Referral', 'Internal referral program', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-candidate_sources-cs-vend', 'candidate_sources', 'CS-VEND', 'Vendor', 'Staffing vendor submission', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-candidate_sources-cs-li', 'candidate_sources', 'CS-LI', 'LinkedIn', 'LinkedIn sourcing', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-candidate_sources-cs-naukri', 'candidate_sources', 'CS-NAUKRI', 'Naukri', 'Naukri job portal', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-candidate_sources-cs-ref-ui', 'candidate_sources', 'CS-REF-UI', 'Referral', 'UI alias for referral', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-candidate_sources-cs-career', 'candidate_sources', 'CS-CAREER', 'Career Portal', 'Company career portal', 'Active', 1.0, 'Published', '["Recruitment"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-skills-sk-java', 'skills', 'SK-JAVA', 'Java', 'Core Java development', 'Active', 1.0, 'Published', '["Recruitment","AI","Reports"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-skills-sk-react', 'skills', 'SK-REACT', 'React', 'Frontend React framework', 'Active', 1.0, 'Published', '["Recruitment","AI","Reports"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-skills-sk-aws', 'skills', 'SK-AWS', 'AWS', 'Amazon Web Services cloud', 'Active', 1.0, 'Published', '["Recruitment","AI","Reports"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- GEOGRAPHY — work_locations (fixes broken `locations` validator after backend fix)
-- ============================================================
INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-work_locations-wl-blr-hq', 'work_locations', 'WL-BLR-HQ', 'Bangalore HQ', 'Head office — Bangalore', 'Active', 1.0, 'Published', '["Requisitions","Offer","Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-work_locations-wl-hyd-dc', 'work_locations', 'WL-HYD-DC', 'Hyderabad DC', 'Delivery center — Hyderabad', 'Active', 1.0, 'Published', '["Requisitions","Offer","Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-work_locations-wl-mum-ro', 'work_locations', 'WL-MUM-RO', 'Mumbai RO', 'Regional office — Mumbai', 'Active', 1.0, 'Published', '["Requisitions","Offer","Interview Management"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-cities-blr', 'cities', 'BLR', 'Bangalore', 'Bengaluru, Karnataka', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-cities-hyd', 'cities', 'HYD', 'Hyderabad', 'Hyderabad, Telangana', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-cities-mum', 'cities', 'MUM', 'Mumbai', 'Mumbai, Maharashtra', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-cities-pun', 'cities', 'PUN', 'Pune', 'Pune, Maharashtra', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-cities-del', 'cities', 'DEL', 'Delhi', 'New Delhi, NCR', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-cities-che', 'cities', 'CHE', 'Chennai', 'Chennai, Tamil Nadu', 'Active', 1.0, 'Published', '["Platform Configuration"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- FINANCIAL
-- ============================================================
INSERT INTO md_records (id, entity_type, code, name, description, status, version, version_status, used_by, created_by, modified_by)
VALUES
  ('md-currencies-inr', 'currencies', 'INR', 'Indian Rupee', 'INR — primary operating currency', 'Active', 1.0, 'Published', '["Platform Configuration","Workforce Planning","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-currencies-usd', 'currencies', 'USD', 'US Dollar', 'USD — international billing', 'Active', 1.0, 'Published', '["Platform Configuration","Workforce Planning","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-currencies-eur', 'currencies', 'EUR', 'Euro', 'EUR — platform UI currency', 'Active', 1.0, 'Published', '["Platform Configuration","Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-offer_templates-ot-std', 'offer_templates', 'OT-STD', 'Standard Offer', 'Default offer letter template', 'Active', 1.0, 'Published', '["Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-offer_templates-ot-exec', 'offer_templates', 'OT-EXEC', 'Executive Offer', 'Leadership offer template', 'Active', 1.0, 'Published', '["Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-salary_bands-sb-g8', 'salary_bands', 'SB-G8', 'G8 Band', 'Salary band for Grade G8', 'Active', 1.0, 'Published', '["Offer"]', 'Migration Sprint 1', 'Migration Sprint 1'),
  ('md-salary_bands-sb-g10', 'salary_bands', 'SB-G10', 'G10 Band', 'Salary band for Grade G10', 'Active', 1.0, 'Published', '["Offer"]', 'Migration Sprint 1', 'Migration Sprint 1')
ON CONFLICT (id) DO NOTHING;

-- Publish history rows (sample — extend for all inserted ids in production script)
INSERT INTO md_record_history (record_id, entity_type, version, status, changed_by, reason)
SELECT id, entity_type, 1.0, 'Published', 'Migration Sprint 1', 'Initial publish — Sprint 1 inventory'
FROM md_records
WHERE created_by = 'Migration Sprint 1'
ON CONFLICT DO NOTHING;

COMMIT;

-- Post-load verification (read-only)
-- SELECT entity_type, COUNT(*) FROM md_records WHERE is_deleted = FALSE GROUP BY entity_type ORDER BY 1;
-- SELECT code, name FROM md_interview_types ORDER BY name;
```

**Note:** Full 97-record seed is available via `node scripts/seedMasterData.js`. The SQL above prioritizes **validation-blocking** entities plus **UI-aligned supplements**. Remaining seed entities (cost_centers, legal_entities, vendor_partners, system templates, etc.) should be loaded from the seed script in Sprint 1 execution phase.

**Backend fix required (separate sprint, not in this doc):** Change `entityType: "locations"` → `"work_locations"` in `recruitmentService.js` and `offerManagementService.js`.

---

## TASK 5 — Master Data coverage by module

| Module | Coverage | Details |
|--------|----------|---------|
| **Recruiter Cockpit** | **Does not use Master Data** | Reads `/api/v1/recruitment/my-dashboard` only; no MD dropdowns |
| **Candidate** | **Does not use Master Data** | Hardcoded ATS stages & source types; backend validates `source_type` on map |
| **Interview Schedule** | **Does not use Master Data** | Hardcoded rounds; backend validates `interview_types` |
| **Interview Feedback** | **Does not use Master Data** | Hardcoded areas, ratings, outcomes; backend feedback path does not validate MD for these fields |
| **Offer** | **Partially uses Master Data** | Backend validates grades, locations*, employment_types, currencies, offer_templates, salary_bands — no UI page wired |
| **Requisition (legacy page)** | **Partially uses Master Data** | Enterprise create validates MD; legacy form hardcodes employment & priority |
| **Requisition (enterprise / store)** | **Partially uses Master Data** | Uses API form options for clients/projects; MD validation on write |
| **Hiring Control Tower** | **Partially uses Master Data** | Indirect via platform config, business rules, workforce; hardcoded urgency in approval panel |
| **Business Rules** | **Partially uses Master Data** | Simulator reads MD with **fallback arrays** when empty; designer categories hardcoded |
| **Platform Configuration** | **Partially uses Master Data** | Budget currency hardcoded in UI; should use **currencies** MD |
| **Workforce Planning** | **Partially uses Master Data** | Backend validates departments & grades; UI reads live workforce API |
| **Master Data admin** | **Uses Master Data** | Fully wired to `/api/v1/master` |

---

## Recommended migration sequence (Sprint 1 execution — not in scope of this analysis)

1. Load baseline MD (seed script or TASK 4 SQL) into `ats_dev` / staging  
2. Fix backend `locations` → `work_locations` entity key  
3. Publish MD records (`version_status = Published`)  
4. Wire **InterviewSchedulePage** round dropdown to `GET /api/v1/master/interview-types`  
5. Wire **CandidatePage** source dropdown to `candidate_sources`  
6. Define spec for **GAP entities** (ATS stages, priorities, feedback outcomes) — Workflow vs new MD types  
7. Remove RuleSimulatorPanel fallbacks once MD is populated  
8. Align UI labels to canonical MD `name` values (eliminate alias records)

---

## Appendix A — Entity count summary

| Domain | Entities | DB count | Seed baseline count |
|--------|----------|----------|---------------------|
| Organization | 6 | 0 | 17 |
| Workforce | 6 | 0 | 21 |
| Recruitment | 7 | 0 | 17 |
| Geography | 6 | 0 | 18 |
| Financial | 4 | 0 | 8 |
| System | 6 | 0 | 12 |
| **Total** | **35** | **0** | **~97** |

---

## Appendix B — Audit tools used

| Tool | Purpose |
|------|---------|
| `ats-backend/scripts/masterDataInventoryCounts.js` | Per-entity `md_records` counts |
| Codebase grep / static analysis | Hardcoded dropdown discovery |
| `recruitmentService.js`, `interviewService.js`, `offerManagementService.js`, `workforcePlanningService.js` | Validation mapping |

---

*End of OPTALYNX MASTER DATA INVENTORY*
