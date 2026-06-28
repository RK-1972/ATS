# Operational Migration Verification Report

**Program:** Enterprise Architecture Consolidation — Final Operational Data Migration  
**Migration marker:** `operational-consolidation-v1`  
**Validated at:** 2026-06-27  
**Environment:** `ats_dev`  
**Status:** **PASS**

---

## Summary

Legacy ATS operational data has been backfilled into the Enterprise Operational Model. All five migrated entity groups passed automated count and checksum validation.

| Entity | Legacy Count | Enterprise Count | Checksum | Status |
|--------|-------------:|-----------------:|----------|--------|
| Requisitions | 4 | 4 | Match | **PASS** |
| Recruiter Assignments (active) | 11 | 11 | Match | **PASS** |
| Candidate Mapping (active) | 27 | 27 | Match | **PASS** |
| Interview Scheduling | 34 | 34 | Match | **PASS** |
| Interview Feedback | 9 | 9 | Match | **PASS** |

---

## Migration Execution

| Step | Source | Target | Inserted | Updated | Skipped |
|------|--------|--------|----------|---------|---------|
| Requisitions | `req_mstr` | `rm_requisitions` | 4 | 0 | — |
| Recruiter Assignments | `req_recruiter_map` | `rm_recruiter_assignments` | 24 | — | 0 |
| Candidate Mappings | `candidate_req_map` | `rm_candidate_mappings` | 27 | 0 | 0 |
| Interviews | `interview_schedule_trn` | `im_interviews` | 34 | 0 | 0 |
| Feedback | `interview_feedback_hdr` / `_dtl` | `im_feedback` | 9 | 0 | 0 |

**Notes:**

- Enterprise seed row `REQ-2026-1187` is preserved alongside four migrated requisitions (5 total in `rm_requisitions`).
- Recruiter assignment validation compares **active** rows keyed by `req_id + recruiter_code` (legacy 11 active of 24 total).
- Interview validation compares rows whose `schedule_id` exists in legacy (excludes enterprise-only seed interview).
- Legacy text ratings (`Good`, `Excellent`, etc.) were normalized to numeric values during feedback migration.

---

## Commands

```bash
npm run migrate:operational    # Backfill + validate
npm run validate:operational   # Validation only
npm run rollback:operational   # Remove migrated enterprise rows (legacy untouched)
```

State file: `migration/operational-migration-state.json`

---

## Integrity Checks Performed

1. Row count parity (legacy vs enterprise migrated subset)
2. MD5 checksum on primary business keys (`req_id`, `map_id`, `schedule_id`)
3. Foreign key resolution (`req_id` → `requisition_code`, `map_id` → candidate/requisition)
4. Transactional migration with rollback on failure

---

## Sign-off Criteria

| Criterion | Result |
|-----------|--------|
| No data loss | ✓ |
| All entities PASS validation | ✓ |
| Legacy tables unchanged | ✓ |
| Enterprise repositories read enterprise tables | ✓ |
| Legacy APIs delegate to enterprise services | ✓ |
