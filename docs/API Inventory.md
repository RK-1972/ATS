# API Inventory

**OPTALYNX Enterprise Architecture Audit · Section 5**

Sources: `ats-backend/index.js`, `ats-backend/routes/*.js`, `ats-frontend/src/api/endpoints.js`.

---

## Enterprise APIs (`/api/v1/*`)

Registered in `index.js` via route modules at server startup.

### Master Data — `masterDataRoutes.js`

| Method | Route | Service | Tables touched | Legacy replaced? |
|--------|-------|---------|----------------|------------------|
| GET | `/api/v1/master` | masterDataService | `md_records`, `md_entity_types` | Partial (vs `/clients`, etc.) |
| GET | `/api/v1/master/:entityType/export` | masterDataService | `md_records` | No |
| POST | `/api/v1/master/:entityType/import/preview` | masterDataService | `md_records` | No |
| POST | `/api/v1/master/:entityType/import` | masterDataService | `md_records` | No |
| GET | `/api/v1/master/:entityType` | masterDataService | `md_records` | No |
| GET | `/api/v1/master/:entityType/:id` | masterDataService | `md_records` | No |
| POST | `/api/v1/master/:entityType` | masterDataService | `md_records`, `md_record_history` | No |
| PUT | `/api/v1/master/:entityType/:id` | masterDataService | `md_records` | No |
| POST | `/api/v1/master/:entityType/:id/publish` | masterDataService | `md_records` | No |
| POST | `/api/v1/master/:entityType/:id/archive` | masterDataService | `md_records` | No |
| POST | `/api/v1/master/:entityType/:id/rollback` | masterDataService | `md_records`, `md_record_history` | No |
| DELETE | `/api/v1/master/:entityType/:id` | masterDataService | `md_records` | No |

### Platform Configuration — `platformConfigRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/platform-config` | platformConfigService | `pc_*` | No |
| GET | `/api/v1/platform-config/export` | platformConfigService | `pc_*` | No |
| GET | `/api/v1/platform-config/snapshots` | platformConfigService | `pc_config_snapshots` | No |
| POST | `/api/v1/platform-config/validate` | platformConfigService | `pc_*` | No |
| PATCH | `/api/v1/platform-config/draft` | platformConfigService | `pc_*` | No |
| PUT | `/api/v1/platform-config/draft` | platformConfigService | `pc_*` | No |
| POST | `/api/v1/platform-config/publish` | platformConfigService | `pc_*`, `md_enterprise_audit` | No |
| POST | `/api/v1/platform-config/discard` | platformConfigService | `pc_*` | No |
| POST | `/api/v1/platform-config/archive` | platformConfigService | `pc_*` | No |
| POST | `/api/v1/platform-config/restore/:snapshotId` | platformConfigService | `pc_*` | No |
| POST | `/api/v1/platform-config/import/preview` | platformConfigService | `pc_*` | No |
| POST | `/api/v1/platform-config/import` | platformConfigService | `pc_*` | No |

### Business Rules — `businessRulesRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/business-rules` | businessRulesService | `br_*` | No |
| GET | `/api/v1/business-rules/export` | businessRulesService | `br_*` | No |
| GET | `/api/v1/business-rules/snapshots` | businessRulesService | `br_bundle_snapshots` | No |
| GET | `/api/v1/business-rules/:id` | businessRulesService | `br_rules` | No |
| POST | `/api/v1/business-rules/validate` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/execute` | businessRulesService | `br_*`, `br_rule_execution_history` | No |
| POST | `/api/v1/business-rules/simulate` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/import/preview` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/import` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/publish` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/discard` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/restore/:snapshotId` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules` | businessRulesService | `br_*` | No |
| PUT | `/api/v1/business-rules/:id` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/:id/publish` | businessRulesService | `br_*` | No |
| POST | `/api/v1/business-rules/:id/archive` | businessRulesService | `br_*` | No |
| DELETE | `/api/v1/business-rules/:id` | businessRulesService | `br_*` | No |

### Workflows — `workflowRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/workflows` | workflowService | `wf_*` | No |
| GET | `/api/v1/workflows/export` | workflowService | `wf_*` | No |
| POST | `/api/v1/workflows/publish` | workflowService | `wf_*` | No |
| POST | `/api/v1/workflows/discard` | workflowService | `wf_*` | No |
| POST | `/api/v1/workflows/import/preview` | workflowService | `wf_*` | No |
| POST | `/api/v1/workflows/import` | workflowService | `wf_*` | No |
| POST | `/api/v1/workflows/restore/:snapshotId` | workflowService | `wf_*` | No |
| POST | `/api/v1/workflows/start` | workflowService | `wf_instances`, `wf_history` | No |
| POST | `/api/v1/workflows/instances/:instanceId/advance` | workflowService | `wf_instances`, `wf_history`, `wf_tasks` | No |
| GET | `/api/v1/workflows/instances/:instanceId` | workflowService | `wf_instances` | No |
| GET | `/api/v1/workflows/instances/:instanceId/tasks` | workflowService | `wf_tasks` | No |
| POST | `/api/v1/workflows/instances/:instanceId/request-clarification` | workflowService | `wf_history` | No |
| POST | `/api/v1/workflows/instances/:instanceId/submit-clarification` | workflowService | `wf_history` | No |
| POST | `/api/v1/workflows/tasks/:taskId/complete` | workflowService | `wf_tasks` | No |
| POST | `/api/v1/workflows/tasks/:taskId/reassign` | workflowService | `wf_tasks` | No |
| GET | `/api/v1/workflows/:workflowCode` | workflowService | `wf_definitions` | No |
| POST | `/api/v1/workflows/:workflowCode/archive` | workflowService | `wf_definitions` | No |

