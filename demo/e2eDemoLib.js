const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const approvalRouteRepository = require("../repositories/approvalRouteRepository");

const MANIFEST_PATH = path.join(__dirname, "e2e-demo.manifest.json");

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function createPool() {
  return new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
}

function resolveDemoPassword(manifest) {
  const envVar = manifest?.users?.passwordEnvVar || "E2E_DEMO_PASSWORD";
  return process.env[envVar] || manifest?.users?.defaultPassword || "Demo@Optalynx2026";
}

function indexUsers(manifest) {
  const byKey = new Map();
  const byEmployeeCode = new Map();

  for (const account of manifest.users.accounts) {
    byKey.set(account.key, account);
    byEmployeeCode.set(account.employeeCode, account);
  }

  return { byKey, byEmployeeCode };
}

async function ensureDemoUser(pool, account, password) {
  const existing = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [account.employeeCode]
  );

  const passwordHash = await bcrypt.hash(password, 10);

  if (existing.rows[0]) {
    await pool.query(
      `UPDATE user_mstr
       SET full_name = $2,
           email_id = $3,
           role_name = $4,
           password_hash = $5,
           is_active = TRUE
       WHERE employee_code = $1`,
      [
        account.employeeCode,
        account.fullName,
        account.email,
        account.roleName,
        passwordHash
      ]
    );
    return { created: false, employeeCode: account.employeeCode };
  }

  await pool.query(
    `INSERT INTO user_mstr (
       employee_code, full_name, email_id, password_hash, role_name, is_active
     ) VALUES ($1, $2, $3, $4, $5, TRUE)`,
    [
      account.employeeCode,
      account.fullName,
      account.email,
      passwordHash,
      account.roleName
    ]
  );

  return { created: true, employeeCode: account.employeeCode };
}

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

async function ensureEmployeeWorkAssignment(pool, employeeCode, assignmentCode) {
  const workAssignmentId = await getWorkAssignmentId(pool, assignmentCode);

  if (!workAssignmentId) {
    throw new Error(`Missing work assignment master: ${assignmentCode}`);
  }

  const existing = await pool.query(
    `SELECT employee_work_assignment_id
     FROM employee_work_assignment
     WHERE employee_code = $1
       AND work_assignment_id = $2
       AND is_active = TRUE
     LIMIT 1`,
    [employeeCode, workAssignmentId]
  );

  if (existing.rows[0]) {
    return { created: false, assignmentCode };
  }

  await pool.query(
    `INSERT INTO employee_work_assignment (
       employee_code, work_assignment_id, is_active, created_by
     ) VALUES ($1, $2, TRUE, 'DEMO_E2E_SETUP')`,
    [employeeCode, workAssignmentId]
  );

  return { created: true, assignmentCode };
}

async function findDemoApprovalRoute(pool, routeName) {
  const result = await pool.query(
    `SELECT route_id, route_name, applies_to, status
     FROM approval_route_mstr
     WHERE route_name = $1
     LIMIT 1`,
    [routeName]
  );
  return result.rows[0] || null;
}

async function ensureDemoApprovalRoute(pool, routeConfig, usersByKey) {
  const actor = "DEMO_E2E_SETUP";
  let route = await findDemoApprovalRoute(pool, routeConfig.routeName);

  if (!route) {
    const routeId = await approvalRouteRepository.createApprovalRoute(pool, {
      route_name: routeConfig.routeName,
      description: routeConfig.description,
      applies_to: routeConfig.appliesTo,
      status: "Active",
      created_by: actor
    });
    route = await approvalRouteRepository.getApprovalRoute(pool, routeId);
  } else {
    await approvalRouteRepository.updateApprovalRoute(pool, route.route_id, {
      description: routeConfig.description,
      applies_to: routeConfig.appliesTo,
      status: "Active",
      updated_by: actor
    });
  }

  const steps = routeConfig.steps.map((step, index) => {
    const approver = usersByKey.get(step.approverKey);
    if (!approver) {
      throw new Error(`Unknown approver key: ${step.approverKey}`);
    }

    return {
      step_no: index + 1,
      sequence_no: step.sequenceNo,
      approver_employee_code: approver.employeeCode,
      approval_type: "Approval Required",
      comments_required: false,
      allow_reject: true,
      allow_return: true,
      stop_if_rejected: true
    };
  });

  await approvalRouteRepository.replaceApprovalRouteSteps(pool, route.route_id, steps);

  const policies = (await approvalRouteRepository.getApprovalRoutePolicies(pool))
    .filter((policy) => Number(policy.route_id) === Number(route.route_id));

  for (const policy of policies) {
    const currentDepartment = String(policy.department || "").toLowerCase();
    const targetDepartment = String(routeConfig.department || "").toLowerCase();

    if (currentDepartment !== targetDepartment) {
      await pool.query(
        `UPDATE approval_route_policy
         SET department = $2,
             updated_by = $3,
             updated_on = NOW()
         WHERE policy_id = $1`,
        [policy.policy_id, routeConfig.department, actor]
      );
    }
  }

  const refreshedPolicies = (await approvalRouteRepository.getApprovalRoutePolicies(pool))
    .filter((policy) => Number(policy.route_id) === Number(route.route_id));

  const hasPolicy = refreshedPolicies.some(
    (policy) =>
      String(policy.department || "").toLowerCase()
      === String(routeConfig.department || "").toLowerCase()
  );

  if (!hasPolicy) {
    try {
      await approvalRouteRepository.createApprovalRoutePolicy(pool, {
        route_id: route.route_id,
        department: routeConfig.department,
        designations: null,
        grades: null,
        min_amount: null,
        max_amount: null,
        is_active: true,
        created_by: actor
      });
    } catch (error) {
      if (error.status === 400 && String(error.message || "").includes("Policy criteria overlap")) {
        return {
          routeId: route.route_id,
          routeName: routeConfig.routeName,
          appliesTo: routeConfig.appliesTo,
          steps: steps.length,
          policySkipped: true,
          policySkipReason: error.message
        };
      }
      throw error;
    }
  }

  return {
    routeId: route.route_id,
    routeName: routeConfig.routeName,
    appliesTo: routeConfig.appliesTo,
    steps: steps.length
  };
}

