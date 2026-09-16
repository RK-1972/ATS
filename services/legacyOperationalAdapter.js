const { isEnterpriseOperationalSor } = require("../config/operationalCutover");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );

  return result.rows[0]?.exists === true;
}

function mapRequisitionToLegacyRow(row) {
  return {
    req_id: row.req_id,
    req_code: row.requisition_code,
    client_name: row.business_unit || row.department,
    project_name: row.department,
    job_title: row.position_title,
    job_description: null,
    primary_skill: row.primary_skill,
    secondary_skill: null,
    experience_min: null,
    experience_max: null,
    openings_count: row.headcount,
    work_location: row.location,
    employment_type: row.employment_type,
    priority_level: "High",
    req_status: row.req_status,
    recruiter_id: null,
    hiring_manager: row.hiring_manager,
    target_date: null,
    created_by: row.created_by,
    created_on: row.created_on,
    updated_on: row.modified_on
  };
}

async function listLegacyRequisitions(pool) {
  const hasEnterprise = await tableExists(pool, "rm_requisitions");
  const hasLegacy = await tableExists(pool, "req_mstr");

  if (!hasEnterprise) {
    if (!hasLegacy) {
      return [];
    }

    const result = await pool.query(`SELECT * FROM req_mstr ORDER BY req_id DESC`);
    return result.rows;
  }

  const enterprise = await pool.query(
    `SELECT * FROM rm_requisitions ORDER BY COALESCE(req_id, 0) DESC, created_on DESC`
  );
  const rows = enterprise.rows.map(mapRequisitionToLegacyRow);

  if (!hasLegacy) {
    return rows;
  }

  const legacyOnly = await pool.query(
    `SELECT l.*
     FROM req_mstr l
     WHERE NOT EXISTS (
       SELECT 1
       FROM rm_requisitions r
       WHERE r.req_id IS NOT NULL
         AND r.req_id = l.req_id
     )
     ORDER BY l.req_id DESC`
  );

  return [...rows, ...legacyOnly.rows].sort(
    (left, right) => Number(right.req_id || 0) - Number(left.req_id || 0)
  );
}

async function getMyRequisitions(pool, recruiterCode, options = {}) {
  const openOnly = options.openOnly === true;
  const hasEnterprise =
    (await tableExists(pool, "rm_requisitions")) &&
    (await tableExists(pool, "rm_recruiter_assignments"));
  const hasLegacy =
    (await tableExists(pool, "req_mstr")) &&
    (await tableExists(pool, "req_recruiter_map"));

  const openFilter = openOnly
    ? `AND r.req_status = '${REQUISITION_STATUS.OPEN}'`
    : "";
  const openOrder = openOnly ? "a.assigned_on ASC" : "a.assigned_on DESC";

  let rows = [];

  if (hasEnterprise) {
    const enterprise = await pool.query(
      `SELECT r.req_id, r.requisition_code AS req_code,
              r.business_unit AS client_name, r.department AS project_name,
              r.position_title AS job_title, r.primary_skill, NULL AS secondary_skill,
              r.headcount AS openings_count, r.location AS work_location,
              'High' AS priority_level, r.req_status, NULL AS target_date,
              a.recruiter_code, a.assigned_on
       FROM rm_recruiter_assignments a
       INNER JOIN rm_requisitions r ON a.requisition_code = r.requisition_code
       WHERE a.recruiter_code = $1 AND a.is_active = true
       ${openFilter}
       ORDER BY ${openOrder}`,
      [recruiterCode]
    );
    rows = enterprise.rows;
  }

  if (hasLegacy) {
    const legacyOpenFilter = openOnly
      ? `AND r.req_status = '${REQUISITION_STATUS.OPEN}'`
      : "";
    const legacyOpenOrder = openOnly ? "r.target_date ASC" : "rm.assigned_on DESC";
    const legacyOnly = await pool.query(
      `SELECT r.req_id, r.req_code, r.client_name, r.project_name, r.job_title,
              r.primary_skill, r.secondary_skill, r.openings_count, r.work_location,
              r.priority_level, r.req_status, r.target_date,
              rm.recruiter_code, rm.assigned_on
       FROM req_recruiter_map rm
       INNER JOIN req_mstr r ON rm.req_id = r.req_id
       WHERE rm.recruiter_code = $1 AND rm.is_active = true
       ${legacyOpenFilter}
       AND NOT EXISTS (
         SELECT 1
         FROM rm_recruiter_assignments a
         INNER JOIN rm_requisitions er ON er.requisition_code = a.requisition_code
         WHERE a.recruiter_code = $1
           AND a.is_active = true
           AND er.req_id IS NOT NULL
           AND er.req_id = r.req_id
       )
       ORDER BY ${legacyOpenOrder}`,
      [recruiterCode]
    );

    const seen = new Set(rows.map((row) => String(row.req_id)));
    for (const row of legacyOnly.rows) {
      const key = String(row.req_id);
      if (!seen.has(key)) {
        rows.push(row);
        seen.add(key);
      }
    }
  }

  if (!hasEnterprise && !hasLegacy) {
    return [];
  }

  return rows;
}

