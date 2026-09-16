const recruitmentService = require("../services/recruitmentService");
const { mapRequisitionToLegacyRow } = require("../services/legacyOperationalAdapter");

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

async function handleLegacyUpdateRequisition(pool, req, res) {
  try {
    const reqId = req.params.id;
    const lookup = await pool.query(
      `SELECT requisition_code
       FROM rm_requisitions
       WHERE req_id = $1
       LIMIT 1`,
      [reqId]
    );

    if (!lookup.rows[0]?.requisition_code) {
      return res.status(404).json({
        success: false,
        message: "Requisition not found"
      });
    }

    const result = await recruitmentService.updateRequisition(
      pool,
      lookup.rows[0].requisition_code,
      req.body,
      req
    );

    res.status(200).json({
      success: true,
      message: "Requisition Updated Successfully",
      data: mapRequisitionToLegacyRow(result.requisition)
    });
  } catch (error) {
    console.error("❌ Update Requisition Error:", error.message);
    res.status(error.status || 500).json({
      success: false,
      message: error.message || "Error Updating Requisition"
    });
  }
}

async function handleMapExistingCandidate(pool, req, res) {
  try {
    const result = await recruitmentService.mapCandidate(pool, req.body, req);

    let responseRow = result.legacyMapping || result.mapping;

    if (result.mapping?.map_id && !result.legacyMapping) {
      const bridge = await pool.query(
        `SELECT *
         FROM candidate_req_map
         WHERE map_id = $1
         LIMIT 1`,
        [result.mapping.map_id]
      );

      if (bridge.rows[0]) {
        responseRow = bridge.rows[0];
      }
    }

    res.status(201).json({
      success: true,
      message: "Candidate Mapped Successfully",
      data: responseRow
    });
  } catch (error) {
    console.error("❌ Map Existing Candidate Error:", error.message);
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
  handleLegacyUpdateRequisition,
  handleMapExistingCandidate,
  handleLegacyUpdateStage,
  handleLegacyRemoveRecruiter
};
