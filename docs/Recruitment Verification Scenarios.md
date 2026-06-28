# Recruitment Management — Verification Scenarios

End-to-end verification for Sprint 6 enterprise recruitment integration.

## Prerequisites

1. PostgreSQL with Sprints 1–6 migrations and seeds applied
2. Backend running on port 5000
3. Admin JWT for API calls
4. Seeded approved position `AP-2026-0076` and requisition `REQ-2026-1187`

## Scenario 1 — Requisition from Approved Position

**Steps**

1. `GET /api/v1/workforce` — confirm `AP-2026-0089` exists with status `Active`
2. `POST /api/v1/recruitment/requisitions` with `{ "approved_position_id": "AP-2026-0089" }`
3. Or via Workforce UI: create requisition from Approved Positions catalogue

**Expected**

- HTTP 201 with `requisitionId` like `REQ-2026-xxxx`
- `rm_requisitions` row with inherited department, grade, budget from approved position
- `REQUISITION` workflow instance created
- Audit event `RequisitionCreated`
- No duplicate manual data entry required

## Scenario 2 — Block Direct Requisition Creation

**Steps**

1. `POST /requisition` without `approved_position_id` (legacy form payload)

**Expected**

- HTTP 400: requisitions must originate from Workforce Planning approved positions

## Scenario 3 — Requisition Approval via Workflow

**Steps**

1. `POST /api/v1/recruitment/requisitions/REQ-2026-1187/approve` with comment

**Expected**

- Status moves to `Approved` or `Open`
- Workflow instance advanced
- Audit `RequisitionApproved`
- Business rules evaluated for routing

## Scenario 4 — Recruiter Assignment

**Steps**

1. `POST /api/v1/recruitment/requisitions/REQ-2026-1187/assign-recruiter` with `{ "recruiter_code": "EMP-1042" }`
2. Or legacy: `POST /assign-recruiter` with `{ "req_id": <id>, "recruiter_code": "EMP-1042" }`

**Expected**

- `rm_recruiter_assignments` row created
- Workflow advanced to recruiter assignment stage
- Audit `RecruiterAssigned`
- Recruiter assignment rules evaluated

## Scenario 5 — Candidate Mapping

**Steps**

1. Create candidate via `POST /candidate` (legacy)
2. `POST /api/v1/recruitment/candidate-mappings` with `{ "candidate_id": 1, "requisition_code": "REQ-2026-1187", "source_type": "LinkedIn" }`

**Expected**

- Duplicate candidate rule evaluated
- `CANDIDATE` workflow instance started
- `rm_candidate_mappings` row created
- Audit `CandidateMapped`

## Scenario 6 — Pipeline Stage Change

**Steps**

1. `PUT /api/v1/recruitment/candidate-mappings/1/stage` with `{ "stage_name": "L1 Technical Cleared" }`
2. Or legacy: `PUT /update-ats-stage/1`

**Expected**

- Stage updated in enterprise and legacy tables (when present)
- Workflow advanced
- Offer routing rules evaluated for offer-related stages
- Audit `StageChanged` or `CandidateShortlisted`

## Scenario 7 — Candidate Rejection

**Steps**

1. Update stage to `L1 Technical Rejected`

**Expected**

- Workflow reject action
- Audit `CandidateRejected`
- Pipeline history records transition

## Scenario 8 — Master Data Validation

**Steps**

1. Map candidate with invalid `source_type` not in Master Data

**Expected**

- HTTP 400 with Master Data validation error

## Scenario 9 — Module Disabled Guard

**Steps**

1. Disable recruitment module in Platform Configuration
2. Attempt any recruitment operation

**Expected**

- HTTP 400: module disabled

## Scenario 10 — Frontend Bootstrap (No UI Changes)

**Steps**

1. Start frontend with `VITE_API_MODE=live`
2. Inspect Enterprise Store after bootstrap

**Expected**

- `recruitment` slice populated with requisitions from API
- Existing pages unchanged; enterprise governance flows use store actions

## End-to-End Flow

```
Workforce Planning (approve budget)
  → Approved Position catalogue
  → createRequisition (Workforce / Recruitment API)
  → REQUISITION workflow (TA review → approved)
  → assignRecruiter
  → mapCandidate (CANDIDATE workflow)
  → updateStage through pipeline
  → Hiring Control Tower stages reflect workflow state
```

## Re-seed

```bash
cd ats-backend
npm run seed:recruitment
npm run seed:workforce
```
