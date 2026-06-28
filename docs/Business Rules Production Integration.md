# Business Rules — Production Integration (Backend Sprint 3)

PostgreSQL-backed Business Rules Engine following the Repository → API Client → Express → PostgreSQL architecture.

## Overview

Business Rules replace in-memory mock persistence when `VITE_API_MODE=live`. The UI, hooks, and routing are unchanged — only `businessRulesRepository` switches to live APIs. The backend Rule Evaluation Service is the authoritative decision engine and consumes Platform Configuration (budget thresholds) and Master Data context at execution time.

## Database Schema

### Core tables

| Table | Purpose |
|-------|---------|
| `br_config_state` | Draft + published JSON bundles |
| `br_bundle_snapshots` | Published bundle history / rollback |
| `br_general_settings` | Org meta synced on publish |
| `br_categories` | Rule categories |
| `br_rules` | Rule definitions |
| `br_rule_conditions` | Normalized conditions per rule |
| `br_rule_actions` | Normalized actions per rule |
| `br_rule_parameters` | Rule parameters |
| `br_rule_versions` | Per-rule version snapshots |
| `br_rule_dependencies` | Rule dependency graph |
| `br_approval_matrix` | Approval matrix rows |
| `br_rule_execution_history` | Execute/simulate audit trail |

Audit events use shared `md_enterprise_audit`.

## Migration & Seed

```bash
cd ats-backend
npm run migrate:business-rules
npm run seed:business-rules
```

Files:

- `migrations/003_business_rules_schema.sql`
- `seed/businessRules.seed.json`
- `scripts/seedBusinessRules.js`

## REST API

Base path: `/api/v1/business-rules`  
Auth: `Authorization: Bearer <JWT>` + Admin role

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/business-rules` | Full bundle `{ config, baseline, isDirty, version }` |
| GET | `/api/v1/business-rules/export` | Export published rules |
| GET | `/api/v1/business-rules/snapshots` | List bundle snapshots |
| GET | `/api/v1/business-rules/:id` | Single rule |
| POST | `/api/v1/business-rules` | Create rule (draft) |
| PUT | `/api/v1/business-rules/:id` | Update rule (draft) |
| DELETE | `/api/v1/business-rules/:id` | Delete rule from draft |
| POST | `/api/v1/business-rules/:id/publish` | Publish single rule |
| POST | `/api/v1/business-rules/:id/archive` | Archive rule |
| POST | `/api/v1/business-rules/publish` | Publish full bundle |
| POST | `/api/v1/business-rules/discard` | Discard draft changes |
| POST | `/api/v1/business-rules/restore/:snapshotId` | Restore snapshot |
| POST | `/api/v1/business-rules/validate` | Validate rule bundle |
| POST | `/api/v1/business-rules/execute` | Execute single rule |
| POST | `/api/v1/business-rules/simulate` | Simulate all active rules |
| POST | `/api/v1/business-rules/import/preview` | Import preview |
| POST | `/api/v1/business-rules/import` | Import to draft |

### Bundle response

```json
{
  "config": {
    "meta": {},
    "kpis": {},
    "categories": [],
    "rules": [],
    "approval_matrix": [],
    "version_history": []
  },
  "baseline": {},
  "isDirty": false,
  "version": "2.1"
}
```

### Execute request

```json
{
  "ruleCode": "OFFER_ABOVE_BUDGET",
  "executionContext": {
    "offered_salary_lpa": 22,
    "department": "Engineering",
    "grade": "G10",
    "location": "Bangalore"
  }
}
```

### Execute response

```json
{
  "ruleMatched": true,
  "ruleCode": "OFFER_ABOVE_BUDGET",
  "ruleId": "rule-001",
  "ruleName": "Offer Above Budget",
  "actions": ["Start Budget Exception Workflow", "..."],
  "requiredApprovals": ["Finance Approver"],
  "notifications": ["Budget exception alert to TA Lead"],
  "escalations": ["TA Leader after 48h"]
}
```

## Rule Evaluation Service

`services/businessRulesService.js`:

- `evaluateRule(pool, ruleCode, executionContext)` — single rule evaluation
- `executeRule(pool, ruleCode, executionContext, req)` — evaluate + audit + history
- `simulateRules(pool, executionContext, req)` — evaluate all active published rules

Supported rule codes (seed):

| Code | Trigger logic |
|------|---------------|
| `OFFER_ABOVE_BUDGET` | Salary exceeds matrix limit / budget threshold |
| `OFFER_APPROVAL_BASED_ON_GRADE` | Grade G10+ |
| `LOCATION_BASED_HIRING_APPROVAL` | Restricted location |
| `DUPLICATE_CANDIDATE_DETECTION` | Duplicate flags in context |
| `MANDATORY_L2_INTERVIEW` | G8+ client interview without L2 |
| `VENDOR_SLA_ESCALATION` | Vendor pending > 48h |
| `REFERRAL_BONUS_ELIGIBILITY` | Employee referral criteria |

Platform Configuration budget variance is loaded from `pc_config_state` during evaluation.

## Validation

- Duplicate rule names / codes
- Circular dependencies (`depends_on`)
- Missing trigger events (non-draft)
- Empty conditions/actions for active rules
- Missing dependency targets
- Version label conflicts

## Audit events

| Event | Trigger |
|-------|---------|
| `RuleCreated` | Create / import |
| `RulePublished` | Publish rule or bundle |
| `RuleArchived` | Archive / delete |
| `RuleExecuted` | Execute API |
| `RuleMatched` | Execute when rule matches |
| `RuleValidationFailed` | Failed publish validation |
| `RuleSimulationExecuted` | Simulate API |

## Frontend integration

| File | Change |
|------|--------|
| `businessRulesRepository.js` | Live mode via API |
| `businessRulesClient.js` | Full REST client |
| `enterpriseStore.js` | `saveBusinessRules` / `discardBusinessRules` async |
| `bootstrap.js` | Loads business rules on startup |

Hooks and React components are unchanged. Rule Simulator continues client-side logic using store data loaded from PostgreSQL.

## Activation

```env
VITE_API_MODE=live
VITE_API_BASE_URL=http://localhost:5000
```

See [Rule Execution Flow](./Rule Execution Flow.md) for end-to-end execution architecture.
