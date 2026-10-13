/**
 * Disposable negative-control Recruiter for offer access-hardening verification.
 *
 *   verifyOfferApiAccessHardening.js
 *   verifyOfferLetterAccessHardening.js
 *
 * Usage:
 *   node scripts/setupOfferAccessHardeningNegRecruiter.js           # setup (writes only when safe)
 *   node scripts/setupOfferAccessHardeningNegRecruiter.js --verify  # read-only report
 *   node scripts/setupOfferAccessHardeningNegRecruiter.js --reset   # deactivate OFFER_RECRUITER on disposable only
 *   node scripts/setupOfferAccessHardeningNegRecruiter.js --teardown  # reset + deactivate disposable user account
 */
require("dotenv").config();

const { createPool, ensureDemoUser } = require("../demo/e2eDemoLib");

const MARKER = "E2E_OFFER_ACCESS_SETUP";
const EMPLOYEE_CODE = "E2E-OFFER-ACCESS-NEG";

const EXPECTED_IDENTITY = {
  employeeCode: EMPLOYEE_CODE,
  fullName: "E2E Offer Access Negative Control",
  email: "e2e.offer.access.neg@optalynx.local",
  roleName: "Recruiter"
};

const PASSWORD =
  process.env.E2E_OFFER_ACCESS_NEG_PASSWORD ||
  process.env.E2E_DEMO_PASSWORD ||
  "VerifyPass1!";

async function getWorkAssignmentId(pool, assignmentCode) {
  const result = await pool.query(
    `SELECT work_assignment_id
     FROM work_assignment_mstr
     WHERE assignment_code = $1
     LIMIT 1`,
    [assignmentCode]
  );
  return result.rows[0]?.work_assignment_id || null;
}

/** Mirrors verifyOfferApiAccessHardening.js resolveRecruiterWithoutOfferWorkspace */
async function resolveApiNegativeRecruiter(pool) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.is_active = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       )
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

/** Mirrors verifyOfferLetterAccessHardening.js resolvePrimaryRecruiter */
async function resolvePrimaryRecruiter(pool) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

/** Mirrors verifyOfferLetterAccessHardening.js resolveForeignRecruiter */
async function resolveForeignRecruiter(pool, excludeEmployeeCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.secondary_role, u.full_name
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND u.employee_code <> $1
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.is_active = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       )
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [excludeEmployeeCode]
  );
  return result.rows[0] || null;
}

async function disposableHasShowOfferWorkspace(pool, employeeCode) {
  const result = await pool.query(
    `SELECT 1
     FROM employee_work_assignment ewa
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id
      AND wam.is_active = TRUE
     WHERE ewa.employee_code = $1
       AND ewa.is_active = TRUE
       AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
     LIMIT 1`,
    [employeeCode]
  );
  return result.rows.length > 0;
}

async function loadDisposableUserRow(pool) {
  const result = await pool.query(
    `SELECT user_id, employee_code, full_name, email_id, role_name, is_active
     FROM user_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [EMPLOYEE_CODE]
  );
  return result.rows[0] || null;
}

function identityMatchesExpected(row) {
  if (!row) {
    return { ok: false, reason: "user does not exist" };
  }

  const email = String(row.email_id || "").trim().toLowerCase();
  const expectedEmail = EXPECTED_IDENTITY.email.trim().toLowerCase();
  if (email !== expectedEmail) {
    return {
      ok: false,
      reason: `email_id mismatch (found ${row.email_id}, expected ${EXPECTED_IDENTITY.email})`
    };
  }

  if (String(row.role_name || "").trim() !== EXPECTED_IDENTITY.roleName) {
    return {
      ok: false,
      reason: `role_name mismatch (found ${row.role_name}, expected ${EXPECTED_IDENTITY.roleName})`
    };
  }

  if (String(row.full_name || "").trim() !== EXPECTED_IDENTITY.fullName) {
    return {
      ok: false,
      reason: `full_name mismatch (found ${row.full_name}, expected ${EXPECTED_IDENTITY.fullName})`
    };
  }

  return { ok: true };
}

async function listOtherNegativeRecruiters(pool) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id
     FROM user_mstr u
     WHERE u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
       AND u.employee_code <> $1
       AND NOT EXISTS (
         SELECT 1
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
          AND wam.is_active = TRUE
         WHERE ewa.employee_code = u.employee_code
           AND ewa.is_active = TRUE
           AND TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       )
     ORDER BY u.user_id ASC`,
    [EMPLOYEE_CODE]
  );
  return result.rows;
}