async function getRecruiterDashboardMetrics(pool, recruiterCode) {
  const hasEnterpriseAssignments = await tableExists(pool, "rm_recruiter_assignments");

  const requisitions = hasEnterpriseAssignments
    ? await pool.query(
        `SELECT COUNT(*) AS total FROM rm_recruiter_assignments
         WHERE recruiter_code = $1 AND is_active = true`,
        [recruiterCode]
      )
    : await pool.query(
        `SELECT COUNT(*) AS total FROM req_recruiter_map
         WHERE recruiter_code = $1 AND is_active = true`,
        [recruiterCode]
      );

  if (!isEnterpriseOperationalSor()) {

    const candidates = await pool.query(
      `SELECT COUNT(*) AS total FROM candidate_req_map
       WHERE recruiter_id = $1 AND is_active = true`,
      [recruiterCode]
    );

    const funnel = await pool.query(
      `SELECT stage_name, COUNT(*) AS total FROM candidate_req_map
       WHERE recruiter_id = $1 AND is_active = true
       GROUP BY stage_name`,
      [recruiterCode]
    );

    return {
      requisitionCount: Number(requisitions.rows[0].total),
      candidateCount: Number(candidates.rows[0].total),
      funnelRows: funnel.rows
    };
  }

  const candidates = await pool.query(
    `SELECT COUNT(*) AS total FROM rm_candidate_mappings
     WHERE recruiter_id = $1 AND is_active = true`,
    [recruiterCode]
  );

  const funnel = await pool.query(
    `SELECT stage_name, COUNT(*) AS total FROM rm_candidate_mappings
     WHERE recruiter_id = $1 AND is_active = true
     GROUP BY stage_name`,
    [recruiterCode]
  );

  return {
    requisitionCount: Number(requisitions.rows[0].total),
    candidateCount: Number(candidates.rows[0].total),
    funnelRows: funnel.rows
  };
}

function buildRecruiterDashboardResponse(metrics) {
  const dashboard = {
    my_requisitions: metrics.requisitionCount,
    my_candidates: metrics.candidateCount,
    applied: 0,
    screening: 0,
    l1_interview: 0,
    l2_interview: 0,
    client_interview: 0,
    offer: 0,
    joined: 0
  };

  metrics.funnelRows.forEach((row) => {
    switch (row.stage_name) {
      case "Applied":
        dashboard.applied = Number(row.total);
        break;
      case "Screening":
        dashboard.screening = Number(row.total);
        break;
      case "L1 Interview":
      case "L1 Technical":
      case "L1 Non-Technical":
        dashboard.l1_interview += Number(row.total);
        break;
      case "L2 Interview":
      case "L2 Technical":
      case "L2 Non-Technical":
        dashboard.l2_interview += Number(row.total);
        break;
      case "Client Interview":
      case "Client Round":
        dashboard.client_interview += Number(row.total);
        break;
      case "Offer":
        dashboard.offer = Number(row.total);
        break;
      case "Joined":
        dashboard.joined = Number(row.total);
        break;
      default:
        break;
    }
  });

  return dashboard;
}

