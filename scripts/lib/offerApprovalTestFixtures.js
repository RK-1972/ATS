const offerManagementService = require("../../services/offerManagementService");
const recruitmentService = require("../../services/recruitmentService");
const workflowService = require("../../services/workflowService");
const offerApprovalWorkflowService = require("../../services/offerApprovalWorkflowService");
const { REQUISITION_STATUS } = require("../../constants/requisitionStatus");

const RUN_ID = Date.now();

function mockReq(user) {
  return {
    user: {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null,
      full_name: user.full_name || user.email_id
    }
  };
}

async function resolveOfferWorkspaceRecruiter(pool) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveOtherOfferWorkspaceRecruiter(pool, excludeCode) {
  const result = await pool.query(
    `SELECT u.user_id, u.employee_code, u.email_id, u.role_name, u.full_name
     FROM user_mstr u
     INNER JOIN employee_work_assignment ewa
       ON ewa.employee_code = u.employee_code AND ewa.is_active = TRUE
     INNER JOIN work_assignment_mstr wam
       ON wam.work_assignment_id = ewa.work_assignment_id AND wam.is_active = TRUE
     WHERE TRIM(COALESCE(wam.workspace_flag, '')) = 'showOfferWorkspace'
       AND u.role_name = 'Recruiter'
       AND u.employee_code <> $1
       AND COALESCE(u.is_active, TRUE) = TRUE
     ORDER BY u.user_id ASC
     LIMIT 1`,
    [excludeCode]
  );
  return result.rows[0] || null;
}