async function readMasterRecords(pool) {
  const offerRecruiter = await pool.query(
    `SELECT work_assignment_id, assignment_code, workspace_flag, is_active
     FROM work_assignment_mstr
     WHERE assignment_code = 'OFFER_RECRUITER'
     LIMIT 1`
  );
  const recruiter = await pool.query(
    `SELECT work_assignment_id, assignment_code, workspace_flag, is_active
     FROM work_assignment_mstr
     WHERE assignment_code = 'RECRUITER'
     LIMIT 1`
  );
  return {
    offerRecruiterMaster: offerRecruiter.rows[0] || null,
    recruiterMaster: recruiter.rows[0] || null
  };
}

async function buildVerificationReport(pool) {
  const masters = await readMasterRecords(pool);
  const disposableRow = await loadDisposableUserRow(pool);
  const primary = await resolvePrimaryRecruiter(pool);
  const apiNegative = await resolveApiNegativeRecruiter(pool);
  const foreignNegative = primary
    ? await resolveForeignRecruiter(pool, primary.employee_code)
    : null;

  return {
    employeeCode: EMPLOYEE_CODE,
    masters,
    disposableUser: disposableRow,
    disposableIdentityConfirmed: disposableRow
      ? identityMatchesExpected(disposableRow).ok
      : false,
    disposableHasShowOfferWorkspace: disposableRow
      ? await disposableHasShowOfferWorkspace(pool, EMPLOYEE_CODE)
      : null,
    verifyOfferApiAccessHardeningWouldSelect: apiNegative,
    verifyOfferLetterAccessHardeningWouldSelectForeign: foreignNegative,
    verifyOfferLetterAccessHardeningPrimaryRecruiter: primary,
    otherNegativeRecruiters: await listOtherNegativeRecruiters(pool)
  };
}

function abortSelectionMismatch(report) {
  const apiCode = report.verifyOfferApiAccessHardeningWouldSelect?.employee_code || null;
  const foreignCode =
    report.verifyOfferLetterAccessHardeningWouldSelectForeign?.employee_code || null;

  throw new Error(
    `Abort: verification scripts would not both select ${EMPLOYEE_CODE}. ` +
      `API negative query selects: ${apiCode || "(none)"}. ` +
      `Letter foreign query selects: ${foreignCode || "(none)"}. ` +
      `Remove or reassign other recruiters without showOfferWorkspace, or fix disposable user_id ordering.`
  );
}

/**
 * Before any write: ensure disposable will be chosen by both script queries after setup.
 */
async function assertSelectionSafeForSetup(pool, disposableExists) {
  const report = await buildVerificationReport(pool);

  if (!report.verifyOfferLetterAccessHardeningPrimaryRecruiter) {
    throw new Error(
      "Abort: no primary Recruiter with showOfferWorkspace (letter script fixture requirement)."
    );
  }

  if (!report.masters.offerRecruiterMaster) {
    throw new Error("Abort: work_assignment_mstr OFFER_RECRUITER master is missing.");
  }

  if (disposableExists) {
    if (report.verifyOfferApiAccessHardeningWouldSelect?.employee_code !== EMPLOYEE_CODE) {
      abortSelectionMismatch(report);
    }
    if (report.verifyOfferLetterAccessHardeningWouldSelectForeign?.employee_code !== EMPLOYEE_CODE) {
      abortSelectionMismatch(report);
    }
    return report;
  }

  const others = report.otherNegativeRecruiters;
  if (others.length > 0) {
    throw new Error(
      `Abort: cannot create ${EMPLOYEE_CODE} while other recruiters lack showOfferWorkspace. ` +
        `API script would select ${others[0].employee_code} (user_id ${others[0].user_id}). ` +
        `Resolve those accounts first.`
    );
  }

  if (report.verifyOfferApiAccessHardeningWouldSelect) {
    abortSelectionMismatch(report);
  }

  return report;
}

async function assertSafeToWriteUser(pool) {
  const existing = await loadDisposableUserRow(pool);

  if (!existing) {
    return { exists: false, row: null };
  }

  const identity = identityMatchesExpected(existing);
  if (!identity.ok) {
    throw new Error(
      `Abort: ${EMPLOYEE_CODE} already exists but is not a confirmed disposable identity (${identity.reason}). ` +
        "No updates were applied."
    );
  }

  if (await disposableHasShowOfferWorkspace(pool, EMPLOYEE_CODE)) {
    throw new Error(
      `Abort: ${EMPLOYEE_CODE} already has an active showOfferWorkspace assignment. ` +
        "Run --reset after the letter verification script, then retry setup."
    );
  }

  return { exists: true, row: existing };
}