async function listInterviewSchedules(pool) {
  if (!isEnterpriseOperationalSor()) {
    const result = await pool.query(`
      SELECT ist.*, crm.candidate_id, cm.first_name, cm.last_name
      FROM interview_schedule_trn ist
      INNER JOIN candidate_req_map crm ON ist.map_id = crm.map_id
      INNER JOIN cand_mstr cm ON crm.candidate_id = cm.candidate_id
      ORDER BY ist.interview_date DESC, ist.interview_time DESC`);
    return result.rows;
  }

  const result = await pool.query(`
    SELECT i.schedule_id, i.map_id, pa.panel_id AS interviewer_id, i.round_type,
           i.interview_date, i.interview_time, i.meeting_link, i.interview_status,
           i.remarks, i.created_by, i.created_on, i.modified_on AS updated_on,
           i.round_no, i.req_id, i.teams_event_id, i.feedback_submitted,
           i.candidate_id, cm.first_name, cm.last_name
    FROM im_interviews i
    LEFT JOIN im_panel_assignments pa ON pa.interview_id = i.interview_id
    LEFT JOIN cand_mstr cm ON cm.candidate_id = i.candidate_id
    ORDER BY i.interview_date DESC, i.interview_time DESC`);

  return result.rows;
}

const LEGACY_SCHEDULE_NOT_IN_ENTERPRISE = `
  NOT EXISTS (
    SELECT 1
    FROM im_interviews e
    WHERE e.schedule_id = ist.schedule_id
  )
`;

function parseDdMmYyyy(value) {
  if (!value || typeof value !== "string") {
    return 0;
  }

  const [day, month, year] = value.split("-").map((part) => Number(part));
  if (!day || !month || !year) {
    return 0;
  }

  return new Date(year, month - 1, day).getTime();
}

function sortInterviewScheduleRows(rows) {
  return rows.sort((a, b) => {
    const dateA = parseDdMmYyyy(a.interview_date);
    const dateB = parseDdMmYyyy(b.interview_date);
    if (dateB !== dateA) {
      return dateB - dateA;
    }

    const timeA = String(a.interview_time || "");
    const timeB = String(b.interview_time || "");
    if (timeB !== timeA) {
      return timeB.localeCompare(timeA);
    }

    return Number(b.schedule_id || 0) - Number(a.schedule_id || 0);
  });
}

async function listLegacyInterviewSchedulesForLegacyApi(pool, recruiterCode) {
  const params = [];
  let recruiterFilter = "";

  if (recruiterCode) {
    params.push(recruiterCode);
    recruiterFilter = `
      INNER JOIN req_recruiter_map rrm
        ON rrm.req_id = ist.req_id
       AND rrm.recruiter_code = $1
       AND rrm.is_active = true`;
  }

  const result = await pool.query(
    `
    SELECT
      ist.schedule_id,
      ist.req_id,
      cm.candidate_code,
      CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
      rm.req_code,
      rm.job_title,
      ist.round_no,
      ist.round_type,
      ipm.interviewer_name,
      TO_CHAR(ist.interview_date, 'DD-MM-YYYY') AS interview_date,
      ist.interview_time,
      ist.interview_status,
      ist.feedback_submitted,
      ist.meeting_link,
      ist.remarks,
      ist.created_on
    FROM interview_schedule_trn ist
    INNER JOIN candidate_req_map crm ON crm.map_id = ist.map_id
    INNER JOIN cand_mstr cm ON cm.candidate_id = crm.candidate_id
    LEFT JOIN req_mstr rm ON rm.req_id = ist.req_id
    INNER JOIN interview_panel_mstr ipm ON ipm.panel_id = ist.interviewer_id
    ${recruiterFilter}
    ORDER BY ist.interview_date DESC, ist.interview_time DESC
    `,
    params
  );

  return result.rows;
}

