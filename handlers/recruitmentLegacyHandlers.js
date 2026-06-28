const recruitmentService = require("../services/recruitmentService");

async function handleLegacyCreateRequisition(pool, req, res) {
  try {
    const result = await recruitmentService.handleLegacyCreateRequisition(
      pool,
      req.body,
      req
    );

    res.status(201).json({
      success: true,
      message: "Requisition Created Successfully",
      data: result.legacyRequisition || result.requisition
    });
  } catch (error) {
    console.error("❌ Create Requisition Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Creating Requisition"
    });
  }
}

async function handleLegacyAssignRecruiter(pool, req, res) {
  try {
    const { req_id, recruiter_code } = req.body;
    const result = await recruitmentService.assignRecruiter(
      pool,
      req_id,
      recruiter_code,
      req
    );

    res.status(201).json({
      success: true,
      message: result.toastMessage,
      data: result.assignment
    });
  } catch (error) {
    console.error("❌ Assign Recruiter Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Assigning Recruiter"
    });
  }
}

async function handleLegacyMapCandidate(pool, req, res) {
  try {
    const result = await recruitmentService.mapCandidate(pool, req.body, req);

    res.status(201).json({
      success: true,
      message: result.toastMessage,
      data: result.legacyMapping || result.mapping
    });
  } catch (error) {
    console.error("❌ Candidate Req Mapping Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Mapping Candidate"
    });
  }
}

async function handleLegacyUpdateStage(pool, req, res) {
  try {
    const { stage_name, remarks } = req.body;
    const result = await recruitmentService.updateCandidateStage(
      pool,
      req.params.mapId,
      stage_name,
      remarks,
      req
    );

    res.status(200).json({
      success: true,
      message: result.toastMessage,
      data: result.mapping
    });
  } catch (error) {
    console.error("❌ ATS Stage Update Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Updating ATS Stage"
    });
  }
}

async function handleLegacyRemoveRecruiter(pool, req, res) {
  try {
    const result = await recruitmentService.removeRecruiterAssignment(
      pool,
      req.params.mapId,
      req
    );

    res.status(200).json({
      success: true,
      message: result.toastMessage,
      data: result.responseData
    });
  } catch (error) {
    console.error("❌ Remove Recruiter Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Removing Recruiter"
    });
  }
}

module.exports = {
  handleLegacyCreateRequisition,
  handleLegacyAssignRecruiter,
  handleLegacyMapCandidate,
  handleLegacyUpdateStage,
  handleLegacyRemoveRecruiter
};