async function ensureDemoInterviewerPanel(pool, manifest, usersByKey) {
  const panelConfig = manifest.interviewPanel;
  const interviewer = usersByKey.get(panelConfig.interviewerKey);

  if (!interviewer) {
    throw new Error(`Unknown interviewer key: ${panelConfig.interviewerKey}`);
  }

  const userRow = await pool.query(
    `SELECT user_id FROM user_mstr WHERE employee_code = $1 LIMIT 1`,
    [interviewer.employeeCode]
  );

  const userId = userRow.rows[0]?.user_id;

  if (!userId) {
    throw new Error(`Demo interviewer user not found: ${interviewer.employeeCode}`);
  }

  const existing = await pool.query(
    `SELECT panel_id
     FROM interview_panel_mstr
     WHERE employee_code = $1
        OR user_id = $2
     LIMIT 1`,
    [interviewer.employeeCode, userId]
  );

  if (existing.rows[0]) {
    await pool.query(
      `UPDATE interview_panel_mstr
       SET interviewer_name = $2,
           email_id = $3,
           interviewer_type = $4,
           is_active = TRUE
       WHERE panel_id = $1`,
      [
        existing.rows[0].panel_id,
        interviewer.fullName,
        interviewer.email,
        panelConfig.interviewerType
      ]
    );
    return { created: false, panelId: existing.rows[0].panel_id };
  }

  const inserted = await pool.query(
    `INSERT INTO interview_panel_mstr (
       user_id, employee_code, interviewer_name, email_id,
       interviewer_type, primary_skill, department, designation, is_active
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
     RETURNING panel_id`,
    [
      userId,
      interviewer.employeeCode,
      interviewer.fullName,
      interviewer.email,
      panelConfig.interviewerType,
      manifest.scenario.primarySkill,
      manifest.scenario.department,
      manifest.scenario.positionTitle
    ]
  );

  return { created: true, panelId: inserted.rows[0].panel_id };
}

async function suspendSystemOfferRoutePoliciesForDemo(pool, manifest) {
  const systemRouteId = manifest.offerApproval?.systemRouteId || "2";

  const allOfferPolicies = await pool.query(
    `UPDATE approval_route_policy p
     SET is_active = FALSE,
         updated_by = 'DEMO_E2E_SETUP',
         updated_on = NOW()
     FROM approval_route_mstr r
     WHERE r.route_id = p.route_id
       AND LOWER(TRIM(r.applies_to)) = 'offer'
       AND p.is_active = TRUE
     RETURNING p.policy_id, r.route_id, r.route_name`
  );

  const systemRoutePolicies = allOfferPolicies.rows.filter(
    (row) => String(row.route_id) === String(systemRouteId)
  );

  return {
    routeId: systemRouteId,
    suspendedPolicyCount: allOfferPolicies.rowCount,
    suspendedOfferRoutePolicyCount: allOfferPolicies.rowCount,
    suspendedSystemRoutePolicyCount: systemRoutePolicies.length
  };
}

async function ensureDemoOfferApprovalRoutePolicy(pool, manifest, byKey) {
  const offerRouteConfig = manifest.approvalRoutes.find((route) => route.key === "offer");
  if (!offerRouteConfig) {
    throw new Error("Manifest is missing approvalRoutes entry for offer.");
  }

  const route = await findDemoApprovalRoute(pool, offerRouteConfig.routeName);
  if (!route) {
    throw new Error(`Demo offer route not found: ${offerRouteConfig.routeName}`);
  }

  const policies = (await approvalRouteRepository.getApprovalRoutePolicies(pool))
    .filter((policy) => Number(policy.route_id) === Number(route.route_id));

  const hasActiveDepartmentPolicy = policies.some(
    (policy) =>
      policy.is_active
      && String(policy.department || "").toLowerCase()
        === String(offerRouteConfig.department || "").toLowerCase()
  );

  if (hasActiveDepartmentPolicy) {
    return { created: false, routeId: route.route_id, reason: "already active" };
  }

  await approvalRouteRepository.createApprovalRoutePolicy(pool, {
    route_id: route.route_id,
    department: offerRouteConfig.department,
    designations: null,
    grades: null,
    min_amount: null,
    max_amount: null,
    is_active: true,
    created_by: "DEMO_E2E_SETUP"
  });

  return { created: true, routeId: route.route_id };
}

/**
 * Demo-only: reset existing demo offer approval workflow to pending state
 * with the isolated [DEMO_E2E] Offer Approval route assignees.
 * Used after route/approver migration so Steps 18–19 can validate without a full reset.
 */