async function listLegacyOnlyInterviewSchedulesForLegacyApi(pool, recruiterCode) {
  const params = [];
  let recruiterFilter = "";

  if (recruiterCode) {
    params.push(recruiterCode);
    recruiterFilter = `
      INNER JOIN req_recruiter_map rrm
        ON rrm.req_id = ist.req_id
       AND rrm.recruiter_code = $1
       AND rrm.is_active = true`;
  }

  const result = await pool.query(
    `
    SELECT
      ist.schedule_id,
      ist.req_id,
      cm.candidate_code,
      CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
      rm.req_code,
      rm.job_title,
      ist.round_no,
      ist.round_type,
      ipm.interviewer_name,
      TO_CHAR(ist.interview_date, 'DD-MM-YYYY') AS interview_date,
      ist.interview_time,
      ist.interview_status,
      ist.feedback_submitted,
      ist.meeting_link,
      ist.remarks,
      ist.created_on
    FROM interview_schedule_trn ist
    INNER JOIN candidate_req_map crm ON crm.map_id = ist.map_id
    INNER JOIN cand_mstr cm ON cm.candidate_id = crm.candidate_id
    LEFT JOIN req_mstr rm ON rm.req_id = ist.req_id
    INNER JOIN interview_panel_mstr ipm ON ipm.panel_id = ist.interviewer_id
    ${recruiterFilter}
    WHERE ${LEGACY_SCHEDULE_NOT_IN_ENTERPRISE}
    ORDER BY ist.interview_date DESC, ist.interview_time DESC
    `,
    params
  );

  return result.rows;
}

async function listEnterpriseInterviewSchedulesForLegacyApi(pool, recruiterCode) {
  const params = [];
  let recruiterFilter = "";

  if (recruiterCode) {
    params.push(recruiterCode);
    recruiterFilter = `
      INNER JOIN rm_recruiter_assignments a
        ON a.recruiter_code = $1
       AND a.is_active = true
       AND EXISTS (
         SELECT 1
         FROM rm_requisitions rq
         WHERE rq.requisition_code = a.requisition_code
           AND (
             rq.requisition_code = i.requisition_code
             OR rq.req_id = i.req_id
           )
       )`;
  }

  const result = await pool.query(
    `
    SELECT
      i.schedule_id,
      i.req_id,
      cm.candidate_code,
      CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name,
      COALESCE(r.requisition_code, r2.requisition_code) AS req_code,
      COALESCE(r.position_title, r2.position_title) AS job_title,
      i.round_no,
      i.round_type,
      ipm.interviewer_name,
      TO_CHAR(i.interview_date, 'DD-MM-YYYY') AS interview_date,
      i.interview_time,
      i.interview_status,
      i.feedback_submitted,
      i.meeting_link,
      i.remarks,
      i.created_on
    FROM im_interviews i
    INNER JOIN rm_candidate_mappings crm ON crm.map_id = i.map_id
    INNER JOIN cand_mstr cm ON cm.candidate_id = crm.candidate_id
    LEFT JOIN rm_requisitions r ON r.req_id = i.req_id
    LEFT JOIN rm_requisitions r2 ON r2.requisition_code = i.requisition_code
    LEFT JOIN interview_schedule_trn ist ON ist.schedule_id = i.schedule_id
    LEFT JOIN im_panel_assignments ipa ON ipa.interview_id = i.interview_id
    LEFT JOIN interview_panel_mstr ipm
      ON ipm.panel_id = COALESCE(ist.interviewer_id, ipa.panel_id)
    ${recruiterFilter}
    ORDER BY i.interview_date DESC, i.interview_time DESC
    `,
    params
  );

  return result.rows;
}

