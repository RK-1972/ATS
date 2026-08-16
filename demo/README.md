# OPTALYNX E2E Demo Infrastructure

Isolated, repeatable demo scenario for recording a **real UI** end-to-end recruiting journey.

**Namespace:** `DEMO_E2E`  
**Marker:** `[DEMO_E2E]`  
**Manifest:** `demo/e2e-demo.manifest.json`

This infrastructure sits **around** the product. It does not modify business logic, workflows, or screens.

---

## Quick start

From `ats-backend` (with `.env` DB credentials configured):

```bash
node scripts/setupE2eDemoScenario.js
node scripts/verifyE2eDemoReadiness.js
```

Before each recording:

```bash
node scripts/resetE2eDemoScenario.js           # preview what will be removed
node scripts/resetE2eDemoScenario.js --execute # remove demo transactional data only
```

---

## Demo users

| Role | Employee code | Email | Login role |
|------|---------------|-------|------------|
| Requestor | `DEMO_E2E_REQ` | demo.requestor@optalynx.demo | Recruiter |
| Approver L1 | `DEMO_E2E_APP1` | demo.approver1@optalynx.demo | Recruiter |
| Approver L2 | `DEMO_E2E_APP2` | demo.approver2@optalynx.demo | Recruiter |
| Admin | `DEMO_E2E_ADM` | demo.admin@optalynx.demo | Admin |
| Recruiter | `DEMO_E2E_REC` | demo.recruiter@optalynx.demo | Recruiter |
| Interviewer | `DEMO_E2E_INT` | demo.interviewer@optalynx.demo | Interviewer |
| Offer Approver L1 | `DEMO_E2E_OFR1` | offer.approver1@optalynx.demo | Recruiter |
| Offer Approver L2 | `DEMO_E2E_OFR2` | offer.approver2@optalynx.demo | Recruiter |

**Password:** `E2E_DEMO_PASSWORD` env var, or default `Demo@Optalynx2026` from manifest (shared by all demo users including offer approvers).

After changing offer approval route/approvers, re-point an existing pending demo offer:

```bash
node scripts/reseedDemoOfferApprovalForValidation.js
```

---

## Recording sequence (real UI)

Use `[DEMO_E2E]` in titles so reset can identify demo records.

1. **Login as Requestor** → Workforce Planning → create budget for `[DEMO_E2E] Senior Software Engineer` (**Department: IT Infrastructure**)
2. **Submit budget** → select `[DEMO_E2E] Budget Approval` route
3. **Login as Approver L1 / L2** → approve budget (2 steps)
4. **Approved position** appears in catalogue
5. **Login as Requestor** → create requisition from demo approved position
6. **Submit requisition** → select `[DEMO_E2E] Requisition Approval` route
7. **Approvers** → approve requisition (2 steps)
8. **Login as Admin** → assign `DEMO_E2E_REC` to requisition
9. **Login as Recruiter** → Candidate Intake → upload `demo/assets/demo-resume.pdf`
10. Parse → review → register to **My Pipeline** (source: **Employee Referral**)
11. Candidate Workspace → map to demo requisition
12. Schedule interviews (**L1 Interview**, optional **L2 Interview**) — use a **future date**
13. **Login as Interviewer** → submit feedback
14. **Recruiter** → raise offer → submit (uses isolated **`[DEMO_E2E] Offer Approval`** route)
15. **Login as Offer Approver 1 / 2** (`DEMO_E2E_OFR1`, `DEMO_E2E_OFR2`) → approve offer (2 steps)
16. **Optional:** generate/view offer letter (requires LibreOffice + templates)

---

## What setup creates

- 8 dedicated demo users (clearly named, `@optalynx.demo` emails)
- Work assignments for requestor, approver, assigner, recruiter, interviewer, and offer approvers
- 3 approval routes: Budget, Requisition, **Offer** (2 steps each, **IT Infrastructure** policy for Offer)
- Interviewer panel membership for `DEMO_E2E_INT`
- **Offer approval** uses **`[DEMO_E2E] Offer Approval`** with `DEMO_E2E_OFR1` / `DEMO_E2E_OFR2`
- Demo setup **suspends active policies on system Offer route (route 2)** to prevent resolver overlap — does **not** modify production user records or route step assignments on route 2

## What setup does NOT create

- Budget / approved position / requisition (created through UI during recording)
- Candidate / intake / mapping / interviews / offers (created through UI)

---

## Reset behavior

Reset deletes **only** demo transactional artifacts identified by:

- `[DEMO_E2E]` in position/requisition titles
- `demo.candidate@optalynx.demo`
- `DEMO_E2E_*` employee codes on created/submitted records
- `demo-resume` intake uploads

**Preserved:** demo users, approval routes, work assignments, interviewer panel, all non-demo data.

---

## Files

| File | Purpose |
|------|---------|
| `demo/e2e-demo.manifest.json` | Scenario definition |
| `demo/e2eDemoLib.js` | Shared setup/reset/verify helpers |
| `scripts/setupE2eDemoScenario.js` | Idempotent infrastructure setup |
| `scripts/reseedDemoOfferApprovalForValidation.js` | Re-point existing demo offer to demo approvers |
| `scripts/resetE2eDemoScenario.js` | Safe transactional reset |
| `scripts/verifyE2eDemoReadiness.js` | Pre-recording checks |
| `demo/assets/demo-resume-spec.md` | Resume content spec for Phase 3 PDF |
