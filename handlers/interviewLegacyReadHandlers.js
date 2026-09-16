const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");

async function handleGetInterviewSchedules(pool, req, res) {
  try {
    const isAdmin = String(req.user?.role_name || "").trim() === "Admin";
    const recruiterCode = isAdmin
      ? null
      : String(req.user?.employee_code || "").trim() || null;
    const data = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(
      pool,
      { recruiterCode }
    );

    res.status(200).json({
      success: true,
      count: data.length,
      data
    });
  } catch (error) {
    console.error("API 46 Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
}

async function handleGetMyInterviews(pool, req, res) {
  try {
    const panelResult = await pool.query(
      `
      SELECT panel_id
      FROM interview_panel_mstr
      WHERE employee_code = $1
        AND is_active = true
      `,
      [req.user.employee_code]
    );

    if (panelResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Interviewer profile not found"
      });
    }

    const panelId = panelResult.rows[0].panel_id;
    const data = await legacyOperationalAdapter.listMyInterviewsForLegacyApi(
      pool,
      panelId
    );

    res.status(200).json({
      success: true,
      count: data.length,
      data
    });
  } catch (error) {
    console.error("API 47 Error:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
}

module.exports = {
  handleGetInterviewSchedules,
  handleGetMyInterviews
};
