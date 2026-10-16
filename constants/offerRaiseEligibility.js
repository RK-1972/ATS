/**
 * Raise Offer Request — Final HR interview eligibility.
 *
 * Business term "Final HR Interview" is represented in Optalynx as the
 * interview_types master round `HR Round` (see interviewService.stageNameForRound
 * and md_records md-interview_types-it-hr). Outcome is stored on im_interviews.final_outcome.
 */
const FINAL_HR_INTERVIEW_ROUND_TYPE = "HR Round";
const FINAL_HR_INTERVIEW_OUTCOME_SELECTED = "Selected";

module.exports = {
  FINAL_HR_INTERVIEW_ROUND_TYPE,
  FINAL_HR_INTERVIEW_OUTCOME_SELECTED
};