async function listInterviewSchedulesForLegacyApi(pool, options = {}) {
  const recruiterCode = options.recruiterCode
    ? String(options.recruiterCode).trim()
    : null;

  if (!isEnterpriseOperationalSor()) {
    return listLegacyInterviewSchedulesForLegacyApi(pool, recruiterCode);
  }

  const enterpriseRows = await listEnterpriseInterviewSchedulesForLegacyApi(
    pool,
    recruiterCode
  );

  const hasLegacyMap = await tableExists(pool, "candidate_req_map");
  if (!hasLegacyMap) {
    return enterpriseRows;
  }

  const enterpriseScheduleIds = new Set(
    enterpriseRows.map((row) => String(row.schedule_id))
  );
  const legacyOnlyRows = await listLegacyOnlyInterviewSchedulesForLegacyApi(
    pool,
    recruiterCode
  );
  const dedupedLegacyRows = legacyOnlyRows.filter(
    (row) => !enterpriseScheduleIds.has(String(row.schedule_id))
  );

  return sortInterviewScheduleRows([...enterpriseRows, ...dedupedLegacyRows]);
}

function sortMyInterviewRows(rows) {
  return rows.sort((a, b) => {
    const dateA = a.interview_date ? new Date(a.interview_date).getTime() : 0;
    const dateB = b.interview_date ? new Date(b.interview_date).getTime() : 0;
    if (dateB !== dateA) {
      return dateB - dateA;
    }

    const timeA = String(a.interview_time || "");
    const timeB = String(b.interview_time || "");
    if (timeB !== timeA) {
      return timeB.localeCompare(timeA);
    }

    return Number(b.schedule_id || 0) - Number(a.schedule_id || 0);
  });
}

async function listEnterpriseMyInterviews(pool, panelId) {
  const result = await pool.query(
    `
    SELECT
      s.schedule_id,
      COALESCE(i.round_type, s.round_type) AS round_type,
      s.interview_date,
      s.interview_time,
      COALESCE(i.interview_status, s.interview_status) AS interview_status,
      COALESCE(i.feedback_submitted, s.feedback_submitted, false) AS feedback_submitted,
      COALESCE(i.final_outcome, fh.final_outcome) AS final_outcome,
      COALESCE(i.meeting_link, s.meeting_link) AS meeting_link,
      COALESCE(rcm.map_id, crm.map_id) AS map_id,
      COALESCE(rcm.stage_name, crm.stage_name) AS stage_name,
      c.candidate_id,
      c.candidate_code,
      CONCAT(c.first_name, ' ', c.last_name) AS candidate_name,
      c.email_id,
      c.resume_path,
      COALESCE(rr_by_id.req_id, rr_by_code.req_id, r.req_id, s.req_id) AS req_id,
      COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code, r.req_code) AS req_code,
      COALESCE(r.client_name, rr_by_id.department, rr_by_code.department) AS client_name,
      COALESCE(rr_by_id.position_title, rr_by_code.position_title, r.job_title) AS job_title,
      COALESCE(rr_by_id.primary_skill, rr_by_code.primary_skill, r.primary_skill, c.primary_skill) AS primary_skill,
      COALESCE(r.secondary_skill, c.secondary_skill) AS secondary_skill,
      r.experience_min,
      r.experience_max,
      ip.interviewer_name
    FROM im_interviews i
    INNER JOIN interview_schedule_trn s
      ON s.schedule_id = i.schedule_id
    LEFT JOIN rm_candidate_mappings rcm
      ON rcm.map_id = COALESCE(i.map_id, s.map_id)
     AND rcm.is_active = true
    LEFT JOIN candidate_req_map crm
      ON crm.map_id = COALESCE(i.map_id, s.map_id)
    INNER JOIN cand_mstr c
      ON c.candidate_id = COALESCE(rcm.candidate_id, crm.candidate_id, i.candidate_id)
    LEFT JOIN rm_requisitions rr_by_id
      ON rr_by_id.req_id = COALESCE(i.req_id, rcm.req_id, s.req_id)
    LEFT JOIN rm_requisitions rr_by_code
      ON rr_by_code.requisition_code = COALESCE(i.requisition_code, rcm.requisition_code)
    LEFT JOIN req_mstr r
      ON r.req_id = COALESCE(crm.req_id, s.req_id)
    INNER JOIN interview_panel_mstr ip
      ON ip.panel_id = s.interviewer_id
    LEFT JOIN interview_feedback_hdr fh
      ON fh.schedule_id = s.schedule_id
    WHERE s.interviewer_id = $1
    ORDER BY s.interview_date DESC, s.interview_time DESC
    `,
    [panelId]
  );

  return result.rows;
}