async function resolveTaLeadUser(pool) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr
     WHERE role_name IN ('TA Lead', 'TA Leader')
       AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveUserByEmployeeCode(pool, code) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, full_name
     FROM user_mstr WHERE employee_code = $1 LIMIT 1`,
    [code]
  );
  return result.rows[0] || null;
}

async function resolveValidGrade(pool) {
  const result = await pool.query(
    `SELECT name FROM md_records
     WHERE entity_type = 'grades' AND COALESCE(is_deleted, FALSE) = FALSE
     ORDER BY name ASC LIMIT 1`
  );
  return result.rows[0]?.name || "L4";
}

function pickAmountInPolicyBand(policy) {
  const minAmount = policy.min_amount === null ? null : Number(policy.min_amount);
  const maxAmount = policy.max_amount === null ? null : Number(policy.max_amount);

  if (Number.isFinite(minAmount) && Number.isFinite(maxAmount)) {
    return Math.floor((minAmount + maxAmount) / 2);
  }
  if (Number.isFinite(minAmount)) {
    return minAmount;
  }
  if (Number.isFinite(maxAmount)) {
    return Math.max(1, Math.floor(maxAmount * 0.5));
  }
  return 1400000;
}

async function listActiveOfferApprovalPolicies(pool) {
  const result = await pool.query(
    `SELECT
       p.policy_id,
       p.route_id,
       r.route_name,
       p.department,
       p.grade,
       p.designation,
       p.min_amount,
       p.max_amount,
       (
         SELECT COUNT(*)::int
         FROM approval_route_step s
         WHERE s.route_id = p.route_id
       ) AS step_count
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r ON r.route_id = p.route_id
     WHERE UPPER(COALESCE(r.applies_to, '')) = 'OFFER'
       AND COALESCE(p.is_active, TRUE) = TRUE
       AND COALESCE(r.status, 'Active') ILIKE 'active%'
     ORDER BY p.policy_id ASC`
  );
  return result.rows;
}

/**
 * Find two resolvable OFFER routes for the same criteria at different amounts.
 */
async function discoverOfferThresholdCrossingPair(pool) {
  const approvalRouteResolverService = require("../../services/approvalRouteResolverService");
  const policies = await listActiveOfferApprovalPolicies(pool);

  if (policies.length < 2) {
    return null;
  }

  for (let i = 0; i < policies.length; i += 1) {
    for (let j = 0; j < policies.length; j += 1) {
      if (i === j) {
        continue;
      }

      const lowPolicy = policies[i];
      const highPolicy = policies[j];
      if (String(lowPolicy.route_id) === String(highPolicy.route_id)) {
        continue;
      }

      const designation =
        lowPolicy.designation || highPolicy.designation || "Phase B Threshold Test";
      const criteriaBase = {
        department: lowPolicy.department ?? highPolicy.department ?? null,
        grade: lowPolicy.grade ?? highPolicy.grade ?? null,
        designation
      };

      const lowAmount = pickAmountInPolicyBand(lowPolicy);
      const highAmount = pickAmountInPolicyBand(highPolicy);

      if (!Number.isFinite(lowAmount) || !Number.isFinite(highAmount) || lowAmount === highAmount) {
        continue;
      }

      const orderedLow = Math.min(lowAmount, highAmount);
      const orderedHigh = Math.max(lowAmount, highAmount);

      let routeLow;
      let routeHigh;
      try {
        routeLow = await approvalRouteResolverService.resolveApprovalRoute(pool, "OFFER", {
          ...criteriaBase,
          amount: orderedLow
        });
        routeHigh = await approvalRouteResolverService.resolveApprovalRoute(pool, "OFFER", {
          ...criteriaBase,
          amount: orderedHigh
        });
      } catch {
        continue;
      }

      if (String(routeLow) === String(routeHigh)) {
        continue;
      }

      const stepsLow = await getApprovalRouteStepAssignees(pool, routeLow);
      const stepsHigh = await getApprovalRouteStepAssignees(pool, routeHigh);

      if (!stepsLow.length || !stepsHigh.length) {
        continue;
      }

      return {
        department: criteriaBase.department,
        grade: criteriaBase.grade,
        designation: criteriaBase.designation,
        lowAmount: orderedLow,
        highAmount: orderedHigh,
        routeLow,
        routeHigh,
        stepsLow,
        stepsHigh
      };
    }
  }

  return null;
}

async function getApprovalRouteStepAssignees(pool, routeId) {
  const result = await pool.query(
    `SELECT sequence_no, step_no, approver_employee_code, approval_type
     FROM approval_route_step
     WHERE route_id = $1
     ORDER BY COALESCE(sequence_no, step_no, 1) ASC`,
    [routeId]
  );

  return result.rows.map((row, index) => ({
    sequence: row.sequence_no ?? row.step_no ?? index + 1,
    approverEmployeeCode: row.approver_employee_code
      ? String(row.approver_employee_code).trim()
      : null,
    approvalType: row.approval_type || "Approver"
  }));
}

async function resolveOfferRouteTestContext(pool) {
  const result = await pool.query(
    `SELECT
       p.department,
       p.grade,
       p.designation,
       p.min_amount,
       p.max_amount,
       r.route_id
     FROM approval_route_policy p
     INNER JOIN approval_route_mstr r ON r.route_id = p.route_id
     WHERE UPPER(COALESCE(r.applies_to, '')) = 'OFFER'
       AND COALESCE(p.is_active, TRUE) = TRUE
       AND COALESCE(r.status, 'Active') ILIKE 'active%'
     ORDER BY p.policy_id DESC
     LIMIT 1`
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const minAmount = Number(row.min_amount || 0);
  const maxAmount = Number(row.max_amount || 0);
  let offeredCtc = 1400000;
  if (Number.isFinite(minAmount) && minAmount > 0) {
    offeredCtc = minAmount;
  }
  if (Number.isFinite(maxAmount) && maxAmount > offeredCtc) {
    offeredCtc = Math.floor((offeredCtc + maxAmount) / 2);
  }

  return {
    routeId: row.route_id,
    department: row.department || "Offer Workspace QA",
    grade: row.grade || (await resolveValidGrade(pool)),
    designation: row.designation || "Phase B Offer",
    offeredCtc
  };
}

async function allocateReqId(pool) {
  const result = await pool.query(
    `SELECT GREATEST(
      COALESCE((SELECT MAX(req_id) FROM rm_requisitions WHERE req_id IS NOT NULL), 0),
      COALESCE((SELECT MAX(req_id) FROM req_mstr), 0)
    ) + 1 AS next_id`
  );
  return result.rows[0].next_id;
}

/**
 * Creates a pending-approval offer through the real submit path (approval route expansion).
 */
async function createDisposableSubmittedOffer(
  pool,
  recruiter,
  recruiterReq,
  adminReq,
  suffix,
  options = {}
) {
  const routeContext = options.routeContext || await resolveOfferRouteTestContext(pool);
  if (!routeContext) {
    throw new Error("No active OFFER approval route policy found for Phase B fixtures.");
  }

  const offeredCtc = options.offeredCtc ?? routeContext.offeredCtc;

  const requisitionCode = `REQ-OB-${String(RUN_ID).slice(-8)}-${suffix}`;
  const reqId = await allocateReqId(pool);
  const grade = routeContext.grade;
  const department = routeContext.department;

  await pool.query(
    `INSERT INTO rm_requisitions (
      requisition_code, req_id, position_title, department, grade, headcount, req_status,
      budget_approved, created_by, modified_by
    ) VALUES ($1, $2, $3, $4, $5, 1, $6, 1500000, 'Phase B Verify', 'Phase B Verify')`,
    [
      requisitionCode,
      reqId,
      `Phase B ${suffix}`,
      department,
      grade,
      REQUISITION_STATUS.APPROVED
    ]
  );

  const reqMstrExists = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'req_mstr'
     ) AS exists`
  );
  if (reqMstrExists.rows[0]?.exists) {
    await pool.query(
      `INSERT INTO req_mstr (
        req_id, req_code, client_name, project_name, job_title, job_description,
        openings_count, req_status, created_by
      ) VALUES ($1, $2, 'Phase B', 'Offer Workspace QA', $3, 'Disposable requisition', 1, $4, 'Phase B Verify')
      ON CONFLICT (req_id) DO NOTHING`,
      [reqId, requisitionCode.replace(/^REQ-/, "REQ"), `Phase B ${suffix}`, REQUISITION_STATUS.APPROVED]
    );
  }

  await recruitmentService.assignRecruiter(
    pool,
    requisitionCode,
    recruiter.employee_code,
    adminReq
  );

  const candidateInsert = await pool.query(
    `INSERT INTO cand_mstr (
      first_name, last_name, email_id, mobile_number, primary_skill,
      total_experience, candidate_status, created_by
    ) VALUES ('PhaseB', $1, $2, '9876500099', 'Java', 4, 'Applied', 'Phase B Verify')
    RETURNING candidate_id`,
    [suffix, `phaseb.${RUN_ID}.${suffix}@example.com`]
  );
  const candidateId = candidateInsert.rows[0].candidate_id;

  const mapped = await recruitmentService.mapCandidate(
    pool,
    {
      candidate_id: candidateId,
      requisition_code: requisitionCode,
      stage_name: "Applied",
      source_type: "Direct"
    },
    recruiterReq
  );
  const mapping = mapped.mapping || mapped;
  const mapId = mapping.map_id || mapping.mapping_id;

  const created = await offerManagementService.createOffer(pool, {
    requisition_code: requisitionCode,
    mapping_id: mapId,
    candidate_id: candidateId,
    candidate_name: `Phase B Candidate ${suffix}`,
    position_title: routeContext.designation,
    offered_ctc: offeredCtc,
    approved_budget: Math.max(offeredCtc + 100000, 1500000),
    grade,
    department,
    expected_joining_date: new Date(Date.now() + 86400000 * 14).toISOString().slice(0, 10)
  }, recruiterReq);

  const offerId = created.offer?.offerId;
  const offer = created.offer;
  const instanceId = offer.workflowInstanceId;
  const version = Number(offer.version || 1);
  const stepTitle = `Approval Step 1 — ${offerId}`;

  const executionContext = {
    meta: {
      document_type: "OFFER",
      offer_id: offerId,
      ...offerApprovalWorkflowService.buildSubmissionVersionMetaPatch(version)
    }
  };

  await pool.query(
    `UPDATE wf_instances
     SET execution_context = $1, modified_on = NOW()
     WHERE instance_id = $2`,
    [JSON.stringify(executionContext), instanceId]
  );

  await pool.query(
    `UPDATE om_offers
     SET offer_status = 'Pending Approval', modified_on = NOW()
     WHERE offer_id = $1`,
    [offerId]
  );

  await pool.query(
    `INSERT INTO om_offer_approvals (
      offer_id, approval_step, approver_role, approval_status, sequence_order,
      version, version_status, effective_from
    ) VALUES ($1, $2, 'Approver', 'Pending', 1, $3, 'Published', NOW())`,
    [offerId, stepTitle, version]
  );

  const taskId = await workflowService.createTask(pool, instanceId, {
    stageKey: "approval",
    taskType: "approval",
    title: stepTitle,
    status: "Pending",
    assignee: recruiter.employee_code,
    assigneeRole: "Approver",
    assignedBy: "Phase B Verify",
    assignmentActive: true
  });

  await pool.query(
    `INSERT INTO om_offer_approvals (
      offer_id, approval_step, approver_role, approval_status, sequence_order,
      version, version_status, effective_from
    ) VALUES ($1, $2, 'Approver', 'Waiting', 2, $3, 'Published', NOW())`,
    [offerId, `Approval Step 2 — ${offerId}`, version]
  );

  await workflowService.createTask(pool, instanceId, {
    stageKey: "approval",
    taskType: "approval",
    title: `Approval Step 2 — ${offerId}`,
    status: "Waiting",
    assignee: recruiter.employee_code,
    assigneeRole: "Approver",
    assignedBy: "Phase B Verify",
    assignmentActive: false
  });

  return {
    offerId,
    taskId,
    stepTitle,
    instanceId,
    version,
    routeContext
  };
}

