const { isEnterpriseOperationalSor } = require("../config/operationalCutover");

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
  if (!isEnterpriseOperationalSor()) {
    const result = await pool.query(`SELECT * FROM req_mstr ORDER BY req_id DESC`);
    return result.rows;
  }

  const result = await pool.query(
    `SELECT * FROM rm_requisitions ORDER BY COALESCE(req_id, 0) DESC, created_on DESC`
  );

  return result.rows.map(mapRequisitionToLegacyRow);
}

async function getMyRequisitions(pool, recruiterCode, options = {}) {
  const openOnly = options.openOnly === true;

  if (!isEnterpriseOperationalSor()) {
    const result = await pool.query(
      `SELECT r.req_id, r.req_code, r.client_name, r.project_name, r.job_title,
              r.primary_skill, r.secondary_skill, r.openings_count, r.work_location,
              r.priority_level, r.req_status, r.target_date,
              rm.recruiter_code, rm.assigned_on
       FROM req_recruiter_map rm
       INNER JOIN req_mstr r ON rm.req_id = r.req_id
       WHERE rm.recruiter_code = $1 AND rm.is_active = true
       ${openOnly ? "AND r.req_status = 'Open'" : ""}
       ORDER BY ${openOnly ? "r.target_date ASC" : "rm.assigned_on DESC"}`,
      [recruiterCode]
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT r.req_id, r.requisition_code AS req_code,
            r.business_unit AS client_name, r.department AS project_name,
            r.position_title AS job_title, r.primary_skill, NULL AS secondary_skill,
            r.headcount AS openings_count, r.location AS work_location,
            'High' AS priority_level, r.req_status, NULL AS target_date,
            a.recruiter_code, a.assigned_on
     FROM rm_recruiter_assignments a
     INNER JOIN rm_requisitions r ON a.requisition_code = r.requisition_code
     WHERE a.recruiter_code = $1 AND a.is_active = true
     ${openOnly ? "AND r.req_status = 'Open'" : ""}
     ORDER BY ${openOnly ? "a.assigned_on ASC" : "a.assigned_on DESC"}`,
    [recruiterCode]
  );

  return result.rows;
}

async function getRecruiterDashboardMetrics(pool, recruiterCode) {
  if (!isEnterpriseOperationalSor()) {
    const requisitions = await pool.query(
      `SELECT COUNT(*) AS total FROM req_recruiter_map
       WHERE recruiter_code = $1 AND is_active = true`,
      [recruiterCode]
    );

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

  const requisitions = await pool.query(
    `SELECT COUNT(*) AS total FROM rm_recruiter_assignments
     WHERE recruiter_code = $1 AND is_active = true`,
    [recruiterCode]
  );

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

async function listInterviewSchedulesForLegacyApi(pool) {
  if (!isEnterpriseOperationalSor()) {
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
      ORDER BY ist.interview_date DESC, ist.interview_time DESC
      `
    );
    return result.rows;
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
    ORDER BY i.interview_date DESC, i.interview_time DESC
    `
  );

  return result.rows;
}

module.exports = {
  mapRequisitionToLegacyRow,
  listLegacyRequisitions,
  getMyRequisitions,
  getRecruiterDashboardMetrics,
  buildRecruiterDashboardResponse,
  listInterviewSchedules,
  listInterviewSchedulesForLegacyApi
};
