const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  assertSubmitReadiness
} = require("../services/talentDemandSubmitService");

describe("talentDemandSubmitService.assertSubmitReadiness", () => {
  const baseDraft = {
    approved_position_id: "AP-1",
    approval_route_id: 99,
    client_name: "Client",
    job_title: "Engineer",
    primary_skill: "Java",
    work_location: "Remote",
    employment_type: "Full Time",
    priority_level: "High",
    target_date: "2026-12-31",
    openings_count: 1,
    row_version: 1
  };

  it("accepts draft with resolved approval route and valid experience", () => {
    assertSubmitReadiness(
      { ...baseDraft, experience_min: 0, experience_max: 4 },
      1
    );
  });

  it("rejects missing approval route", () => {
    assert.throws(
      () =>
        assertSubmitReadiness(
          { ...baseDraft, approval_route_id: null },
          1
        ),
      (error) => {
        assert.match(error.message, /approval_route_id is required/);
        return true;
      }
    );
  });

  it("rejects negative experience on submit readiness", () => {
    assert.throws(
      () =>
        assertSubmitReadiness(
          { ...baseDraft, experience_min: -1, experience_max: 2 },
          1
        ),
      (error) => {
        assert.match(error.message, /experience_min cannot be negative/);
        return true;
      }
    );
  });

  it("rejects negative openings_count on submit readiness", () => {
    assert.throws(
      () =>
        assertSubmitReadiness(
          { ...baseDraft, openings_count: -3 },
          1
        ),
      (error) => {
        assert.match(error.message, /openings_count must be a whole number/i);
        return true;
      }
    );
  });
});
