const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");
const recruitmentService = require("../services/recruitmentService");

async function handleGetRequisitions(pool, req, res) {
  try {
    const data = await legacyOperationalAdapter.listLegacyRequisitions(pool);

    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error("❌ Fetch Requisitions Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Error Fetching Requisitions"
    });
  }
}

async function handleGetMyRequisitions(pool, req, res) {
  try {
    const recruiterCode = req.user.employee_code;
    const data = await legacyOperationalAdapter.getMyRequisitions(pool, recruiterCode);

    res.status(200).json({
      success: true,
      count: data.length,
      data
    });
  } catch (error) {
    console.error("❌ My Requisitions Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Error Fetching My Requisitions"
    });
  }
}

async function handleGetRecruiterDashboard(pool, req, res) {
  try {
    const recruiterCode = req.user.employee_code;
    const metrics = await legacyOperationalAdapter.getRecruiterDashboardMetrics(
      pool,
      recruiterCode
    );
    const data = legacyOperationalAdapter.buildRecruiterDashboardResponse(metrics);

    res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error("❌ Recruiter Dashboard Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Error Fetching Recruiter Dashboard"
    });
  }
}

async function handleGetMyOpenRequisitions(pool, req, res) {
  try {
    const recruiterCode = req.user.employee_code;
    const data = await legacyOperationalAdapter.getMyRequisitions(pool, recruiterCode, {
      openOnly: true
    });

    res.status(200).json({
      success: true,
      count: data.length,
      data
    });
  } catch (error) {
    console.error("❌ My Requisitions Error:", error.message);
    res.status(500).json({
      success: false,
      message: "Error Fetching My Requisitions"
    });
  }
}

async function handleGetAssignedRecruiters(pool, req, res) {
  try {
    const data = await recruitmentService.getAssignedRecruitersForRequisition(
      pool,
      req.params.reqId
    );

    res.status(200).json({
      success: true,
      count: data.length,
      data
    });
  } catch (error) {
    console.error("❌ Get Assigned Recruiters Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Fetching Assigned Recruiters"
    });
  }
}

module.exports = {
  handleGetRequisitions,
  handleGetMyRequisitions,
  handleGetMyOpenRequisitions,
  handleGetRecruiterDashboard,
  handleGetAssignedRecruiters
};