async function listLegacyOnlyMyInterviews(pool, panelId) {
  const result = await pool.query(
    `
    SELECT
      s.schedule_id,
      s.round_type,
      s.interview_date,
      s.interview_time,
      s.interview_status,
      COALESCE(s.feedback_submitted, false) AS feedback_submitted,
      fh.final_outcome,
      s.meeting_link,
      COALESCE(rcm.map_id, crm.map_id) AS map_id,
      COALESCE(rcm.stage_name, crm.stage_name) AS stage_name,
      c.candidate_id,
      c.candidate_code,
      CONCAT(c.first_name, ' ', c.last_name) AS candidate_name,
      c.email_id,
      c.resume_path,
      COALESCE(rr_by_id.req_id, rr_by_code.req_id, r.req_id, s.req_id) AS req_id,
      COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code, r.req_code) AS req_code,
      COALESCE(r.client_name, rr_by_id.department, rr_by_code.department) AS client_name,
      COALESCE(rr_by_id.position_title, rr_by_code.position_title, r.job_title) AS job_title,
      COALESCE(rr_by_id.primary_skill, rr_by_code.primary_skill, r.primary_skill, c.primary_skill) AS primary_skill,
      COALESCE(r.secondary_skill, c.secondary_skill) AS secondary_skill,
      r.experience_min,
      r.experience_max,
      ip.interviewer_name
    FROM interview_schedule_trn s
    LEFT JOIN rm_candidate_mappings rcm
      ON rcm.map_id = s.map_id
     AND rcm.is_active = true
    LEFT JOIN candidate_req_map crm
      ON crm.map_id = s.map_id
    INNER JOIN cand_mstr c
      ON c.candidate_id = COALESCE(rcm.candidate_id, crm.candidate_id)
    LEFT JOIN rm_requisitions rr_by_id
      ON rr_by_id.req_id = COALESCE(rcm.req_id, s.req_id)
    LEFT JOIN rm_requisitions rr_by_code
      ON rr_by_code.requisition_code = rcm.requisition_code
    LEFT JOIN req_mstr r
      ON r.req_id = COALESCE(crm.req_id, s.req_id)
    INNER JOIN interview_panel_mstr ip
      ON ip.panel_id = s.interviewer_id
    LEFT JOIN interview_feedback_hdr fh
      ON fh.schedule_id = s.schedule_id
    WHERE s.interviewer_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM im_interviews e
        WHERE e.schedule_id = s.schedule_id
      )
    ORDER BY s.interview_date DESC, s.interview_time DESC
    `,
    [panelId]
  );

  return result.rows;
}

