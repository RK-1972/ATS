const interviewService = require("../services/interviewService");

async function handleScheduleInterview(pool, req, res, helpers = {}) {
  try {
    const result = await interviewService.scheduleInterviewCanonical(
      pool,
      req.body,
      req,
      helpers
    );

    if (result.legacyScheduleRow) {
      return res.status(201).json({
        success: true,
        message: result.toastMessage,
        data: {
          ...result.legacyScheduleRow,
          teams_link: result.teamsLink,
          interview_id: result.interviewId
        }
      });
    }

    res.status(201).json({
      success: true,
      message: result.toastMessage,
      data: result.interview
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

async function handleGetFeedback(pool, req, res) {
  try {
    const result = await interviewService.getFeedbackBySchedule(
      pool,
      req.params.scheduleId,
      req
    );

    res.status(200).json(result);
  } catch (error) {
    console.error("Get feedback error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Fetching Feedback"
    });
  }
}

module.exports = {
  handleScheduleInterview,
  handleSubmitFeedback,
  handleGetFeedback
};