async function runSetup(pool) {
  const userState = await assertSafeToWriteUser(pool);
  await assertSelectionSafeForSetup(pool, userState.exists);

  const userResult = await ensureDemoUser(pool, EXPECTED_IDENTITY, PASSWORD);

  const after = await buildVerificationReport(pool);
  if (after.verifyOfferApiAccessHardeningWouldSelect?.employee_code !== EMPLOYEE_CODE) {
    abortSelectionMismatch(after);
  }
  if (after.verifyOfferLetterAccessHardeningWouldSelectForeign?.employee_code !== EMPLOYEE_CODE) {
    abortSelectionMismatch(after);
  }
  if (after.disposableHasShowOfferWorkspace) {
    throw new Error(
      `Abort: ${EMPLOYEE_CODE} has showOfferWorkspace after setup (unexpected).`
    );
  }

  return { userResult, report: after };
}

async function runReset(pool) {
  if (EMPLOYEE_CODE !== "E2E-OFFER-ACCESS-NEG") {
    throw new Error("Abort: internal employee code guard failed.");
  }

  const row = await loadDisposableUserRow(pool);
  if (!row) {
    throw new Error(`Abort: disposable user ${EMPLOYEE_CODE} does not exist; nothing to reset.`);
  }

  const identity = identityMatchesExpected(row);
  if (!identity.ok) {
    throw new Error(
      `Abort: refusing --reset on ${EMPLOYEE_CODE} (${identity.reason}).`
    );
  }

  const waId = await getWorkAssignmentId(pool, "OFFER_RECRUITER");
  if (!waId) {
    return {
      employeeCode: EMPLOYEE_CODE,
      offerRecruiterMaster: null,
      rowsToDeactivate: 0,
      rowsDeactivated: 0
    };
  }

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM employee_work_assignment
     WHERE employee_code = $1
       AND work_assignment_id = $2
       AND is_active = TRUE`,
    [EMPLOYEE_CODE, waId]
  );
  const rowsToDeactivate = countResult.rows[0]?.count || 0;

  if (rowsToDeactivate === 0) {
    return {
      employeeCode: EMPLOYEE_CODE,
      offerRecruiterMaster: "OFFER_RECRUITER",
      rowsToDeactivate: 0,
      rowsDeactivated: 0
    };
  }

  const updateResult = await pool.query(
    `UPDATE employee_work_assignment
     SET is_active = FALSE,
         effective_to = CURRENT_DATE,
         updated_by = $3,
         updated_on = NOW()
     WHERE employee_code = $1
       AND work_assignment_id = $2
       AND is_active = TRUE`,
    [EMPLOYEE_CODE, waId, MARKER]
  );

  return {
    employeeCode: EMPLOYEE_CODE,
    offerRecruiterMaster: "OFFER_RECRUITER",
    rowsToDeactivate,
    rowsDeactivated: updateResult.rowCount
  };
}

async function runTeardown(pool) {
  const resetResult = await runReset(pool);

  const row = await loadDisposableUserRow(pool);
  if (!row) {
    throw new Error(`Abort: disposable user ${EMPLOYEE_CODE} missing during teardown.`);
  }

  const identity = identityMatchesExpected(row);
  if (!identity.ok) {
    throw new Error(`Abort: teardown refused (${identity.reason}).`);
  }

  const userUpdate = await pool.query(
    `UPDATE user_mstr
     SET is_active = FALSE
     WHERE employee_code = $1
       AND is_active = TRUE`,
    [EMPLOYEE_CODE]
  );

  return {
    ...resetResult,
    userAccountRowsDeactivated: userUpdate.rowCount
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const verifyOnly = args.has("--verify");
  const resetOnly = args.has("--reset");
  const teardown = args.has("--teardown");

  if (verifyOnly && (resetOnly || teardown)) {
    throw new Error("Use only one of: --verify, --reset, --teardown, or default setup.");
  }
  if (resetOnly && teardown) {
    throw new Error("Use --teardown alone (includes OFFER_RECRUITER reset) or --reset only.");
  }

  const pool = createPool();

  try {
    if (verifyOnly) {
      const report = await buildVerificationReport(pool);
      console.log(JSON.stringify({ action: "verify", report }, null, 2));
      return;
    }

    if (resetOnly) {
      const result = await runReset(pool);
      console.log(JSON.stringify({ action: "reset", result }, null, 2));
      return;
    }

    if (teardown) {
      const result = await runTeardown(pool);
      console.log(JSON.stringify({ action: "teardown", result }, null, 2));
      return;
    }

    const { userResult, report } = await runSetup(pool);
    console.log(JSON.stringify({ action: "setup", userResult, report }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