async function listCombinedMyInterviews(pool, panelId) {
  const result = await pool.query(
    `
    SELECT
      s.schedule_id,
      s.round_type,
      s.interview_date,
      s.interview_time,
      COALESCE(i.interview_status, s.interview_status) AS interview_status,
      COALESCE(i.feedback_submitted, s.feedback_submitted, false) AS feedback_submitted,
      COALESCE(i.final_outcome, fh.final_outcome) AS final_outcome,
      COALESCE(i.meeting_link, s.meeting_link) AS meeting_link,
      COALESCE(rcm.map_id, crm.map_id) AS map_id,
      COALESCE(rcm.stage_name, crm.stage_name) AS stage_name,
      c.candidate_id,
      c.candidate_code,
      CONCAT(c.first_name, ' ', c.last_name) AS candidate_name,
      c.email_id,
      c.resume_path,
      COALESCE(rr_by_id.req_id, rr_by_code.req_id, r.req_id, s.req_id) AS req_id,
      COALESCE(rr_by_id.requisition_code, rr_by_code.requisition_code, r.req_code) AS req_code,
      COALESCE(r.client_name, rr_by_id.department, rr_by_code.department) AS client_name,
      COALESCE(rr_by_id.position_title, rr_by_code.position_title, r.job_title) AS job_title,
      COALESCE(rr_by_id.primary_skill, rr_by_code.primary_skill, r.primary_skill, c.primary_skill) AS primary_skill,
      COALESCE(r.secondary_skill, c.secondary_skill) AS secondary_skill,
      r.experience_min,
      r.experience_max,
      ip.interviewer_name
    FROM interview_schedule_trn s
    LEFT JOIN im_interviews i
      ON i.schedule_id = s.schedule_id
    LEFT JOIN rm_candidate_mappings rcm
      ON rcm.map_id = s.map_id
     AND rcm.is_active = true
    LEFT JOIN candidate_req_map crm
      ON crm.map_id = s.map_id
    INNER JOIN cand_mstr c
      ON c.candidate_id = COALESCE(rcm.candidate_id, crm.candidate_id)
    LEFT JOIN rm_requisitions rr_by_id
      ON rr_by_id.req_id = COALESCE(i.req_id, rcm.req_id, s.req_id)
    LEFT JOIN rm_requisitions rr_by_code
      ON rr_by_code.requisition_code = COALESCE(i.requisition_code, rcm.requisition_code)
    LEFT JOIN req_mstr r
      ON r.req_id = COALESCE(crm.req_id, s.req_id)
    INNER JOIN interview_panel_mstr ip
      ON ip.panel_id = s.interviewer_id
    LEFT JOIN interview_feedback_hdr fh
      ON fh.schedule_id = s.schedule_id
    WHERE s.interviewer_id = $1
    ORDER BY s.interview_date DESC, s.interview_time DESC
    `,
    [panelId]
  );

  return result.rows;
}

async function listMyInterviewsForLegacyApi(pool, panelId) {
  const normalizedPanelId = Number(panelId);
  if (!normalizedPanelId) {
    return [];
  }

  if (!isEnterpriseOperationalSor()) {
    return listCombinedMyInterviews(pool, normalizedPanelId);
  }

  const enterpriseRows = await listEnterpriseMyInterviews(pool, normalizedPanelId);
  const enterpriseScheduleIds = new Set(
    enterpriseRows.map((row) => String(row.schedule_id))
  );

  const hasLegacySchedule = await tableExists(pool, "interview_schedule_trn");
  if (!hasLegacySchedule) {
    return sortMyInterviewRows(enterpriseRows);
  }

  const legacyOnlyRows = await listLegacyOnlyMyInterviews(pool, normalizedPanelId);
  const dedupedLegacyRows = legacyOnlyRows.filter(
    (row) => !enterpriseScheduleIds.has(String(row.schedule_id))
  );

  return sortMyInterviewRows([...enterpriseRows, ...dedupedLegacyRows]);
}

module.exports = {
  mapRequisitionToLegacyRow,
  listLegacyRequisitions,
  getMyRequisitions,
  getRecruiterDashboardMetrics,
  buildRecruiterDashboardResponse,
  listInterviewSchedules,
  listInterviewSchedulesForLegacyApi,
  listMyInterviewsForLegacyApi
};