### Workforce Planning — `workforcePlanningRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/workforce` | workforcePlanningService | `wp_*` | No |
| GET | `/api/v1/workforce/export` | workforcePlanningService | `wp_*` | No |
| POST | `/api/v1/workforce/publish` | workforcePlanningService | `wp_*` | No |
| POST | `/api/v1/workforce/discard` | workforcePlanningService | `wp_*` | No |
| POST | `/api/v1/workforce/import/preview` | workforcePlanningService | `wp_*` | No |
| POST | `/api/v1/workforce/import` | workforcePlanningService | `wp_*` | No |
| GET | `/api/v1/workforce/budget-requests/:id` | workforcePlanningService | `wp_budget_requests` | No |
| POST | `/api/v1/workforce/budget-requests/:id/approve` | workforcePlanningService | `wp_*`, `md_enterprise_audit` | No |
| POST | `/api/v1/workforce/budget-requests/:id/reject` | workforcePlanningService | `wp_*` | No |
| POST | `/api/v1/workforce/budget-requests/:id/send-back` | workforcePlanningService | `wp_*` | No |
| POST | `/api/v1/workforce/budget-requests/:id/request-clarification` | workforcePlanningService | `wf_*` (via workflow) | No |
| POST | `/api/v1/workforce/budget-requests/:id/submit-clarification` | workforcePlanningService | `wf_*` | No |
| POST | `/api/v1/workforce/approved-positions/:id/requisitions` | workforcePlanningService → recruitmentService | `wp_*`, `rm_*`, optionally `req_mstr` | **Partial** vs `/requisition` |
| GET | `/api/v1/workforce/:id` | workforcePlanningService | `wp_*` | No |

### Recruitment — `recruitmentRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/recruitment` | recruitmentService | `rm_*` | **Partial** vs `/requisitions` |
| GET | `/api/v1/recruitment/requisitions` | recruitmentService | `rm_requisitions` | Partial |
| GET | `/api/v1/recruitment/requisitions/:code` | recruitmentService | `rm_requisitions` | Partial |
| POST | `/api/v1/recruitment/requisitions` | recruitmentService | `rm_*`, `req_mstr` (optional) | Partial |
| POST | `/api/v1/recruitment/requisitions/:code/approve` | recruitmentService | `rm_requisitions` | No |
| POST | `/api/v1/recruitment/requisitions/:code/assign-recruiter` | recruitmentService | `rm_recruiter_assignments`, `req_recruiter_map` | **Dual-write** vs `/assign-recruiter` |
| POST | `/api/v1/recruitment/candidate-mappings` | recruitmentService | `rm_candidate_mappings`, `candidate_req_map` | **Dual-write** vs `/candidate-req-map` |
| PUT | `/api/v1/recruitment/candidate-mappings/:mapId/stage` | recruitmentService | `rm_*`, `candidate_req_map` | **Dual-write** vs `/update-ats-stage/:mapId` |

### Tasks — `taskRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/tasks` | taskService | `et_tasks` | No legacy equivalent |
| GET | `/api/v1/tasks/inbox` | taskService | `et_tasks` | No |
| GET | `/api/v1/tasks/my` | taskService | `et_tasks` | No |
| GET | `/api/v1/tasks/:taskId` | taskService | `et_tasks` | No |
| POST | `/api/v1/tasks/:taskId/complete` | taskService | `et_tasks`, `et_task_history` | No |
| POST | `/api/v1/tasks/:taskId/reassign` | taskService | `et_tasks` | No |
| POST | `/api/v1/tasks/:taskId/escalate` | taskService | `et_tasks` | No |

### Interviews — `interviewRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/interviews` | interviewService | `im_*` | Partial vs `/interview-schedules` |
| GET | `/api/v1/interviews/:id` | interviewService | `im_interviews` | Partial |
| POST | `/api/v1/interviews/schedule` | interviewService | `im_*` | Partial vs `/schedule-interview` |
| POST | `/api/v1/interviews/:id/accept` | interviewService | `im_interviews` | No |
| POST | `/api/v1/interviews/:id/reschedule` | interviewService | `im_interviews` | No |
| POST | `/api/v1/interviews/:id/complete` | interviewService | `im_interviews`, `interview_schedule_trn` | Partial |
| POST | `/api/v1/interviews/:id/feedback` | interviewService | `im_feedback` | Partial vs `/submit-feedback` |
| POST | `/api/v1/interviews/:id/panel` | interviewService | `im_panel_assignments` | Partial |
| POST | `/api/v1/interviews/:id/reassign-panel` | interviewService | `im_panel_assignments` | No |

