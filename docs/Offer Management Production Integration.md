# Enterprise Offer Management — Production Integration (Backend Sprint 8)

PostgreSQL-backed Offer Governance completing the OPTALYNX hiring lifecycle.

## Overview

Sprint 8 delivers enterprise Offer Management — not a letter generator, but a governance module where creation, negotiation, approval, budget validation, revisions, and release execute through the Workflow Engine and Business Rules Engine.

UI, routing, and React components are unchanged.

## Database Schema

| Table | Purpose |
|-------|---------|
| `om_offers` | Core offer record with recruitment links |
| `om_offer_compensation` | CTC breakdown |
| `om_offer_approvals` | Approval chain steps |
| `om_offer_negotiations` | Negotiation rounds |
| `om_offer_revisions` | Version history snapshots |
| `om_offer_documents` | Offer letter documents |
| `om_offer_acceptance` | Candidate response |
| `om_offer_history` | Lifecycle events |

**Statuses:** Draft, Pending Approval, Approved, Released, Accepted, Declined, Withdrawn, Expired

Migration: `migrations/008_offer_management_schema.sql`

## Migration & Seed

```bash
cd ats-backend
npm run migrate:offers
npm run seed:offers
```

Seed `OFF-2026-00482` aligns with Hiring Control Tower: 21 LPA offer vs 18 LPA budget (16.7% variance).

## REST API

Base path: `/api/v1/offers`  
Auth: Bearer JWT

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/offers` | Offer bundle |
| GET | `/api/v1/offers/:offerId` | Single offer |
| POST | `/api/v1/offers` | Create draft (links to position/requisition/candidate) |
| POST | `/api/v1/offers/:offerId/submit` | Submit for approval |
| POST | `/api/v1/offers/:offerId/approve` | Approve step (Finance/Leadership/HM) |
| POST | `/api/v1/offers/:offerId/negotiate` | Record negotiation |
| POST | `/api/v1/offers/:offerId/revise` | Revise CTC with version history |
| POST | `/api/v1/offers/:offerId/release` | Release to candidate |
| POST | `/api/v1/offers/:offerId/accept` | Candidate acceptance |
| POST | `/api/v1/offers/:offerId/reject` | Candidate decline |
| POST | `/api/v1/offers/:offerId/withdraw` | Withdraw offer |
| POST | `/api/v1/offers/:offerId/request-clarification` | Workflow clarification |
| POST | `/api/v1/offers/:offerId/submit-clarification` | Submit clarification |

## Workflow Integration

`OFFER` workflow stages: draft → hm_review → finance → approved → released

Offer lifecycle maps to Hiring Control Tower stages: offer → budget_validation → finance_approval → leadership_approval → release_offer → joined

Clarification cycles via Workflow Engine.

## Business Rules

Delegated via `businessRulesService.simulateRules`:

- Budget variance (`OFFER_ABOVE_BUDGET`)
- Approval routing by grade (`OFFER_APPROVAL_BASED_ON_GRADE`)
- Compensation limits, location rules, negotiation thresholds
- Referral eligibility on release

## Enterprise Task Inbox

Tasks generated automatically:

- Prepare Offer
- Finance Approval / Leadership Approval
- Review Negotiation
- Release Offer
- Follow-up Acceptance

## Recruitment Integration

Offers inherit from linked records (no duplicate entry):

- Approved Position (`wp_approved_positions`)
- Requisition (`rm_requisitions`)
- Candidate mapping (`rm_candidate_mappings`)
- Interview outcome (`im_interviews`)

## Master Data

Grades, salary bands, currencies, employment types, offer templates, locations, business units validated on create/revise.

## Platform Configuration

Honors `offer_management` module enablement, budget governance thresholds, approval policies, default validity days.

## Frontend Integration

| File | Change |
|------|--------|
| `offerClient.js` / `offerRepository.js` | REST client + live delegation |
| `enterpriseStore.js` | `offers` slice + create/submit/approve/release/accept |
| `bootstrap.js` | Loads offer bundle |
| `events.js` | Full offer audit event types |

See [Offer Verification Scenarios](./Offer Verification Scenarios.md).
