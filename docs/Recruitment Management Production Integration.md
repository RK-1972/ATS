# Recruitment Management — Production Integration (Backend Sprint 6)

Enterprise integration for the ATS Recruitment module with Master Data, Platform Configuration, Business Rules, Workflow Engine, Workforce Planning, and Enterprise Audit.

## Overview

Sprint 6 transforms Recruitment from standalone CRUD into a platform-consumed application. Requisitions originate only from Workforce Planning approved positions. Approvals, validations, routing, and pipeline transitions delegate to platform engines.

UI, hooks, routing, and React components are unchanged. Legacy operational pages (`RequisitionPage`, `CandidatePage`) continue calling root-level routes; those routes now delegate to `recruitmentService`.

## Database Schema

| Table | Purpose |
|-------|---------|
| `rm_requisitions` | Enterprise requisitions linked to `wp_approved_positions` |
| `rm_recruiter_assignments` | Recruiter assignments with workflow linkage |
| `rm_candidate_mappings` | Candidate ↔ requisition pipeline mappings |
| `rm_pipeline_history` | Stage transition history |
| `rm_requisition_snapshots` | Requisition version snapshots |

Migration: `migrations/006_recruitment_management_schema.sql`

## Migration & Seed

```bash
cd ats-backend
npm run migrate:recruitment
npm run seed:recruitment
```

Seed file `seed/recruitment.seed.json` includes `REQ-2026-1187` linked to `AP-2026-0076` (aligned with Hiring Control Tower mock).

## REST API

Base path: `/api/v1/recruitment`  
Auth: Bearer JWT + Admin role

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/recruitment` | Recruitment bundle (requisitions, assignments, pipeline) |
| GET | `/api/v1/recruitment/requisitions` | List enterprise requisitions |
| GET | `/api/v1/recruitment/requisitions/:code` | Single requisition |
| POST | `/api/v1/recruitment/requisitions` | Create from `approved_position_id` |
| POST | `/api/v1/recruitment/requisitions/:code/approve` | Approve requisition (Workflow Engine) |
| POST | `/api/v1/recruitment/requisitions/:code/assign-recruiter` | Assign recruiter (Business Rules + Workflow) |
| POST | `/api/v1/recruitment/candidate-mappings` | Map candidate to requisition |
| PUT | `/api/v1/recruitment/candidate-mappings/:mapId/stage` | Update pipeline stage |

### Legacy routes (delegated to recruitment service)

| Method | Path | Enterprise behavior |
|--------|------|---------------------|
| POST | `/requisition` | Requires `approved_position_id`; inherits position metadata |
| POST | `/assign-recruiter` | Rules + workflow + audit |
| POST | `/candidate-req-map` | Requires enterprise requisition; duplicate detection via rules |
| PUT | `/update-ats-stage/:mapId` | Workflow advance + offer routing rules + audit |

## Platform Integration

### Workforce Planning

Requisitions inherit from approved positions:

- Position title, grade, department, business unit, budget, location, hiring manager, employment type

Workforce `createRequisition` delegates to `recruitmentService.createFromApprovedPosition`.

### Workflow Engine

- Requisition creation starts `REQUISITION` workflow
- Approvals advance through TA Leader review stages
- Recruiter assignment advances to `recruiter_assigned`
- Candidate mapping starts `CANDIDATE` workflow
- Stage updates advance/reject candidate workflow instances

### Business Rules Engine

Delegated via `businessRulesService.simulateRules`:

- Budget thresholds on requisition creation
- Approval routing
- Recruiter assignment rules
- Duplicate candidate detection on mapping
- Offer routing on stage transitions

### Master Data

Validated references: departments, grades, locations, skills, employment types, candidate sources, business units.

### Platform Configuration

Recruitment module enablement checked before all operations.

### Enterprise Audit

`RequisitionCreated`, `RequisitionApproved`, `RecruiterAssigned`, `CandidateMapped`, `StageChanged`, `CandidateRejected`, `CandidateShortlisted`

## Frontend Integration

| File | Change |
|------|--------|
| `recruitmentClient.js` | REST client at `/api/v1/recruitment` |
| `recruitmentRepository.js` | Live mode delegation |
| `enterpriseStore.js` | `recruitment` slice + async actions |
| `bootstrap.js` | Loads recruitment bundle |
| `events.js` | Recruitment audit event types |

## Activation

Requires Sprints 1–5 migrations/seeds, then:

```bash
cd ats-backend
npm run migrate:recruitment
npm run seed:recruitment
npm start
```

```env
VITE_API_MODE=live
VITE_API_BASE_URL=http://localhost:5000
```

See [Recruitment Verification Scenarios](./Recruitment Verification Scenarios.md).