async function reseedDemoOfferApprovalWorkflow(pool, manifest) {
  const workflowService = require("../services/workflowService");
  const scope = await collectDemoScope(pool, manifest);

  if (!scope.offerIds.length) {
    return { reseeded: false, reason: "no demo offers found", offers: [] };
  }

  const offerRouteName =
    manifest.offerApproval?.routeName || "[DEMO_E2E] Offer Approval";
  const demoRoute = await findDemoApprovalRoute(pool, offerRouteName);
  if (!demoRoute) {
    throw new Error(`Demo offer route not found: ${offerRouteName}`);
  }

  const recruiterEmail =
    manifest.users.accounts.find((account) => account.key === "recruiter")?.email
    || "DEMO_E2E_SETUP";
  const configuredApprovers = manifest.offerApproval?.approvers || [];
  const results = [];

  for (const offerId of scope.offerIds) {
    const offerRow = await pool.query(
      `SELECT offer_id, workflow_instance_id
       FROM om_offers
       WHERE offer_id = $1`,
      [offerId]
    );
    if (!offerRow.rows.length) {
      continue;
    }

    const instanceId = offerRow.rows[0].workflow_instance_id;
    if (!instanceId) {
      continue;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `DELETE FROM wf_assignments
         WHERE task_id IN (
           SELECT task_id
           FROM wf_tasks
           WHERE instance_id = $1
             AND LOWER(task_type) = 'approval'
         )`,
        [instanceId]
      );

      await client.query(
        `DELETE FROM wf_tasks
         WHERE instance_id = $1
           AND LOWER(task_type) = 'approval'`,
        [instanceId]
      );

      await client.query("DELETE FROM om_offer_approvals WHERE offer_id = $1", [offerId]);

      const steps = await approvalRouteRepository.getApprovalRouteSteps(
        client,
        demoRoute.route_id
      );

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        const sequence = step.sequence_no ?? step.step_no ?? index + 1;
        const stepTitle = `Approval Step ${sequence} — ${offerId}`;
        const approver = configuredApprovers.find(
          (item) => Number(item.sequenceNo) === Number(sequence)
        );

        await client.query(
          `INSERT INTO om_offer_approvals (
             offer_id, approval_step, approver_role, approver_name, approval_status,
             sequence_order, effective_from
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            offerId,
            stepTitle,
            step.approval_type || "Approval Required",
            approver?.email || null,
            index === 0 ? "Pending" : "Waiting",
            sequence,
            new Date()
          ]
        );
      }

      await client.query(
        `UPDATE om_offers
         SET offer_status = 'Pending Approval',
             modified_by = $2,
             modified_on = NOW()
         WHERE offer_id = $1`,
        [offerId, recruiterEmail]
      );

      const instanceRow = await client.query(
        `SELECT execution_context
         FROM wf_instances
         WHERE instance_id = $1`,
        [instanceId]
      );
      const rawContext = instanceRow.rows[0]?.execution_context;
      let context =
        rawContext && typeof rawContext === "object"
          ? rawContext
          : typeof rawContext === "string"
            ? (() => {
                try {
                  return JSON.parse(rawContext);
                } catch {
                  return {};
                }
              })()
            : {};
      const meta = context.meta && typeof context.meta === "object" ? context.meta : {};
      const nextContext = {
        ...context,
        meta: {
          ...meta,
          document_type: "OFFER",
          offer_id: offerId,
          approval_route_id: String(demoRoute.route_id),
          process_id: instanceId
        },
        approval_route_id: String(demoRoute.route_id),
        current_stage: "approval",
        stageKey: "approval"
      };

      await client.query(
        `UPDATE wf_instances
         SET status = 'Running',
             current_stage_key = 'approval',
             execution_context = $2,
             modified_on = NOW()
         WHERE instance_id = $1`,
        [instanceId, JSON.stringify(nextContext)]
      );

      await client.query("COMMIT");

      const tasks = await workflowService.createApprovalRouteWorkflowTasks(
        pool,
        instanceId,
        demoRoute.route_id,
        {
          stageKey: "approval",
          assignedBy: "DEMO_E2E_SETUP",
          requisitionCode: offerId
        }
      );

      results.push({
        offerId,
        instanceId,
        routeId: demoRoute.route_id,
        step1Assignee: tasks[0]?.assignee || configuredApprovers[0]?.employeeCode,
        step2Assignee: tasks[1]?.assignee || configuredApprovers[1]?.employeeCode,
        tasksCreated: tasks.length
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    reseeded: results.length > 0,
    routeName: offerRouteName,
    routeId: demoRoute.route_id,
    offers: results
  };
}

async function verifyDemoResumePdf(manifest) {
  const resumePath = path.join(__dirname, "assets", "demo-resume.pdf");
  const result = {
    path: resumePath,
    exists: false,
    validPdf: false,
    parseable: false,
    fields: {}
  };

  if (!fs.existsSync(resumePath)) {
    return result;
  }

  result.exists = true;
  const buffer = fs.readFileSync(resumePath);
  result.validPdf = buffer.slice(0, 4).toString() === "%PDF";

  if (!result.validPdf) {
    return result;
  }

  let text = "";
  try {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    text = (parsed.text || "").trim();
    result.parseable = text.length > 0;
  } catch (error) {
    result.parseError = error.message;
    return result;
  }

  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i;
  const mobileRegex = /(?:\+91[\s-]*)?[6-9][\d\s-]{8,12}\d/;

  result.fields = {
    fullName: /Aarav Sharma/i.test(text),
    email: emailRegex.test(text) && text.includes(manifest.candidate.email),
    mobile: mobileRegex.test(text),
    pan: /DEMOP1234A/i.test(text),
    skills: /Java/i.test(text) && /Spring Boot/i.test(text),
    experience: /Demo Technologies Pvt Ltd/i.test(text),
    education: /Demo Institute of Technology/i.test(text)
  };

  result.parserCompatible = Object.values(result.fields).every(Boolean);
  return result;
}

function futureInterviewDate(daysAhead = 7) {
  const date = new Date();
  date.setDate(date.getDate() + Number(daysAhead || 7));
  return date.toISOString().slice(0, 10);
}

function hasDemoMarker(value, manifest) {
  return String(value || "").includes(manifest.marker);
}

function isDemoEmployeeCode(employeeCode, manifest) {
  return String(employeeCode || "").startsWith(
    manifest.identification.userEmployeeCodePrefix
  );
}

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function collectDemoScope(pool, manifest) {
  const marker = manifest.marker;
  const candidateEmail = manifest.identification.candidateEmail;

  const demoRequisitions = await pool.query(
    `SELECT requisition_code, workflow_instance_id, approved_position_id
     FROM rm_requisitions
     WHERE position_title LIKE $1
        OR created_by LIKE $2`,
    [`%${marker}%`, `%DEMO_E2E%`]
  );

  const demoPositions = await pool.query(
    `SELECT position_id, source_request_id
     FROM wp_approved_positions
     WHERE position_title LIKE $1`,
    [`%${marker}%`]
  );

  const demoBudgets = await pool.query(
    `SELECT request_id, workflow_instance_id
     FROM wp_budget_requests
     WHERE position_title LIKE $1
        OR created_by LIKE $2
        OR submitted_by LIKE $2`,
    [`%${marker}%`, `%DEMO_E2E%`]
  );

  const demoCandidates = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE email_id = $1`,
    [candidateEmail]
  );

  const requisitionCodes = demoRequisitions.rows.map((row) => row.requisition_code);
  const positionIds = demoPositions.rows.map((row) => row.position_id);
  const budgetRequestIds = demoBudgets.rows.map((row) => row.request_id);
  const candidateIds = demoCandidates.rows.map((row) => row.candidate_id);

  let mappingIds = [];
  let mapIds = [];

  if (requisitionCodes.length > 0) {
    const mappings = await pool.query(
      `SELECT mapping_id, map_id, candidate_id, workflow_instance_id
       FROM rm_candidate_mappings
       WHERE requisition_code = ANY($1::text[])`,
      [requisitionCodes]
    );
    mappingIds = mappings.rows.map((row) => row.mapping_id);
    mapIds = mappings.rows.map((row) => row.map_id).filter(Boolean);
    for (const row of mappings.rows) {
      if (row.candidate_id) candidateIds.push(row.candidate_id);
    }
  }

  if (candidateIds.length > 0) {
    const legacyMaps = await pool.query(
      `SELECT map_id
       FROM candidate_req_map
       WHERE candidate_id = ANY($1::int[])`,
      [[...new Set(candidateIds)]]
    );
    mapIds.push(...legacyMaps.rows.map((row) => row.map_id).filter(Boolean));
  }

  const uniqueCandidateIds = [...new Set(candidateIds.filter(Boolean))];
  const uniqueMapIds = [...new Set(mapIds.filter(Boolean))];

  let offerIds = [];
  let interviewIds = [];
  let offerRows = [];
  if (requisitionCodes.length > 0 || uniqueCandidateIds.length > 0) {
    const offers = await pool.query(
      `SELECT offer_id, workflow_instance_id
       FROM om_offers
       WHERE ($1::text[] <> '{}' AND requisition_code = ANY($1::text[]))
          OR ($2::int[] <> '{}' AND candidate_id = ANY($2::int[]))
          OR position_title LIKE $3`,
      [requisitionCodes, uniqueCandidateIds, `%${marker}%`]
    );
    offerRows = offers.rows;
    offerIds = offerRows.map((row) => row.offer_id);
  }

  let interviewRows = [];
  if (uniqueMapIds.length > 0 || requisitionCodes.length > 0 || uniqueCandidateIds.length > 0) {
    const interviews = await pool.query(
      `SELECT interview_id, schedule_id, workflow_instance_id
       FROM im_interviews
       WHERE ($1::int[] <> '{}' AND map_id = ANY($1::int[]))
          OR ($2::text[] <> '{}' AND requisition_code = ANY($2::text[]))
          OR ($3::int[] <> '{}' AND candidate_id = ANY($3::int[]))`,
      [uniqueMapIds, requisitionCodes, uniqueCandidateIds]
    );
    interviewRows = interviews.rows;
    interviewIds = interviewRows.map((row) => row.interview_id);
  }

  const workflowInstanceIds = [
    ...demoRequisitions.rows.map((row) => row.workflow_instance_id),
    ...demoBudgets.rows.map((row) => row.workflow_instance_id),
    ...offerRows.map((row) => row.workflow_instance_id),
    ...interviewRows.map((row) => row.workflow_instance_id)
  ].filter(Boolean);

  return {
    requisitionCodes,
    positionIds,
    budgetRequestIds,
    candidateIds: uniqueCandidateIds,
    mappingIds,
    mapIds: uniqueMapIds,
    interviewIds,
    offerIds,
    workflowInstanceIds: [...new Set(workflowInstanceIds)]
  };
}

function stripDemoFromWpPayload(payload, manifest, scope) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const marker = manifest.marker;
  const budgetIdSet = new Set(scope.budgetRequestIds || []);
  const positionIdSet = new Set(scope.positionIds || []);

  const isDemoBudgetItem = (item) => {
    const title = item?.position_title || item?.positionTitle || "";
    const id = item?.id || item?.request_id;
    return hasDemoMarker(title, manifest)
      || budgetIdSet.has(id)
      || isDemoEmployeeCode(item?.submitted_by, manifest)
      || isDemoEmployeeCode(item?.created_by, manifest);
  };

  const isDemoPositionItem = (item) => {
    const title = item?.position_title || item?.positionTitle || "";
    const id = item?.id || item?.position_id;
    return hasDemoMarker(title, manifest)
      || positionIdSet.has(id)
      || budgetIdSet.has(item?.source_request_id);
  };

  const next = { ...payload };
  next.budget_requests = (next.budget_requests || []).filter((item) => !isDemoBudgetItem(item));
  next.approved_positions = (next.approved_positions || []).filter(
    (item) => !isDemoPositionItem(item)
  );
  next.approval_queue = (next.approval_queue || []).filter((item) => {
    const title = item?.position_title || item?.positionTitle || "";
    return !hasDemoMarker(title, manifest) && !budgetIdSet.has(item?.id);
  });
  return next;
}

