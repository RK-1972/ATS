# Production Cutover Checklist

**Program:** Enterprise Architecture Consolidation  
**Cutover type:** Operational System of Record switch (legacy → enterprise)

---

## Pre-Cutover

- [ ] Database backup completed (`pg_dump` or managed snapshot)
- [ ] `OPERATIONAL_SOR=enterprise` confirmed in production `.env`
- [ ] `LEGACY_DUAL_WRITE=false` confirmed (no writes to legacy operational tables)
- [ ] Schema migrations applied (`rm_*`, `im_*`, `om_*`, `et_*`, `wf_*`)
- [ ] Staging migration run with **all PASS** validation
- [ ] Rollback script tested on staging (`npm run rollback:operational`)
- [ ] Legacy API smoke tests pass (requisitions, candidates, interviews)
- [ ] Recruiter Workspace verified with `VITE_API_MODE=live`

---

## Cutover Steps

1. **Maintenance window (optional)** — not required; zero-downtime cutover supported
2. Run migration:
   ```bash
   cd ats-backend
   npm run migrate:operational
   ```
3. Confirm validation output shows `"allPass": true`
4. Restart backend with `OPERATIONAL_SOR=enterprise`
5. Verify enterprise API bundle:
   - `GET /api/v1/recruitment`
   - `GET /api/v1/interviews`
   - `GET /api/v1/tasks`
6. Verify legacy API delegation:
   - `GET /requisitions`
   - `GET /my-requisitions`
   - `GET /recruiter-dashboard`
   - `GET /interview-schedules`
7. Verify Recruiter Workspace displays live counts (not zeros)
8. Verify Hiring Control Tower workflow state from `wf_*` tables
9. Mark legacy tables **DEPRECATED** (see Legacy Table Deprecation Register)

---

## Post-Cutover Monitoring (24–72 hours)

- [ ] No duplicate-write errors in application logs
- [ ] Enterprise audit trail (`md_enterprise_audit`) recording operational events
- [ ] Task inbox processing normally (`et_*`)
- [ ] Offer governance reads `om_*` only
- [ ] Row counts stable (no drift between legacy and enterprise migrated subsets)

---

## Rollback Procedure

If validation fails or critical defect detected:

1. Set `OPERATIONAL_SOR=legacy` in environment
2. Restart backend (repositories read legacy tables via adapter)
3. Optionally run:
   ```bash
   npm run rollback:operational
   ```
4. Re-run migration after fix:
   ```bash
   npm run migrate:operational
   ```

Legacy tables are **never deleted** during rollback — only enterprise migrated rows are removed.

---

## Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Platform Engineering | | | |
| TA Operations | | | |
| DBA | | | |
