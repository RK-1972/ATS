# Enterprise Offer Management — Verification Scenarios

## Prerequisites

1. Sprints 1–8 migrations and seeds applied
2. Seeded offer `OFF-2026-00482` with finance approval pending
3. Valid JWT

## Scenario 1 — Create Offer from Recruitment Context

**Steps**

1. `POST /api/v1/offers` with:
   ```json
   {
     "requisition_code": "REQ-2026-1187",
     "approved_position_id": "AP-2026-0076",
     "mapping_id": 12,
     "candidate_id": 42,
     "candidate_name": "Ananya Reddy",
     "offered_ctc": 2100000,
     "grade": "L5",
     "department": "Engineering"
   }
   ```

**Expected**

- Offer created in Draft status
- Compensation row with CTC breakdown
- `OFFER` workflow instance started
- Prepare Offer task in inbox
- Audit `OfferCreated`
- Metadata inherited from requisition/position

## Scenario 2 — Submit Offer with Budget Exception

**Steps**

1. `POST /api/v1/offers/OFF-2026-00482/submit`

**Expected**

- Status → Pending Approval
- Approval steps created (HM, Finance, Leadership based on rules)
- Tasks for each approval step
- If variance > 10%: audit `BudgetExceptionTriggered`
- Audit `OfferSubmitted`

## Scenario 3 — Finance Approval

**Steps**

1. `POST /api/v1/offers/OFF-2026-00482/approve` with `{ "approval_step": "Finance Approval", "comment": "Approved with exception" }`

**Expected**

- Finance approval marked Approved
- Finance task completed
- Workflow advanced
- Audit `FinanceApproved`

## Scenario 4 — Leadership Approval & Full Approval

**Steps**

1. Approve Leadership Approval step
2. Verify all approvals complete

**Expected**

- Offer status → Approved
- Workflow at approved stage
- Audit `LeadershipApproved`

## Scenario 5 — Negotiate Offer

**Steps**

1. `POST /api/v1/offers/:id/negotiate` with `{ "proposed_ctc": 1950000, "notes": "Candidate counter" }`

**Expected**

- Negotiation round recorded
- Review Negotiation task created
- Rules evaluated for negotiation threshold

## Scenario 6 — Revise Offer

**Steps**

1. `POST /api/v1/offers/:id/revise` with `{ "offered_ctc": 1950000, "reason": "Post-negotiation revision" }`

**Expected**

- Version incremented
- Revision snapshot in `om_offer_revisions`
- Variance recalculated

## Scenario 7 — Release Offer

**Steps**

1. `POST /api/v1/offers/:id/release` with `{ "template_code": "OT-001" }`

**Expected**

- Status → Released
- Document row created
- Follow-up Acceptance task created
- Workflow advanced to released
- Audit `OfferReleased`

## Scenario 8 — Accept Offer

**Steps**

1. `POST /api/v1/offers/:id/accept`

**Expected**

- Status → Accepted
- Acceptance record updated
- Follow-up task completed
- Audit `OfferAccepted`

## Scenario 9 — Decline / Withdraw

**Steps**

1. `POST /api/v1/offers/:id/reject` with reason
2. Or `POST /api/v1/offers/:id/withdraw`

**Expected**

- Status Declined or Withdrawn
- Audit `OfferRejected` or `OfferWithdrawn`

## Scenario 10 — Clarification Cycle

**Steps**

1. `POST /api/v1/offers/:id/request-clarification`
2. `POST /api/v1/offers/:id/submit-clarification`

**Expected**

- Workflow clarification cycle in `wf_history`
- Offer workflow resumes

## Scenario 11 — Frontend Bootstrap

**Steps**

1. Start with `VITE_API_MODE=live`

**Expected**

- `offers` slice populated in Enterprise Store
- HCT mock offer stages align with seeded offer state
- No UI component changes required

## End-to-End Hiring Lifecycle

```
Workforce Planning → Recruitment → Interview → Offer Draft
  → Budget Validation (rules) → Finance/Leadership Approval (tasks + workflow)
  → Release → Acceptance → Pre-Onboarding (joined stage in HCT)
```

## Re-seed

```bash
cd ats-backend
npm run seed:offers
```
