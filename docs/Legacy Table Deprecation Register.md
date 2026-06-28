# Legacy Table Deprecation Register

**Migration date:** 2026-06-27  
**Migration marker:** `operational-consolidation-v1`  
**Verification status:** All entities **PASS** (see Operational Migration Verification Report)

Legacy ATS operational tables are **DEPRECATED**. They are retained for rollback and historical verification only. **Do not delete** without explicit architecture approval.

---

| Legacy Table | Replacement Table | Migration Date | Reason | Verification | Deletion Recommendation |
|--------------|-------------------|----------------|--------|--------------|-------------------------|
| `req_mstr` | `rm_requisitions` | 2026-06-27 | Enterprise operational SoR cutover | PASS (4/4) | Retain 90+ days; delete only after dual-read period and stakeholder sign-off |
| `req_recruiter_map` | `rm_recruiter_assignments` | 2026-06-27 | Enterprise operational SoR cutover | PASS (11 active) | Retain 90+ days |
| `candidate_req_map` | `rm_candidate_mappings` | 2026-06-27 | Enterprise operational SoR cutover | PASS (27/27) | Retain 90+ days |
| `interview_schedule_trn` | `im_interviews` | 2026-06-27 | Enterprise operational SoR cutover | PASS (34/34) | Retain 90+ days |
| `interview_feedback_hdr` | `im_feedback` | 2026-06-27 | Enterprise operational SoR cutover | PASS (9/9) | Retain 90+ days |
| `interview_feedback_dtl` | `im_feedback.skills` (JSONB) | 2026-06-27 | Consolidated feedback model | PASS (9/9) | Retain 90+ days |

---

## Tables NOT Deprecated

| Table | Status | Notes |
|-------|--------|-------|
| `cand_mstr` | **Active SoR** | Candidate Master — shared until future Enterprise Candidate Model |
| `interview_panel_mstr` | **Active reference** | Panel master data |
| `md_*`, `pc_*`, `br_*`, `wf_*`, `wp_*`, `om_*`, `et_*` | **Active** | Enterprise platform modules |

---

## Rollback

Set `OPERATIONAL_SOR=legacy` and run `npm run rollback:operational` to remove migrated enterprise rows. Legacy tables remain intact with full historical data.
