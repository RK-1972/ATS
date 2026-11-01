"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  isQualifyingInternalRecommendation,
  isQualifyingExternalLead,
  prepareQualifyingRecommendations,
  prepareQualifyingExternalLeads,
  OTI_MIN_RECOMMENDATION_MATCH_PCT
} = require("../services/oti/otiRecommendationQualification");

describe("oti recommendation qualification", () => {
  it("requires match_pct >= minimum and matched_skills evidence", () => {
    assert.equal(OTI_MIN_RECOMMENDATION_MATCH_PCT, 50);
    assert.equal(isQualifyingInternalRecommendation({ match_pct: 49, matched_skills: [{ code: "JAV" }] }), false);
    assert.equal(isQualifyingInternalRecommendation({ match_pct: 50, matched_skills: [{ code: "JAV" }] }), true);
    assert.equal(isQualifyingInternalRecommendation({ match_pct: 100, matched_skills: [] }), false);
    assert.equal(isQualifyingInternalRecommendation({ match_pct: null, matched_skills: [{ code: "JAV" }] }), false);
  });

  it("requires external match_score >= minimum and matched_skill_tokens evidence", () => {
    assert.equal(
      isQualifyingExternalLead({
        match_score: 0.49,
        match_explanation: { matched_skill_tokens: ["java"] }
      }),
      false
    );
    assert.equal(
      isQualifyingExternalLead({
        match_score: 0.5,
        match_explanation: { resume_qualified: true, matched_skill_tokens: ["java"] },
        resume_index_status: "indexed"
      }),
      true
    );
    assert.equal(
      isQualifyingExternalLead({
        match_score: 0.9,
        match_explanation: { matched_skill_tokens: [] }
      }),
      false
    );
  });

  it("sorts qualifying external leads by match_score desc", () => {
    const ordered = prepareQualifyingExternalLeads([
      {
        match_score: 0.55,
        match_explanation: { matched_skill_tokens: ["a"] },
        rank_order: 2
      },
      {
        match_score: 0.8,
        match_explanation: { matched_skill_tokens: ["b"] },
        rank_order: 1
      },
      {
        match_score: 0.2,
        match_explanation: { matched_skill_tokens: ["c"] },
        rank_order: 3
      }
    ]);

    assert.deepEqual(
      ordered.map((row) => [row.match_score, row.rank_order]),
      [
        [0.8, 1],
        [0.55, 2]
      ]
    );
  });

  it("sorts qualifying rows by match_pct desc then experience desc", () => {
    const ordered = prepareQualifyingRecommendations([
      { match_pct: 75, matched_skills: [{ code: "A" }], total_experience: 3, candidate_name: "B" },
      { match_pct: 100, matched_skills: [{ code: "B" }], total_experience: 1, candidate_name: "A" },
      { match_pct: 25, matched_skills: [{ code: "C" }], total_experience: 10, candidate_name: "C" },
      { match_pct: 75, matched_skills: [{ code: "D" }], total_experience: 8, candidate_name: "D" }
    ]);

    assert.deepEqual(
      ordered.map((row) => [row.match_pct, row.total_experience, row.rank_order]),
      [
        [100, 1, 1],
        [75, 8, 2],
        [75, 3, 3]
      ]
    );
  });
});