async function resetDemoTransactionalData(pool, manifest, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const scope = await collectDemoScope(pool, manifest);
  const actions = [];

  const record = (label, count) => {
    actions.push({ label, count });
  };

  if (dryRun) {
    record("demo requisitions", scope.requisitionCodes.length);
    record("demo approved positions", scope.positionIds.length);
    record("demo budget requests", scope.budgetRequestIds.length);
    record("demo candidates", scope.candidateIds.length);
    record("demo mappings", scope.mappingIds.length);
    record("demo interviews", scope.interviewIds.length);
    record("demo offers", scope.offerIds.length);
    record("demo workflow instances", scope.workflowInstanceIds.length);
    return { dryRun: true, scope, actions };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (scope.offerIds.length > 0) {
      const letters = await client.query(
        `SELECT letter_id FROM om_offer_letters WHERE offer_id = ANY($1::text[])`,
        [scope.offerIds]
      );
      const letterIds = letters.rows.map((row) => row.letter_id);
      if (letterIds.length > 0) {
        await client.query(
          `DELETE FROM om_offer_letter_ctc WHERE letter_id = ANY($1::text[])`,
          [letterIds]
        );
        record("om_offer_letter_ctc", letterIds.length);
      }
      const deletedLetters = await client.query(
        `DELETE FROM om_offer_letters WHERE offer_id = ANY($1::text[])`,
        [scope.offerIds]
      );
      record("om_offer_letters", deletedLetters.rowCount);

      const deletedOffers = await client.query(
        `DELETE FROM om_offers WHERE offer_id = ANY($1::text[])`,
        [scope.offerIds]
      );
      record("om_offers", deletedOffers.rowCount);
    }

    if (scope.interviewIds.length > 0) {
      if (await tableExists(client, "im_feedback")) {
        const deletedFeedback = await client.query(
          `DELETE FROM im_feedback WHERE interview_id = ANY($1::text[])`,
          [scope.interviewIds]
        );
        record("im_feedback", deletedFeedback.rowCount);
      }

      if (await tableExists(client, "im_interview_history")) {
        const deletedHistory = await client.query(
          `DELETE FROM im_interview_history WHERE interview_id = ANY($1::text[])`,
          [scope.interviewIds]
        );
        record("im_interview_history", deletedHistory.rowCount);
      }

      const deletedInterviews = await client.query(
        `DELETE FROM im_interviews WHERE interview_id = ANY($1::text[])`,
        [scope.interviewIds]
      );
      record("im_interviews", deletedInterviews.rowCount);
    }

    if (scope.mappingIds.length > 0) {
      const deletedPipelineHistory = await client.query(
        `DELETE FROM rm_pipeline_history WHERE mapping_id = ANY($1::int[])`,
        [scope.mappingIds]
      );
      record("rm_pipeline_history", deletedPipelineHistory.rowCount);
    }

    if (scope.requisitionCodes.length > 0) {
      const deletedMappings = await client.query(
        `DELETE FROM rm_candidate_mappings WHERE requisition_code = ANY($1::text[])`,
        [scope.requisitionCodes]
      );
      record("rm_candidate_mappings", deletedMappings.rowCount);

      if (await tableExists(client, "candidate_req_map")) {
        const deletedLegacyMaps = await client.query(
          `DELETE FROM candidate_req_map
           WHERE requisition_code = ANY($1::text[])
              OR candidate_id = ANY($2::int[])`,
          [scope.requisitionCodes, scope.candidateIds.length ? scope.candidateIds : [-1]]
        );
        record("candidate_req_map", deletedLegacyMaps.rowCount);
      }

      const deletedSnapshots = await client.query(
        `DELETE FROM rm_requisition_snapshots WHERE requisition_code = ANY($1::text[])`,
        [scope.requisitionCodes]
      );
      record("rm_requisition_snapshots", deletedSnapshots.rowCount);

      const deletedReqs = await client.query(
        `DELETE FROM rm_requisitions WHERE requisition_code = ANY($1::text[])`,
        [scope.requisitionCodes]
      );
      record("rm_requisitions", deletedReqs.rowCount);
    }

    if (scope.positionIds.length > 0) {
      const deletedPositions = await client.query(
        `DELETE FROM wp_approved_positions WHERE position_id = ANY($1::text[])`,
        [scope.positionIds]
      );
      record("wp_approved_positions", deletedPositions.rowCount);
    }

    if (scope.budgetRequestIds.length > 0) {
      const deletedPositionRequests = await client.query(
        `DELETE FROM wp_position_requests WHERE budget_request_id = ANY($1::text[])`,
        [scope.budgetRequestIds]
      );
      record("wp_position_requests", deletedPositionRequests.rowCount);

      const deletedBudgets = await client.query(
        `DELETE FROM wp_budget_requests WHERE request_id = ANY($1::text[])`,
        [scope.budgetRequestIds]
      );
      record("wp_budget_requests", deletedBudgets.rowCount);
    }

    if (scope.workflowInstanceIds.length > 0) {
      const tasks = await client.query(
        `SELECT task_id FROM wf_tasks WHERE instance_id = ANY($1::text[])`,
        [scope.workflowInstanceIds]
      );
      const taskIds = tasks.rows.map((row) => row.task_id);

      if (taskIds.length > 0 && (await tableExists(client, "wf_assignments"))) {
        const deletedAssignments = await client.query(
          `DELETE FROM wf_assignments WHERE task_id = ANY($1::int[])`,
          [taskIds]
        );
        record("wf_assignments", deletedAssignments.rowCount);
      }

      const deletedTasks = await client.query(
        `DELETE FROM wf_tasks WHERE instance_id = ANY($1::text[])`,
        [scope.workflowInstanceIds]
      );
      record("wf_tasks", deletedTasks.rowCount);

      if (await tableExists(client, "wf_history")) {
        const deletedInstanceHistory = await client.query(
          `DELETE FROM wf_history WHERE instance_id = ANY($1::text[])`,
          [scope.workflowInstanceIds]
        );
        record("wf_history (instance)", deletedInstanceHistory.rowCount);
      }

      const deletedInstances = await client.query(
        `DELETE FROM wf_instances WHERE instance_id = ANY($1::text[])`,
        [scope.workflowInstanceIds]
      );
      record("wf_instances", deletedInstances.rowCount);
    }

    if (scope.candidateIds.length > 0) {
      if (
        scope.requisitionCodes.length === 0 &&
        (scope.candidateIds.length > 0 || scope.mapIds.length > 0)
      ) {
        if (
          scope.mapIds.length > 0 &&
          (await tableExists(client, "interview_schedule_trn"))
        ) {
          const schedules = await client.query(
            `SELECT schedule_id FROM interview_schedule_trn WHERE map_id = ANY($1::int[])`,
            [scope.mapIds]
          );
          const scheduleIds = schedules.rows.map((row) => row.schedule_id);
          if (scheduleIds.length > 0) {
            if (await tableExists(client, "interview_feedback_hdr")) {
              const deletedFeedbackHdr = await client.query(
                `DELETE FROM interview_feedback_hdr WHERE schedule_id = ANY($1::int[])`,
                [scheduleIds]
              );
              record("interview_feedback_hdr", deletedFeedbackHdr.rowCount);
            }
            const deletedSchedules = await client.query(
              `DELETE FROM interview_schedule_trn WHERE schedule_id = ANY($1::int[])`,
              [scheduleIds]
            );
            record("interview_schedule_trn", deletedSchedules.rowCount);
          }
        }

        if (await tableExists(client, "candidate_req_map")) {
          const deletedLegacyMaps = await client.query(
            `DELETE FROM candidate_req_map
             WHERE ($1::int[] <> '{}' AND candidate_id = ANY($1::int[]))
                OR ($2::int[] <> '{}' AND map_id = ANY($2::int[]))`,
            [
              scope.candidateIds.length ? scope.candidateIds : [-1],
              scope.mapIds.length ? scope.mapIds : [-1]
            ]
          );
          record("candidate_req_map", deletedLegacyMaps.rowCount);
        }
      }

      if (await tableExists(client, "candidate_portal_account")) {
        const deletedPortal = await client.query(
          `DELETE FROM candidate_portal_account WHERE candidate_id = ANY($1::int[])`,
          [scope.candidateIds]
        );
        record("candidate_portal_account", deletedPortal.rowCount);
      }

      const deletedIntake = await client.query(
        `DELETE FROM rm_candidate_intake
         WHERE created_draft_id = ANY($1::int[])
            OR source_reference LIKE ANY($2::text[])`,
        [scope.candidateIds, scope.candidateIds.map((id) => `%${id}%`)]
      );
      record("rm_candidate_intake (registered)", deletedIntake.rowCount);

      const deletedCandidates = await client.query(
        `DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])`,
        [scope.candidateIds]
      );
      record("cand_mstr", deletedCandidates.rowCount);
    }

    const deletedOrphanIntake = await client.query(
      `DELETE FROM rm_candidate_intake
       WHERE original_file_name ILIKE '%demo-resume%'
          OR source_reference ILIKE '%DEMO_E2E%'
          OR source_reference ILIKE $1`,
      [`%${manifest.identification.candidateEmail}%`]
    );
    record("rm_candidate_intake (orphan)", deletedOrphanIntake.rowCount);

    const wpState = await client.query(
      `SELECT draft_payload, published_payload FROM wp_config_state WHERE id = 1`
    );

    if (wpState.rows[0]) {
      const draft = stripDemoFromWpPayload(wpState.rows[0].draft_payload, manifest, scope);
      const published = stripDemoFromWpPayload(
        wpState.rows[0].published_payload,
        manifest,
        scope
      );

      await client.query(
        `UPDATE wp_config_state
         SET draft_payload = $1::jsonb,
             published_payload = $2::jsonb,
             modified_by = 'DEMO_E2E_RESET',
             modified_on = NOW()
         WHERE id = 1`,
        [JSON.stringify(draft), JSON.stringify(published)]
      );
      record("wp_config_state JSON cleanup", 1);
    }

    await client.query("COMMIT");
    return { dryRun: false, scope, actions };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function verifyDemoInfrastructure(pool, manifest) {
  const checks = [];
  const warnings = [];

  const pass = (label, detail = null) => {
    checks.push({ ok: true, label, detail });
  };
  const fail = (label, detail = null) => {
    checks.push({ ok: false, label, detail });
  };
  const warn = (label, detail = null) => {
    warnings.push({ label, detail });
  };

  for (const account of manifest.users.accounts) {
    const user = await pool.query(
      `SELECT user_id, employee_code, email_id, role_name, is_active
       FROM user_mstr
       WHERE employee_code = $1
       LIMIT 1`,
      [account.employeeCode]
    );

    if (!user.rows[0]) {
      fail(`demo user exists: ${account.employeeCode}`);
      continue;
    }

    pass(`demo user exists: ${account.employeeCode}`);

    if (!user.rows[0].is_active) {
      fail(`demo user active: ${account.employeeCode}`);
    } else {
      pass(`demo user active: ${account.employeeCode}`);
    }

    for (const assignmentCode of account.workAssignments || []) {
      const assignment = await pool.query(
        `SELECT ewa.employee_work_assignment_id
         FROM employee_work_assignment ewa
         INNER JOIN work_assignment_mstr wam
           ON wam.work_assignment_id = ewa.work_assignment_id
         WHERE ewa.employee_code = $1
           AND wam.assignment_code = $2
           AND ewa.is_active = TRUE
         LIMIT 1`,
        [account.employeeCode, assignmentCode]
      );

      if (!assignment.rows[0]) {
        fail(`work assignment ${assignmentCode} → ${account.employeeCode}`);
      } else {
        pass(`work assignment ${assignmentCode} → ${account.employeeCode}`);
      }
    }
  }

  for (const routeConfig of manifest.approvalRoutes) {
    const route = await findDemoApprovalRoute(pool, routeConfig.routeName);
    if (!route) {
      fail(`approval route exists: ${routeConfig.routeName}`);
      continue;
    }

    pass(`approval route exists: ${routeConfig.routeName}`);

    const steps = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM approval_route_step
       WHERE route_id = $1`,
      [route.route_id]
    );

    if (steps.rows[0]?.total !== routeConfig.steps.length) {
      fail(
        `approval route steps (${routeConfig.routeName})`,
        `expected ${routeConfig.steps.length}, found ${steps.rows[0]?.total}`
      );
    } else {
      pass(`approval route steps (${routeConfig.routeName})`);
    }

    const policies = (await approvalRouteRepository.getApprovalRoutePolicies(pool))
      .filter((policy) => Number(policy.route_id) === Number(route.route_id));

    if (!policies.some((policy) => policy.is_active)) {
      fail(`approval route policy active: ${routeConfig.routeName}`);
    } else {
      pass(`approval route policy active: ${routeConfig.routeName}`);
    }

    const departmentPolicy = policies.find(
      (policy) =>
        policy.is_active
        && String(policy.department || "").toLowerCase()
          === String(routeConfig.department || "").toLowerCase()
    );
    if (!departmentPolicy) {
      fail(`approval route policy department (${routeConfig.routeName})`, routeConfig.department);
    } else {
      pass(`approval route policy department (${routeConfig.routeName}): ${routeConfig.department}`);
    }
  }

  const interviewer = manifest.users.accounts.find((item) => item.key === "interviewer");
  const panel = await pool.query(
    `SELECT panel_id, is_active
     FROM interview_panel_mstr
     WHERE employee_code = $1
     LIMIT 1`,
    [interviewer.employeeCode]
  );

  if (!panel.rows[0]) {
    fail("demo interviewer panel membership");
  } else if (!panel.rows[0].is_active) {
    fail("demo interviewer panel active");
  } else {
    pass("demo interviewer panel membership");
  }

  const department = await pool.query(
    `SELECT id, code, name FROM md_departments WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
    [manifest.scenario.department]
  );
  if (!department.rows[0]) {
    fail("master data department", `${manifest.scenario.department} not found`);
  } else {
    pass(`master data department: ${manifest.scenario.department}`);
    if (
      manifest.scenario.departmentId
      && department.rows[0].id !== manifest.scenario.departmentId
    ) {
      fail(
        "master data department id",
        `expected ${manifest.scenario.departmentId}, found ${department.rows[0].id}`
      );
    } else if (manifest.scenario.departmentId) {
      pass(`master data department id: ${manifest.scenario.departmentId}`);
    }
  }

  if (manifest.candidate.sourceId) {
    const source = await pool.query(
      `SELECT id, name FROM md_candidate_sources WHERE id = $1 LIMIT 1`,
      [manifest.candidate.sourceId]
    );
    if (!source.rows[0]) {
      fail("candidate source master", manifest.candidate.sourceId);
    } else {
      pass(`candidate source master: ${source.rows[0].name}`);
    }
  }

  for (const round of manifest.interview.rounds) {
    const interviewType = await pool.query(
      `SELECT id, code, name
       FROM md_interview_types
       WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
       LIMIT 1`,
      [round.roundType]
    );
    if (!interviewType.rows[0]) {
      fail("interview type master", `${round.roundType} not found`);
    } else {
      pass(`interview type master: ${round.roundType}`);
      if (round.roundTypeId && interviewType.rows[0].id !== round.roundTypeId) {
        fail(
          `interview type id (${round.roundType})`,
          `expected ${round.roundTypeId}, found ${interviewType.rows[0].id}`
        );
      }
    }
  }

  const resumeCheck = await verifyDemoResumePdf(manifest);
  if (!resumeCheck.exists) {
    fail("demo resume PDF present");
  } else {
    pass("demo resume PDF present");
  }

  if (!resumeCheck.validPdf) {
    fail("demo resume PDF format");
  } else {
    pass("demo resume PDF format");
  }

  if (!resumeCheck.parseable) {
    fail("demo resume PDF text extraction", resumeCheck.parseError || "empty text");
  } else {
    pass("demo resume PDF text extraction");
  }

  if (!resumeCheck.parserCompatible) {
    fail("demo resume parser compatibility", JSON.stringify(resumeCheck.fields));
  } else {
    pass("demo resume parser compatibility");
  }

  pass("candidate intake parse endpoint", "POST /candidate-intake/:intakeId/parse");

  if (!process.env.LIBREOFFICE_PATH && process.platform !== "win32") {
    warn("offer letter generation", "LIBREOFFICE_PATH not set — offer letter segment optional in Phase 3");
  }

  const systemOfferRouteId = manifest.offerApproval?.systemRouteId || "2";
  const offerRouteName =
    manifest.offerApproval?.routeName || "[DEMO_E2E] Offer Approval";
  const demoOfferRoute = await findDemoApprovalRoute(pool, offerRouteName);

  if (!demoOfferRoute) {
    fail("demo offer approval route exists", offerRouteName);
  } else {
    pass(`demo offer approval route exists: ${offerRouteName}`);

    const offerSteps = await pool.query(
      `SELECT sequence_no, approver_employee_code
       FROM approval_route_step
       WHERE route_id = $1
       ORDER BY sequence_no`,
      [demoOfferRoute.route_id]
    );

    const configuredApprovers = manifest.offerApproval?.approvers || [];
    for (const approver of configuredApprovers) {
      const step = offerSteps.rows.find(
        (row) => row.approver_employee_code === approver.employeeCode
      );
      if (!step) {
        fail(
          "demo offer approval approver configured",
          `${approver.employeeCode} missing from route ${demoOfferRoute.route_id}`
        );
      } else {
        pass(
          `demo offer approval step ${step.sequence_no}: ${approver.employeeCode}`
        );
      }
    }

    const activeSystemPolicies = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM approval_route_policy
       WHERE route_id = $1
         AND is_active = TRUE`,
      [systemOfferRouteId]
    );

    if (Number(activeSystemPolicies.rows[0]?.total || 0) > 0) {
      fail(
        "system offer route policies suspended for demo",
        `route ${systemOfferRouteId} still has active policies`
      );
    } else {
      pass(`system offer route policies suspended: route ${systemOfferRouteId}`);
    }

    try {
      const approvalRouteResolverService = require("../services/approvalRouteResolverService");
      const resolvedRouteId = await approvalRouteResolverService.resolveApprovalRoute(
        pool,
        manifest.offerApproval?.resolverDocumentType || "OFFER",
        {
          department: manifest.scenario.department,
          designation: null,
          grade: manifest.scenario.grade,
          amount: manifest.scenario.offeredCtcInr
        }
      );

      if (Number(resolvedRouteId) !== Number(demoOfferRoute.route_id)) {
        fail(
          "offer approval route resolver",
          `expected demo route ${demoOfferRoute.route_id}, resolved ${resolvedRouteId}`
        );
      } else {
        pass(`offer approval route resolver unique: ${offerRouteName}`);
      }
    } catch (error) {
      fail("offer approval route resolver", error.message);
    }
  }

  const offerTemplates = await pool.query(
    `SELECT id, code, name FROM md_offer_templates WHERE status = 'Active' LIMIT 5`
  ).catch(() => ({ rows: [] }));

  if (!offerTemplates.rows.length) {
    warn("offer template master", "No active offer templates found — offer letter segment optional");
  } else {
    pass(`offer template master (${offerTemplates.rows.length} active)`);
  }

  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    checks,
    warnings,
    failedCount: failed.length
  };
}

module.exports = {
  MANIFEST_PATH,
  loadManifest,
  createPool,
  resolveDemoPassword,
  indexUsers,
  ensureDemoUser,
  ensureEmployeeWorkAssignment,
  ensureDemoApprovalRoute,
  ensureDemoInterviewerPanel,
  suspendSystemOfferRoutePoliciesForDemo,
  ensureDemoOfferApprovalRoutePolicy,
  reseedDemoOfferApprovalWorkflow,
  verifyDemoResumePdf,
  futureInterviewDate,
  hasDemoMarker,
  isDemoEmployeeCode,
  tableExists,
  collectDemoScope,
  stripDemoFromWpPayload,
  resetDemoTransactionalData,
  verifyDemoInfrastructure
};
