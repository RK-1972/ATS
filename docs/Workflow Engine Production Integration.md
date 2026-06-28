# Enterprise Workflow Engine — Production Integration (Backend Sprint 4)

PostgreSQL-backed orchestration layer delegating business decisions to the Business Rules Engine.

## Overview

The Workflow Engine replaces mock workflow configuration and in-memory hiring process state when `VITE_API_MODE=live`. UI, hooks, and routing are unchanged — `workflowsRepository`, `workflowConfigurationRepository`, and `hiringControlTowerRepository` switch to live APIs.

## Database Schema

| Table | Purpose |
|-------|---------|
| `wf_config_state` | Draft + published workflow definition bundles |
| `wf_bundle_snapshots` | Definition history / rollback |
| `wf_definitions` | Workflow definitions |
| `wf_stages` | Stage definitions |
| `wf_stage_transitions` | Allowed transitions |
| `wf_transition_conditions` | Transition conditions |
| `wf_versions` | Per-definition version snapshots |
| `wf_sla_definitions` | SLA per stage |
| `wf_escalation_policies` | Escalation policies |
| `wf_instances` | Running workflow instances |
| `wf_tasks` | Approval/action tasks |
| `wf_assignments` | Task assignee history |
| `wf_history` | Instance event history |

## Migration & Seed

```bash
cd ats-backend
npm run migrate:workflows
npm run seed:workflows
```

Files:

- `migrations/004_workflow_engine_schema.sql`
- `seed/workflows.seed.json` — 5 definitions (4 platform + Enterprise Hiring Lifecycle)
- `seed/workflowInstance.seed.json` — seeded hiring process instance
- `scripts/seedWorkflows.js`

## REST API

Base path: `/api/v1/workflows`  
Auth: Bearer JWT + Admin role

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/workflows` | Bundle: definitions, instances, primaryInstance |
| GET | `/api/v1/workflows/export` | Export published definitions |
| POST | `/api/v1/workflows/publish` | Publish definition catalog |
| POST | `/api/v1/workflows/discard` | Discard draft definitions |
| POST | `/api/v1/workflows/import/preview` | Import preview |
| POST | `/api/v1/workflows/import` | Import definitions to draft |
| POST | `/api/v1/workflows/restore/:snapshotId` | Restore definition snapshot |
| POST | `/api/v1/workflows/start` | Start workflow instance |
| GET | `/api/v1/workflows/instances/:instanceId` | Get instance |
| POST | `/api/v1/workflows/instances/:instanceId/advance` | Advance / approve / reject |
| GET | `/api/v1/workflows/instances/:instanceId/tasks` | Current tasks |
| POST | `/api/v1/workflows/instances/:instanceId/request-clarification` | Request clarification |
| POST | `/api/v1/workflows/instances/:instanceId/submit-clarification` | Submit clarification |
| POST | `/api/v1/workflows/tasks/:taskId/complete` | Complete task |
| POST | `/api/v1/workflows/tasks/:taskId/reassign` | Reassign task |
| GET | `/api/v1/workflows/:workflowCode` | Single definition |
| POST | `/api/v1/workflows/:workflowCode/archive` | Archive definition |

### Bundle response

```json
{
  "config": { "definitions": [], "workflows": [], "primary_instance_id": "HCT-2026-00482" },
  "baseline": {},
  "workflows": [],
  "instances": [],
  "primaryInstance": { "meta": {}, "stages": [], "timeline": [] },
  "isDirty": false,
  "version": "1.0"
}
```

## Workflow Execution Service

`services/workflowService.js`:

| Method | Purpose |
|--------|---------|
| `startWorkflow` | Create instance + initial tasks + audit |
| `advanceWorkflow` | Stage transition, rule evaluation, history |
| `requestClarification` | Pause stage, timeline + audit |
| `submitClarification` | Resume clarification cycle |
| `completeTask` / `reassignTask` | Task management |
| `evaluateRulesOnTransition` | Delegates to Business Rules Engine |

The engine never embeds business logic — it calls `businessRulesService.evaluateRule` with the instance execution context.

## Audit events

`WorkflowStarted`, `WorkflowAdvanced`, `WorkflowCompleted`, `StageChanged`, `TaskAssigned`, `TaskReassigned`, `ClarificationRequested`, `ClarificationSubmitted`, `WorkflowPublished`

Written to shared `md_enterprise_audit`.

## Frontend integration

| File | Change |
|------|--------|
| `workflowsRepository.js` | Live workflow bundle + instance execution |
| `workflowsClient.js` | Full REST client |
| `workflowConfigurationRepository.js` | Delegates to workflows in live mode |
| `hiringControlTowerRepository.js` | Instance load + advance/clarification via API |
| `enterpriseStore.js` | `workflows` slice + async hiring actions |
| `bootstrap.js` | Loads workflows + hiringProcess |

See [Workflow Execution Documentation](./Workflow Execution Documentation.md).
