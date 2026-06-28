# Interview Management + Task Inbox — Verification Scenarios

## Prerequisites

1. Sprints 1–7 migrations and seeds applied
2. Backend on port 5000 with valid JWT
3. Seeded interview `INT-2026-00482` and inbox tasks

## Scenario 1 — Enterprise Task Inbox

**Steps**

1. `GET /api/v1/tasks/inbox`
2. `GET /api/v1/tasks/my` as Interviewer or TA Leader

**Expected**

- Pending tasks from Interview and Recruitment modules
- Summary counts (pending, escalated, overdue)
- Frontend bootstrap populates `taskInbox` in Enterprise Store

## Scenario 2 — Schedule Interview

**Steps**

1. `POST /api/v1/interviews/schedule` with map_id, interviewer_id, round_type, date, time
2. Or legacy: `POST /schedule-interview`

**Expected**

- `im_interviews` row created
- `INTERVIEW` workflow instance started and advanced to scheduled
- Tasks created: Accept Assignment + Conduct Interview
- Audit `InterviewScheduled` + `TaskCreated`
- Legacy `interview_schedule_trn` row if table exists

## Scenario 3 — Accept Panel Assignment

**Steps**

1. `POST /api/v1/interviews/INT-2026-00482/accept`

**Expected**

- Panel assignment status `Accepted`
- Accept task completed in inbox
- Audit `InterviewAccepted`

## Scenario 4 — Complete Interview

**Steps**

1. `POST /api/v1/interviews/:id/complete`

**Expected**

- Workflow advanced to completed stage
- Conduct Interview task completed
- Submit Feedback task created
- Audit `InterviewCompleted`

## Scenario 5 — Submit Feedback

**Steps**

1. `POST /api/v1/interviews/:id/feedback` or legacy `POST /submit-feedback`
2. Include skills array and final_outcome

**Expected**

- `im_feedback` row created
- Workflow advanced to feedback stage
- Feedback task completed
- Legacy pipeline stage updated (Selected/Rejected/Hold)
- Audit `FeedbackSubmitted`

## Scenario 6 — Reschedule Interview

**Steps**

1. `POST /api/v1/interviews/:id/reschedule` with new date/time

**Expected**

- Interview date/time updated
- Legacy schedule updated if linked
- New conduct task created
- Audit `InterviewRescheduled`

## Scenario 7 — Reassign Panel

**Steps**

1. `POST /api/v1/interviews/:id/reassign-panel` with new panel_id

**Expected**

- Old assignment marked Reassigned
- New panel assignment Pending
- New accept task created

## Scenario 8 — Complete Task from Inbox

**Steps**

1. `POST /api/v1/tasks/:taskId/complete`

**Expected**

- Enterprise task status Completed
- Linked workflow task completed
- Audit `TaskCompleted`

## Scenario 9 — Business Rules on Schedule

**Steps**

1. Schedule with invalid interview type not in Master Data

**Expected**

- HTTP 400 validation error

## Scenario 10 — Module Disabled

**Steps**

1. Disable interview_management in Platform Configuration
2. Attempt schedule

**Expected**

- HTTP 400 module disabled

## End-to-End Flow

```
Recruitment (candidate mapped)
  → Schedule Interview (Workflow INTERVIEW + tasks)
  → Panel Accept Assignment (task complete)
  → Conduct Interview (task complete)
  → Complete Interview (workflow → feedback stage)
  → Submit Feedback (workflow complete + recruitment stage update)
  → Task Inbox reflects all human actions
```

## Re-seed

```bash
cd ats-backend
npm run seed:interviews
```
