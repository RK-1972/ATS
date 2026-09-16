const CLASSIC_CANDIDATE_ROUTE_MESSAGE =
  "This Classic Candidate route has been retired. Use the Enterprise Candidate Workspace APIs under /api/v1/recruitment/.";

function respondClassicCandidateRouteDeprecated(res) {
  return res.status(410).json({
    success: false,
    message: CLASSIC_CANDIDATE_ROUTE_MESSAGE,
    deprecated: true
  });
}

module.exports = {
  CLASSIC_CANDIDATE_ROUTE_MESSAGE,
  respondClassicCandidateRouteDeprecated
};