async function cleanupOffer(pool, offerId) {
  if (!offerId) {
    return;
  }
  const reqRow = await pool.query(
    `SELECT requisition_code, candidate_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const requisitionCode = reqRow.rows[0]?.requisition_code;
  const letter = await pool.query(
    `SELECT letter_id FROM om_offer_letters WHERE offer_id = $1`,
    [offerId]
  );
  for (const row of letter.rows) {
    await pool.query(`DELETE FROM om_offer_letter_ctc WHERE letter_id = $1`, [row.letter_id]);
  }
  await pool.query(`DELETE FROM om_offer_letters WHERE offer_id = $1`, [offerId]);
  await pool.query(
    `DELETE FROM om_generated_documents WHERE business_object_id = $1`,
    [offerId]
  );
  await pool.query(`DELETE FROM om_offer_revisions WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_history WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_approvals WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_compensation WHERE offer_id = $1`, [offerId]);
  await pool.query(`DELETE FROM om_offer_acceptance WHERE offer_id = $1`, [offerId]);
  await pool.query(
    `DELETE FROM et_task_history WHERE task_id IN (
       SELECT task_id FROM et_tasks WHERE business_object_id = $1
     )`,
    [offerId]
  ).catch(() => undefined);
  await pool.query(`DELETE FROM et_tasks WHERE business_object_id = $1`, [offerId]).catch(() => undefined);
  const inst = await pool.query(
    `SELECT workflow_instance_id FROM om_offers WHERE offer_id = $1`,
    [offerId]
  );
  const instanceId = inst.rows[0]?.workflow_instance_id;
  if (instanceId) {
    await pool.query(
      `DELETE FROM wf_assignments WHERE task_id IN (SELECT task_id FROM wf_tasks WHERE instance_id = $1)`,
      [instanceId]
    );
    await pool.query(`DELETE FROM wf_tasks WHERE instance_id = $1`, [instanceId]);
    await pool.query(`DELETE FROM wf_history WHERE instance_id = $1`, [instanceId]);
    await pool.query(`DELETE FROM wf_instances WHERE instance_id = $1`, [instanceId]);
  }
  await pool.query(`DELETE FROM om_offers WHERE offer_id = $1`, [offerId]);

  if (requisitionCode) {
    await pool.query(
      `DELETE FROM rm_candidate_mappings WHERE requisition_code = $1`,
      [requisitionCode]
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM rm_recruiter_assignments WHERE requisition_code = $1`,
      [requisitionCode]
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM rm_requisitions WHERE requisition_code = $1`,
      [requisitionCode]
    ).catch(() => undefined);
  }
}

module.exports = {
  mockReq,
  resolveOfferWorkspaceRecruiter,
  resolveOtherOfferWorkspaceRecruiter,
  resolveTaLeadUser,
  resolveUserByEmployeeCode,
  listActiveOfferApprovalPolicies,
  discoverOfferThresholdCrossingPair,
  getApprovalRouteStepAssignees,
  createDisposableSubmittedOffer,
  cleanupOffer
};
