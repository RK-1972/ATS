const offerTemplateMergeService = require("../services/offerTemplateMergeService");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const mergeData = offerTemplateMergeService.buildMergeData({
  offerRow: {
    candidate_name: "Test Candidate",
    position_title: "Engineer",
    offered_ctc: 2500000,
    valid_until: "2026-12-01",
    expected_joining_date: "2026-09-15",
    variable_pay: 100000,
    variable_pay_frequency: "Yearly",
    joining_bonus: 50000,
    joining_bonus_frequency: "One Time"
  },
  organizationRow: { organization_name: "IGS Engineering Quality" }
});

assert(mergeData.Offer?.AnnualCTC === "25,00,000", "Existing merge fields must remain");
assert(mergeData.expectedJoiningDate === undefined, "expectedJoiningDate must not be in merge model");
assert(mergeData.variablePay === undefined, "variablePay must not be in merge model");
assert(mergeData.variablePayFrequency === undefined, "variablePayFrequency must not be in merge model");
assert(mergeData.joiningBonus === undefined, "joiningBonus must not be in merge model");
assert(mergeData.joiningBonusFrequency === undefined, "joiningBonusFrequency must not be in merge model");

console.log("Offer letter merge model excludes commercial fields — verification passed.");
