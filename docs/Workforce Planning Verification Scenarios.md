# Workforce Planning — Verification Scenarios

Manual and API verification for Sprint 5 production integration.

## Prerequisites

1. PostgreSQL running with `.env` configured in `ats-backend`
2. All migrations and seeds applied (Sprints 1–5)
3. Backend running on port 5000
4. Valid admin JWT for API calls

## Scenario 1 — Load Workforce Bundle

**Steps**

1. `GET /api/v1/workforce` with admin token
2. Start frontend with `VITE_API_MODE=live`

**Expected**

- Response includes `config.approval_queue`, `config.approved_positions`, `config.dashboard`
- Frontend Workforce Planning screens render without mock data
- `bootstrap.js` populates `workforce` in Enterprise Store

## Scenario 2 — Budget Approval with Business Rules Routing

**Steps**

1. Pick a queue item with status `Pending TA Lead` (e.g. from seed)
2. `POST /api/v1/workforce/budget-requests/{id}/approve` with `{ "comment": "Approved for Q3" }`

**Expected**

- If rules require Finance: status becomes `Pending Finance`, approver set to Finance, audit `BudgetRouted`
- If rules allow direct approval: status `Approved`, new entry in `approved_positions`, audit `BudgetApproved` + `PositionApproved`
- Workflow instance created/linked (`workflow_instance_id` on request)
- `wp_position_lifecycle` row on final approval

## Scenario 3 — Budget Rejection

**Steps**

1. `POST /api/v1/workforce/budget-requests/{id}/reject` with comment

**Expected**

- Status `Rejected` in bundle and `wp_budget_requests`
- Workflow advanced with reject action (if instance exists)
- Audit event `BudgetRejected`

## Scenario 4 — Send Back

**Steps**

1. `POST /api/v1/workforce/budget-requests/{id}/send-back`

**Expected**

- Status `Sent Back`, `current_approver` = Hiring Manager
- Audit event `BudgetSentBack`

## Scenario 5 — Clarification via Workflow Engine

**Steps**

1. `POST /api/v1/workforce/budget-requests/{id}/request-clarification` with comments
2. `POST /api/v1/workforce/budget-requests/{id}/submit-clarification` with response

**Expected**

- Workflow instance clarification cycle in `wf_history`
- Request status `Clarification Requested` then resumed pending state
- Audit `ClarificationRequested` and `ClarificationSubmitted`

## Scenario 6 — Create Requisition

**Steps**

1. Approve a budget request to create an approved position
2. `POST /api/v1/workforce/approved-positions/{positionId}/requisitions`

**Expected**

- `requisitions_created` incremented on position
- `wp_position_lifecycle` event `RequisitionCreated`
- Response includes `requisitionId` and `hiringProcessUpdate`
- Frontend store updates `hiringProcess.linkedRequisitionId`

## Scenario 7 — Master Data Validation

**Steps**

1. Modify draft to use invalid department (via import or direct DB edit)
2. Attempt approve

**Expected**

- HTTP 400 with Master Data validation error
- No approval or audit event

## Scenario 8 — Publish & Normalized Sync

**Steps**

1. Modify draft bundle
2. `POST /api/v1/workforce/publish` with payload
3. Query `wp_budget_requests`, `wp_approved_positions`, `wp_department_headcount`

**Expected**

- `wp_config_state` draft = published, version incremented
- Snapshot in `wp_bundle_snapshots`
- Normalized tables reflect published data
- Audit `WorkforcePlanPublished`

## Scenario 9 — Module Disabled Guard

**Steps**

1. Disable recruitment module in Platform Configuration
2. Attempt budget approval

**Expected**

- HTTP 400: module disabled message

## Scenario 10 — Frontend End-to-End (No UI Changes)

**Steps**

1. Open Workforce Planning in live mode
2. Approve, reject, or create requisition from existing UI actions

**Expected**

- Toast messages from API
- Store updates asynchronously
- Local audit events published in Enterprise Store
- No React component or route changes required

## Re-seed After Testing

```bash
cd ats-backend
npm run seed:workforce
```

Use if bundle or workflow instances were mutated during verification.