### Offers — `offerRoutes.js`

| Method | Route | Service | Tables | Legacy replaced? |
|--------|-------|---------|--------|------------------|
| GET | `/api/v1/offers` | offerManagementService | `om_*` | No legacy offer API |
| GET | `/api/v1/offers/:offerId` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers` | offerManagementService | `om_*`, `wf_*`, `et_tasks` | No |
| POST | `/api/v1/offers/:offerId/submit` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/approve` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/negotiate` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/revise` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/release` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/accept` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/reject` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/withdraw` | offerManagementService | `om_*` | No |
| POST | `/api/v1/offers/:offerId/request-clarification` | offerManagementService | `wf_*` | No |
| POST | `/api/v1/offers/:offerId/submit-clarification` | offerManagementService | `wf_*` | No |

---

## Legacy ATS APIs (`index.js` root routes)

| Method | Route | Handler | Tables | Enterprise overlap? |
|--------|-------|---------|--------|---------------------|
| POST | `/login` | inline | `user_mstr` | No |
| POST | `/register` | inline | `user_mstr` | No |
| GET | `/users` | inline | `user_mstr` | No |
| POST | `/candidate` | inline | `cand_mstr` | No |
| GET | `/candidates` | inline | `cand_mstr`, `candidate_req_map` | **Parallel read** |
| PUT | `/candidate/:id` | inline | `cand_mstr` | No |
| POST | `/requisition` | **recruitmentLegacyHandlers** | `rm_*`, `req_mstr` | Dual-write |
| GET | `/requisitions` | inline | `req_mstr` | **Parallel read** |
| PUT | `/requisition/:id` | inline | `req_mstr` | No |
| POST | `/candidate-req-map` | **recruitmentLegacyHandlers** | `rm_*`, `candidate_req_map` | Dual-write |
| PUT | `/update-ats-stage/:mapId` | **recruitmentLegacyHandlers** | `rm_*`, `candidate_req_map` | Dual-write |
| POST | `/assign-recruiter` | **recruitmentLegacyHandlers** | `rm_*`, `req_recruiter_map` | Dual-write |
| GET | `/my-requisitions` | inline | `req_recruiter_map`, `req_mstr` | **Parallel read** |
| GET | `/recruiter-dashboard` | inline | `req_recruiter_map`, `candidate_req_map` | **Parallel read** |
| GET | `/my-candidates` | inline | `candidate_req_map`, `cand_mstr` | Parallel |
| GET | `/my-candidates-list` | inline | legacy joins | Parallel |
| GET | `/recruiter-pipeline` | inline | `candidate_req_map` | Parallel |
| GET | `/pipeline-details` | inline | legacy joins | Parallel |
| GET | `/dashboard-summary` | inline | legacy | Parallel |
| GET | `/dashboard-funnel` | inline | `candidate_req_map`, `stages` | Parallel |
| POST | `/schedule-interview` | **interviewLegacyHandlers** | `im_*`, `interview_schedule_trn` | Dual-write |
| GET | `/interview-schedules` | inline | `interview_schedule_trn` | Parallel read |
| GET | `/my-interviews` | inline | `interview_schedule_trn` | Parallel read |
| POST | `/submit-feedback` | inline / handlers | `interview_feedback_*`, `im_feedback` | Partial |
| GET/POST | `/interview-panel` | inline | `interview_panel_mstr` | Parallel |
| GET | `/clients`, `/client`, etc. | inline | legacy masters | Parallel vs `/api/v1/master` |
| POST | `/forgot-password`, `/reset-password` | inline | `user_mstr`, `password_reset_tokens` | No |

---

## Frontend-Declared but Missing Backend Routes

| Endpoint (frontend) | Declared in | Backend registered? |
|---------------------|-------------|---------------------|
| `GET /api/v1/audit` | `endpoints.js`, `auditClient.js` | **No** |
| `GET /api/v1/hiring-control-tower` | `endpoints.js`, `hiringControlTowerClient.js` | **No** |
| `GET /api/v1/notifications` | `endpoints.js`, `notificationsClient.js` | **No** (merged into platform-config) |

---

## Auth Pattern

| API family | Auth middleware |
|------------|-----------------|
| Enterprise v1 (config, rules, workflows, workforce) | `verifyToken` + `verifyAdmin` |
| Enterprise v1 (recruitment, tasks, interviews, offers) | `verifyToken` |
| Legacy ATS | `verifyToken` on most routes |
