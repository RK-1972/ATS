const legacyOperationalAdapter = require("../services/legacyOperationalAdapter");

async function handleGetInterviewSchedules(pool, req, res) {
  try {
    const data = await legacyOperationalAdapter.listInterviewSchedulesForLegacyApi(pool);

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

module.exports = {
  handleGetInterviewSchedules
};
