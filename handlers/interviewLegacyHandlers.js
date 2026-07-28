const interviewService = require("../services/interviewService");

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function handleScheduleInterview(pool, req, res, helpers = {}) {
  try {
    const body = req.body;
    let panelRow = {};

    if (await tableExists(pool, "interview_panel_mstr")) {
      const panelResult = await pool.query(
        `SELECT panel_id, interviewer_name, email_id, interviewer_type
         FROM interview_panel_mstr WHERE panel_id = $1 AND is_active = true`,
        [body.interviewer_id]
      );

      if (!panelResult.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Interviewer not found or inactive"
        });
      }

      panelRow = panelResult.rows[0];
    }

    const enterprise = await interviewService.scheduleInterview(pool, {
      ...body,
      interviewer_name: panelRow.interviewer_name,
      interviewer_email: panelRow.email_id,
      interviewer_type: panelRow.interviewer_type
    }, req);

    let teamsLink = null;
    let teamsEventId = null;

    if (helpers.createInterviewMeeting) {
      let candidateResult = await pool.query(
        `SELECT CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name, cm.email_id AS candidate_email
         FROM cand_mstr cm
         INNER JOIN rm_candidate_mappings rcm ON rcm.candidate_id = cm.candidate_id
         WHERE rcm.map_id = $1 AND rcm.is_active = true`,
        [body.map_id]
      ).catch(() => ({ rows: [] }));

      if (!candidateResult.rows.length) {
        candidateResult = await pool.query(
          `SELECT CONCAT(cm.first_name, ' ', cm.last_name) AS candidate_name, cm.email_id AS candidate_email
           FROM cand_mstr cm
           INNER JOIN candidate_req_map crm ON crm.candidate_id = cm.candidate_id
           WHERE crm.map_id = $1`,
          [body.map_id]
        ).catch(() => ({ rows: [] }));
      }

      const candidateName = candidateResult.rows[0]?.candidate_name;
      const candidateEmail = candidateResult.rows[0]?.candidate_email;

      try {
        const meeting = await helpers.createInterviewMeeting(
          body.interview_date,
          body.interview_time,
          body.round_type,
          candidateName,
          candidateEmail,
          panelRow.email_id,
          req.user.email_id
        );
        teamsLink = meeting?.joinUrl || meeting?.teamsLink || null;
        teamsEventId = meeting?.eventId || meeting?.teamsEventId || null;

        if (helpers.sendInterviewEmail && candidateEmail) {
          await helpers.sendInterviewEmail(
            candidateEmail,
            body.interview_date,
            body.interview_time,
            body.round_type,
            teamsLink
          );
        }
      } catch (teamsError) {
        console.warn("Teams meeting skipped:", teamsError.message);
      }
    }

    if (await tableExists(pool, "interview_schedule_trn")) {
      const scheduleResult = await pool.query(
        `INSERT INTO interview_schedule_trn (
          req_id, map_id, interviewer_id, round_no, round_type,
          interview_date, interview_time, meeting_link, teams_event_id, remarks, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          body.req_id,
          body.map_id,
          body.interviewer_id,
          body.round_no || 1,
          body.round_type,
          body.interview_date,
          body.interview_time,
          teamsLink,
          teamsEventId,
          body.remarks || null,
          req.user?.employee_code || null
        ]
      );

      await interviewService.linkLegacySchedule(
        pool,
        enterprise.interviewId,
        scheduleResult.rows[0].schedule_id,
        teamsLink,
        teamsEventId,
        req
      );

      return res.status(201).json({
        success: true,
        message: enterprise.toastMessage,
        data: {
          ...scheduleResult.rows[0],
          teams_link: teamsLink,
          interview_id: enterprise.interviewId
        }
      });
    }

    res.status(201).json({
      success: true,
      message: enterprise.toastMessage,
      data: enterprise.interview
    });
  } catch (error) {
    console.error("Schedule interview error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Internal Server Error"
    });
  }
}

async function handleSubmitFeedback(pool, req, res) {
  try {
    const result = await interviewService.submitFeedback(pool, req.body, req);

    res.status(200).json({
      success: true,
      message: result.toastMessage,
      data: result.interview
    });
  } catch (error) {
    console.error("Submit feedback error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error submitting feedback"
    });
  }
}

module.exports = {
  handleScheduleInterview,
  handleSubmitFeedback
};
