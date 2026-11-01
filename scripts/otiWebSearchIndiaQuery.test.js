"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildWebSearchCandidateQuery,
  buildSerperIndiaResumeSearches,
  extractIndianCityLabels,
  resolveSerperGeo,
  isResumeFocusedQuery
} = require("../services/oti/connectors/otiWebSearchCandidateQuery");

describe("oti India-first web search queries", () => {
  const requisition = {
    job_title: "Java Developer",
    position_title: "Java Developer",
    location: "Bengaluru, Karnataka, India",
    experience_min: 4,
    experience_max: 8
  };

  const structuredQuery = { skill_tokens: ["java", "spring", "oracle"] };

  it("builds resume-focused query with India, cities, filetypes and negatives", () => {
    const q = buildWebSearchCandidateQuery({
      queryText: "Java Developer portfolio",
      structuredQuery,
      requisition
    });

    assert.match(q, /India/i);
    assert.match(q, /Bangalore/i);
    assert.match(q, /filetype:pdf OR filetype:doc OR filetype:docx/i);
    assert.match(q, /resume OR CV/i);
    assert.match(q, /4-8 years experience/i);
    assert.match(q, /-site:naukri\.com/i);
    assert.match(q, /-linkedin/i);
    assert.ok(isResumeFocusedQuery(q));
  });

  it("extracts multiple Indian cities from requisition location text", () => {
    const cities = extractIndianCityLabels({
      location: "Gurugram / Noida / Delhi NCR, India"
    });

    assert.ok(cities.includes("Gurugram"));
    assert.ok(cities.includes("Noida"));
    assert.ok(cities.includes("Delhi NCR"));
  });

  it("Serper search plan uses India geo and up to three distinct variants", () => {
    const plans = buildSerperIndiaResumeSearches({
      queryText: "Java Developer",
      structuredQuery,
      requisition,
      limit: 10
    });

    assert.ok(plans.length >= 1 && plans.length <= 3);
    for (const plan of plans) {
      assert.equal(plan.gl, "in");
      assert.equal(plan.hl, "en");
      assert.ok(isResumeFocusedQuery(plan.q));
    }
  });

  it("resolveSerperGeo defaults to India", () => {
    assert.deepEqual(resolveSerperGeo("India"), { gl: "in", hl: "en" });
  });
});
