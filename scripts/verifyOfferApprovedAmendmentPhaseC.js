/**
 * Phase C — Approved-but-unreleased offer amendment.
 * Run: node scripts/verifyOfferApprovedAmendmentPhaseC.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const offerManagementService = require("../services/offerManagementService");
const offerLetterRepository = require("../repositories/offerLetterRepository");
const documentMergeService = require("../services/documentMergeService");
const generatedDocumentRepository = require("../repositories/generatedDocumentRepository");
const offerApprovalWorkflowService = require("../services/offerApprovalWorkflowService");
const {
  MIRROR_VERSION_STATUS_PUBLISHED,
  MIRROR_VERSION_STATUS_SUPERSEDED
} = offerApprovalWorkflowService;
const {
  createDisposableSubmittedOffer,
  cleanupOffer,
  mockReq,
  resolveOfferWorkspaceRecruiter,
  resolveOtherOfferWorkspaceRecruiter,
  resolveUserByEmployeeCode
} = require("./lib/offerApprovalTestFixtures");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function resolveApproverReq(employeeCode, fallbackReq) {
  if (!employeeCode) {
    return fallbackReq;
  }
  const user = await resolveUserByEmployeeCode(pool, employeeCode);
  return user ? mockReq(user) : fallbackReq;
}

async function approveOfferThroughChain(pool, offerId, instanceId, defaultReq) {
  for (let guard = 0; guard < 12; guard += 1) {
    const offer = await offerManagementService.getOffer(pool, offerId, defaultReq);
    if (offer.offerStatus === "Approved") {
      return offer;
    }

    const pendingTask = await pool.query(
      `SELECT t.task_id, t.title, a.assignee
       FROM wf_tasks t
       INNER JOIN wf_assignments a ON a.task_id = t.task_id AND a.active = TRUE
       WHERE t.instance_id = $1 AND LOWER(t.status) = 'pending'
       ORDER BY t.task_id ASC
       LIMIT 1`,
      [instanceId]
    );

    const row = pendingTask.rows[0];
    if (!row?.task_id) {
      throw new Error(`No pending approval task for offer ${offerId}`);
    }

    const assigneeReq = await resolveApproverReq(row.assignee, defaultReq);
    await offerManagementService.approveOffer(
      pool,
      offerId,
      row.title,
      "Phase C approval step",
      assigneeReq
    );
  }

  throw new Error(`Offer ${offerId} did not reach Approved status`);
}

async function main() {
  console.log("=== Offer Approved Amendment (Phase C) ===\n");

  const recruiter = await resolveOfferWorkspaceRecruiter(pool);
  if (!recruiter) {
    fail("fixtures", "Recruiter with showOfferWorkspace required");
    await pool.end();
    return;
  }

  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC LIMIT 1`
  ).then((result) => result.rows[0]);

  if (!admin) {
    fail("fixtures", "Admin user required");
    await pool.end();
    return;
  }

  const recruiterReq = mockReq(recruiter);
  const adminReq = mockReq(admin);
  const otherRecruiter = await resolveOtherOfferWorkspaceRecruiter(pool, recruiter.employee_code);

  console.log("--- Successful amendment ---");
  const amendFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-amend"
  );

  try {
    await approveOfferThroughChain(
      pool,
      amendFixture.offerId,
      amendFixture.instanceId,
      recruiterReq
    );

    const priorVersion = (
      await pool.query(`SELECT version, offered_ctc FROM om_offers WHERE offer_id = $1`, [
        amendFixture.offerId
      ])
    ).rows[0];

    await offerManagementService.amendApprovedUnreleasedOffer(
      pool,
      amendFixture.offerId,
      {
        offered_ctc: Number(priorVersion.offered_ctc) + 50000,
        reason: "Phase C commercial amendment"
      },
      recruiterReq
    );

    const after = await pool.query(
      `SELECT offer_status, version, offered_ctc FROM om_offers WHERE offer_id = $1`,
      [amendFixture.offerId]
    );
    const row = after.rows[0];

    if (String(row.offer_status) === "Pending Approval") {
      pass("amend: offer returns to Pending Approval");
    } else {
      fail("amend: offer status", row.offer_status);
    }

    if (Number(row.version) > Number(priorVersion.version)) {
      pass("amend: submission version incremented");
    } else {
      fail("amend: version", JSON.stringify({ prior: priorVersion.version, after: row.version }));
    }

    if (Number(row.offered_ctc) === Number(priorVersion.offered_ctc) + 50000) {
      pass("amend: offered CTC updated");
    } else {
      fail("amend: CTC", row.offered_ctc);
    }

    const pendingMirror = await pool.query(
      `SELECT COUNT(*) AS count FROM om_offer_approvals
       WHERE offer_id = $1 AND approval_status = 'Pending'
         AND version_status = $2 AND version = $3`,
      [amendFixture.offerId, MIRROR_VERSION_STATUS_PUBLISHED, row.version]
    );
    if (Number(pendingMirror.rows[0]?.count) === 1) {
      pass("amend: fresh Published mirror has one Pending step");
    } else {
      fail("amend: pending mirror", pendingMirror.rows[0]?.count);
    }

    const superseded = await pool.query(
      `SELECT COUNT(*) AS count FROM om_offer_approvals
       WHERE offer_id = $1 AND version_status = $2 AND approval_status = 'Approved'`,
      [amendFixture.offerId, MIRROR_VERSION_STATUS_SUPERSEDED]
    );
    if (Number(superseded.rows[0]?.count) >= 1) {
      pass("amend: prior approved mirror rows preserved as Superseded");
    } else {
      fail("amend: superseded history", superseded.rows[0]?.count);
    }

    const pendingTask = await pool.query(
      `SELECT task_id FROM wf_tasks
       WHERE instance_id = $1 AND LOWER(status) = 'pending'`,
      [amendFixture.instanceId]
    );
    if (pendingTask.rows.length >= 1) {
      pass("amend: fresh workflow approval task Pending");
    } else {
      fail("amend: workflow tasks", "no pending task");
    }

    try {
      await offerManagementService.releaseOffer(pool, amendFixture.offerId, {}, recruiterReq);
      fail("release before reapproval", "expected throw");
    } catch (error) {
      if (error.status === 409) {
        pass("release blocked until reapproval (409)");
      } else {
        fail("release before reapproval", `status=${error.status}`);
      }
    }
  } catch (error) {
    fail("successful amendment flow", error.message);
  }
  await cleanupOffer(pool, amendFixture.offerId);

  console.log("\n--- Unauthorized amendment ---");
  const authFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-auth"
  );
  try {
    await approveOfferThroughChain(
      pool,
      authFixture.offerId,
      authFixture.instanceId,
      recruiterReq
    );

    if (!otherRecruiter) {
      pass("unauthorized amend: skipped (no second recruiter fixture)");
    } else {
      try {
        await offerManagementService.amendApprovedUnreleasedOffer(
          pool,
          authFixture.offerId,
          { offered_ctc: 2000000, reason: "unauthorized" },
          mockReq(otherRecruiter)
        );
        fail("unauthorized amend", "expected 403");
      } catch (error) {
        if (error.status === 403) {
          pass("unauthorized amend rejected (403)");
        } else {
          fail("unauthorized amend", `status=${error.status}`);
        }
      }
    }
  } catch (error) {
    fail("unauthorized amend setup", error.message);
  }
  await cleanupOffer(pool, authFixture.offerId);

  console.log("\n--- Released offer amendment rejected ---");
  const relFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-rel"
  );
  try {
    await approveOfferThroughChain(
      pool,
      relFixture.offerId,
      relFixture.instanceId,
      recruiterReq
    );
    await offerManagementService.releaseOffer(pool, relFixture.offerId, {}, recruiterReq);

    try {
      await offerManagementService.amendApprovedUnreleasedOffer(
        pool,
        relFixture.offerId,
        { offered_ctc: 2500000, reason: "after release" },
        recruiterReq
      );
      fail("amend released offer", "expected throw");
    } catch (error) {
      if (error.status === 409) {
        pass("amend blocked for Released offer (409)");
      } else {
        fail("amend released offer", `status=${error.status}`);
      }
    }
  } catch (error) {
    fail("released amend guard setup", error.message);
  }
  await cleanupOffer(pool, relFixture.offerId);

  console.log("\n--- Clarification blocks amendment ---");
  const clrFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-clr"
  );
  try {
    await approveOfferThroughChain(
      pool,
      clrFixture.offerId,
      clrFixture.instanceId,
      recruiterReq
    );

    await pool.query(
      `UPDATE wf_instances SET status = 'Paused', modified_on = NOW() WHERE instance_id = $1`,
      [clrFixture.instanceId]
    );

    try {
      await offerManagementService.amendApprovedUnreleasedOffer(
        pool,
        clrFixture.offerId,
        { offered_ctc: 1800000, reason: "during clarification" },
        recruiterReq
      );
      fail("amend during clarification", "expected 409");
    } catch (error) {
      if (error.status === 409) {
        pass("clarification blocks amendment (409)");
      } else {
        fail("amend during clarification", `status=${error.status}`);
      }
    }
  } catch (error) {
    fail("clarification amend setup", error.message);
  }
  await cleanupOffer(pool, clrFixture.offerId);

  console.log("\n--- Stale approval after amendment ---");
  const staleFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-stale"
  );
  try {
    await approveOfferThroughChain(
      pool,
      staleFixture.offerId,
      staleFixture.instanceId,
      recruiterReq
    );

    const preAmendMirror = await pool.query(
      `SELECT approval_step FROM om_offer_approvals
       WHERE offer_id = $1 AND approval_status = 'Approved'
         AND version_status = $2
       ORDER BY approval_id DESC LIMIT 1`,
      [staleFixture.offerId, MIRROR_VERSION_STATUS_PUBLISHED]
    );
    const staleStepTitle = preAmendMirror.rows[0]?.approval_step;

    const staleCtc = (
      await pool.query(`SELECT offered_ctc FROM om_offers WHERE offer_id = $1`, [
        staleFixture.offerId
      ])
    ).rows[0]?.offered_ctc;

    await offerManagementService.amendApprovedUnreleasedOffer(
      pool,
      staleFixture.offerId,
      {
        offered_ctc: Number(staleCtc) + 80000,
        reason: "Phase C stale approval test"
      },
      recruiterReq
    );

    if (staleStepTitle) {
      try {
        await offerManagementService.approveOffer(
          pool,
          staleFixture.offerId,
          staleStepTitle,
          "stale after amendment",
          recruiterReq
        );
        fail("stale approveOffer after amendment", "expected throw");
      } catch (error) {
        if (error.status === 409 || error.status === 404) {
          pass(`stale approveOffer rejected after amendment (${error.status})`);
        } else {
          fail("stale approveOffer after amendment", `status=${error.status}`);
        }
      }
    } else {
      fail("stale approval setup", "no prior approved mirror step");
    }
  } catch (error) {
    fail("stale approval flow", error.message);
  }
  await cleanupOffer(pool, staleFixture.offerId);

  console.log("\n--- Reapproval enables release ---");
  const releaseFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-rel2"
  );
  try {
    await approveOfferThroughChain(
      pool,
      releaseFixture.offerId,
      releaseFixture.instanceId,
      recruiterReq
    );

    const approvedCtc = (
      await pool.query(`SELECT offered_ctc FROM om_offers WHERE offer_id = $1`, [
        releaseFixture.offerId
      ])
    ).rows[0]?.offered_ctc;

    await offerManagementService.amendApprovedUnreleasedOffer(
      pool,
      releaseFixture.offerId,
      {
        offered_ctc: Number(approvedCtc) + 25000,
        reason: "Phase C reapproval release test"
      },
      recruiterReq
    );

    await approveOfferThroughChain(
      pool,
      releaseFixture.offerId,
      releaseFixture.instanceId,
      recruiterReq
    );

    await offerManagementService.releaseOffer(pool, releaseFixture.offerId, {}, recruiterReq);
    const released = await offerManagementService.getOffer(pool, releaseFixture.offerId, recruiterReq);
    if (released.offerStatus === "Released") {
      pass("release succeeds after amendment reapproval");
    } else {
      fail("release after reapproval", released.offerStatus);
    }
  } catch (error) {
    fail("reapproval release flow", error.message);
  }
  await cleanupOffer(pool, releaseFixture.offerId);

  console.log("\n--- Phase D: approved_date scoped to current Published submission ---");
  const dateFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-date"
  );
  try {
    await approveOfferThroughChain(
      pool,
      dateFixture.offerId,
      dateFixture.instanceId,
      recruiterReq
    );

    const offerBefore = (
      await pool.query(
        `SELECT version, offered_ctc FROM om_offers WHERE offer_id = $1`,
        [dateFixture.offerId]
      )
    ).rows[0];

    await offerManagementService.amendApprovedUnreleasedOffer(
      pool,
      dateFixture.offerId,
      {
        offered_ctc: Number(offerBefore.offered_ctc) + 10000,
        reason: "Phase D approved_date regression"
      },
      recruiterReq
    );

    await pool.query(
      `UPDATE om_offer_approvals
       SET approved_on = NOW() + INTERVAL '10 days'
       WHERE offer_id = $1
         AND version_status = $2
         AND LOWER(approval_status) = 'approved'`,
      [dateFixture.offerId, MIRROR_VERSION_STATUS_SUPERSEDED]
    );

    await approveOfferThroughChain(
      pool,
      dateFixture.offerId,
      dateFixture.instanceId,
      recruiterReq
    );

    const offerVersion = (
      await pool.query(`SELECT version FROM om_offers WHERE offer_id = $1`, [
        dateFixture.offerId
      ])
    ).rows[0]?.version;

    const detailRow = await offerLetterRepository.findOfferLetterDetail(
      pool,
      dateFixture.offerId
    );
    const currentMax = (
      await pool.query(
        `SELECT MAX(approved_on) AS max_on
         FROM om_offer_approvals
         WHERE offer_id = $1
           AND version_status = $2
           AND version = $3
           AND LOWER(approval_status) = 'approved'`,
        [
          dateFixture.offerId,
          MIRROR_VERSION_STATUS_PUBLISHED,
          Number(offerVersion)
        ]
      )
    ).rows[0]?.max_on;

    const supersededMax = (
      await pool.query(
        `SELECT MAX(approved_on) AS max_on
         FROM om_offer_approvals
         WHERE offer_id = $1
           AND version_status = $2
         AND LOWER(approval_status) = 'approved'`,
        [dateFixture.offerId, MIRROR_VERSION_STATUS_SUPERSEDED]
      )
    ).rows[0]?.max_on;

    if (
      detailRow?.approved_date
      && currentMax
      && new Date(detailRow.approved_date).getTime() === new Date(currentMax).getTime()
    ) {
      pass("approved_date matches current Published submission only");
    } else {
      fail(
        "approved_date scoping",
        `detail=${detailRow?.approved_date} current=${currentMax}`
      );
    }

    if (
      supersededMax
      && new Date(supersededMax).getTime() > new Date(currentMax).getTime()
    ) {
      pass("superseded approval timestamps do not override approved_date");
    } else {
      fail("superseded bait", "expected superseded MAX > current MAX");
    }
  } catch (error) {
    fail("approved_date regression", error.message);
  }
  await cleanupOffer(pool, dateFixture.offerId);

  console.log("\n--- Phase D: superseded generated documents not served as current ---");
  const docFixture = await createDisposableSubmittedOffer(
    pool,
    recruiter,
    recruiterReq,
    adminReq,
    "c-doc"
  );
  try {
    await approveOfferThroughChain(
      pool,
      docFixture.offerId,
      docFixture.instanceId,
      recruiterReq
    );

    const documentId = `GD-PHASE-D-${Date.now()}`;
    await generatedDocumentRepository.insertGeneratedDocument(pool, {
      document_id: documentId,
      document_type: "Offer Letter",
      file_type: generatedDocumentRepository.FILE_TYPES.PDF,
      business_object_type: "OFFER",
      business_object_id: docFixture.offerId,
      document_path: `offer-letters/${docFixture.offerId}/stale.pdf`,
      status: generatedDocumentRepository.DOCUMENT_STATUSES.GENERATED
    });

    const approvedCtc = (
      await pool.query(`SELECT offered_ctc FROM om_offers WHERE offer_id = $1`, [
        docFixture.offerId
      ])
    ).rows[0]?.offered_ctc;

    await offerManagementService.amendApprovedUnreleasedOffer(
      pool,
      docFixture.offerId,
      {
        offered_ctc: Number(approvedCtc) + 5000,
        reason: "Phase D document supersede"
      },
      recruiterReq
    );

    const staleRow = await generatedDocumentRepository.findById(pool, documentId);
    if (staleRow?.status === generatedDocumentRepository.DOCUMENT_STATUSES.SUPERSEDED) {
      pass("amendment marks prior generated documents Superseded");
    } else {
      fail("document supersede status", staleRow?.status);
    }

    try {
      await documentMergeService.downloadGeneratedDocument(pool, documentId);
      fail("superseded document download", "expected 404");
    } catch (error) {
      if (error.status === 404) {
        pass("superseded document download rejected (404)");
      } else {
        fail("superseded document download", `status=${error.status}`);
      }
    }
  } catch (error) {
    fail("generated document supersede flow", error.message);
  }
  await cleanupOffer(pool, docFixture.offerId);

  console.log("\nDone.");
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  pool.end();
});
