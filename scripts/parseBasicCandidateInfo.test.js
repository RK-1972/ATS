"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseBasicCandidateInfo,
  splitCandidateFullName,
  sanitizeCandidateDisplayName
} = require("../utils/parseBasicCandidateInfo");

describe("parseBasicCandidateInfo name extraction", () => {
  it("extracts a multi-word legal name from the resume header", () => {
    const text = [
      "MOHAMED ADAM BIN AJMAL KHAN",
      "Senior Backend Engineer",
      "mohamed.adam@example.com",
      "+91 9876543210",
      "",
      "TECHNICAL EXPERTISE",
      "Java Spring Boot PostgreSQL"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "MOHAMED ADAM BIN AJMAL KHAN");
    assert.equal(parsed.first_name, "MOHAMED");
    assert.equal(parsed.last_name, "ADAM BIN AJMAL KHAN");
    assert.equal(parsed.email, "mohamed.adam@example.com");
  });

  it("does not treat section headings as candidate names", () => {
    const text = [
      "Curriculum Vitae",
      "",
      "TECHNICAL EXPERTISE",
      "Java Oracle Python",
      "",
      "PROFESSIONAL SUMMARY",
      "Backend engineer with 8 years experience"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, null);
    assert.equal(parsed.first_name, "");
    assert.equal(parsed.last_name, "");
  });

  it("prefers the first valid header name before later section headings", () => {
    const text = [
      "Jane Marie Doe",
      "jane.doe@example.com",
      "TECHNICAL SKILLS",
      "Python SQL"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "Jane Marie Doe");
    assert.equal(parsed.first_name, "Jane");
    assert.equal(parsed.last_name, "Marie Doe");
  });

  it("extracts VIVEK PANDHARKAR and ignores HEAD PARTICULARS table label (regression)", () => {
    const text = [
      "RESUME",
      "HEAD PARTICULARS",
      "VIVEK PANDHARKAR",
      "Email: vivek.p@example.com",
      "+91 9123456789",
      "Objective",
      "Seeking QA automation role"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "VIVEK PANDHARKAR");
    assert.equal(parsed.first_name, "VIVEK");
    assert.equal(parsed.last_name, "PANDHARKAR");
  });

  it("extracts Praveen and rejects summary line with Java and REST Assured (regression)", () => {
    const text = [
      "Praveen",
      "QA Engineer",
      "praveen.qa@example.com",
      "+91 9988776655",
      "Professional Summary",
      "with Java and API Rest Assured",
      "TECHNICAL SKILLS",
      "Selenium Java"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "Praveen");
    assert.equal(parsed.first_name, "Praveen");
    assert.equal(parsed.last_name, "");
  });

  it("uses Full Name label and splits without label tokens (Vivek UAT regression)", () => {
    const text = [
      "VIVEK PANDHARKAR",
      "Full Name: VIVEK RAVINDRA PANDHARKAR",
      "Email: vivek.p@example.com",
      "+91 9123456789",
      "SUMMARY",
      "Automation engineer"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "VIVEK RAVINDRA PANDHARKAR");
    assert.equal(parsed.first_name, "VIVEK");
    assert.equal(parsed.last_name, "RAVINDRA PANDHARKAR");
  });

  it("splits labelled full name when intake receives a single combined string", () => {
    const split = splitCandidateFullName("Full Name VIVEK RAVINDRA PANDHARKAR");

    assert.equal(split.first_name, "VIVEK");
    assert.equal(split.last_name, "RAVINDRA PANDHARKAR");
  });

  it("rejects false OTI identity strings from document headings and search titles", () => {
    assert.equal(sanitizeCandidateDisplayName("HEAD PARTICULARS"), null);
    assert.equal(sanitizeCandidateDisplayName("SUMMARY"), null);
    assert.equal(sanitizeCandidateDisplayName("RESUME - Recruit Agent"), null);
    assert.equal(sanitizeCandidateDisplayName("VIVEK RAVINDRA PANDHARKAR"), "VIVEK RAVINDRA PANDHARKAR");
  });

  it("parses Vivek resume header block without adopting section headings as identity", () => {
    const text = [
      "RESUME - Recruit Agent",
      "HEAD PARTICULARS",
      "SUMMARY",
      "VIVEK PANDHARKAR",
      "Full Name VIVEK RAVINDRA PANDHARKAR",
      "vivek.p@example.com"
    ].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "VIVEK RAVINDRA PANDHARKAR");
  });

  it("extracts Dr. K. VISALINI from standalone Name label with spaced PDF layout (regression)", () => {
    const text = ["Name    Dr. K. VISALINI", "visalini@example.com", "+91 9876543210"].join("\n");

    const parsed = parseBasicCandidateInfo(text);

    assert.equal(parsed.candidate_name, "Dr. K. VISALINI");
    assert.equal(parsed.first_name, "Dr.");
    assert.equal(parsed.last_name, "K. VISALINI");
    assert.notEqual(parsed.first_name, "Name");
    assert.doesNotMatch(parsed.last_name, /\bName\b/i);
  });

  it("extracts Dr. K. VISALINI when Name label is tab-separated", () => {
    const parsed = parseBasicCandidateInfo("Name\tDr. K. VISALINI\nemail@test.com");

    assert.equal(parsed.candidate_name, "Dr. K. VISALINI");
    assert.equal(splitCandidateFullName("Name: Dr. K. VISALINI").first_name, "Dr.");
    assert.equal(splitCandidateFullName("Name: Dr. K. VISALINI").last_name, "K. VISALINI");
  });
});
