# Interview Management + Enterprise Task Inbox — Production Integration (Backend Sprint 7)

PostgreSQL-backed Interview Management with platform-wide Enterprise Task Inbox, Workflow Engine orchestration, and full platform integration.

## Overview

Sprint 7 replaces interview mock persistence with enterprise services. Every workflow stage requiring human action creates a task in the Enterprise Task Inbox. Interview scheduling, panel assignment, feedback, and completion execute through the Workflow Engine.

UI, routing, and React components are unchanged. Legacy pages continue using root-level routes; those routes delegate to `interviewService`.

## Database Schema

| Table | Purpose |
|-------|---------|
| `et_tasks` | Platform-wide Enterprise Task Inbox |
| `et_task_history` | Task lifecycle audit trail |
| `im_interviews` | Enterprise interview records |
| `im_panel_assignments` | Panel member assignments |
| `im_feedback` | Interview feedback submissions |
| `im_interview_history` | Interview event history |

Migration: `migrations/007_interview_task_inbox_schema.sql`

## Enterprise Task Inbox

`services/taskService.js` provides reusable task management:

| Method | Purpose |
|--------|---------|
| `createTask` | Creates `et_tasks` + linked `wf_tasks` when workflow instance provided |
| `listInbox` | All pending tasks (filterable by module/status) |
| `listMyTasks` | Tasks assigned to current user or role |
| `completeTask` | Complete enterprise + workflow task |
| `reassignTask` | Reassign with audit |
| `escalateTask` | SLA escalation |

Task types span modules: Review Requisition, Assign Recruiter, Schedule Interview, Submit Feedback, Accept Assignment, etc.

## Migration & Seed

```bash
cd ats-backend
npm run migrate:interviews
npm run seed:interviews
```

## REST API — Tasks

Base path: `/api/v1/tasks`  
Auth: Bearer JWT (role-aware, not admin-only)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/tasks` | Task bundle with summary |
| GET | `/api/v1/tasks/inbox` | Full inbox (optional module filter) |
| GET | `/api/v1/tasks/my` | Current user's tasks |
| GET | `/api/v1/tasks/:taskId` | Single task |
| POST | `/api/v1/tasks/:taskId/complete` | Complete task |
| POST | `/api/v1/tasks/:taskId/reassign` | Reassign task |
| POST | `/api/v1/tasks/:taskId/escalate` | Escalate task |

## REST API — Interviews

Base path: `/api/v1/interviews`  
Auth: Bearer JWT

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/interviews` | Interview bundle |
| GET | `/api/v1/interviews/:id` | Single interview |
| POST | `/api/v1/interviews/schedule` | Schedule interview |
| POST | `/api/v1/interviews/:id/accept` | Accept panel assignment |
| POST | `/api/v1/interviews/:id/reschedule` | Reschedule interview |
| POST | `/api/v1/interviews/:id/complete` | Complete interview |
| POST | `/api/v1/interviews/:id/feedback` | Submit feedback |
| POST | `/api/v1/interviews/:id/panel` | Assign panel |
| POST | `/api/v1/interviews/:id/reassign-panel` | Reassign panel member |

### Legacy routes (delegated)

| Method | Path | Enterprise behavior |
|--------|------|---------------------|
| POST | `/schedule-interview` | Workflow + tasks + legacy schedule sync |
| POST | `/submit-feedback` | Workflow advance + feedback + pipeline update |

## Platform Integration

### Workflow Engine

- `INTERVIEW` workflow instances on schedule
- Stage transitions: requested → scheduled → completed → feedback
- Panel acceptance and feedback completion create/complete inbox tasks

### Business Rules Engine

Panel selection, interview sequencing, mandatory rounds, skill routing, candidate progression, and escalation via `simulateRules`.

### Master Data

Interview types, interview modes, and skills validated from Master Data.

### Recruitment

Interviews link to candidate mappings and requisition codes from Recruitment Management.

### Enterprise Audit

`InterviewScheduled`, `InterviewAccepted`, `InterviewCompleted`, `FeedbackSubmitted`, `InterviewRescheduled`, `TaskCreated`, `TaskCompleted`, `TaskEscalated`

## Frontend Integration

| File | Change |
|------|--------|
| `taskClient.js` / `taskRepository.js` | Enterprise Task Inbox API |
| `interviewClient.js` / `interviewRepository.js` | Interview enterprise API |
| `enterpriseStore.js` | `taskInbox`, `interviews` slices + async actions |
| `bootstrap.js` | Loads tasks + interviews in live mode |

See [Interview Verification Scenarios](./Interview Verification Scenarios.md).
