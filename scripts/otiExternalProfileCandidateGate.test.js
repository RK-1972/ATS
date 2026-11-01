"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  filterResumeDocumentCandidates,
  evaluateExternalSearchHit
} = require("../services/oti/otiExternalProfileCandidateGate");

const STRUCTURED = { skill_tokens: ["java", "oracle", "Python"] };

describe("oti external profile candidate gate", () => {
  it("rejects UAT training, certificate and job posting Serper hits", () => {
    const samples = [
      {
        provider_key: "serper_web_search",
        profile_url:
          "https://careertraining.berkshirecc.edu/training-programs/python-pl-sql-java-developer-program/",
        display_name: "Oracle SQL and PL/SQL + Python Developer + Java ...",
        headline: "Enroll today!"
      },
      {
        provider_key: "serper_web_search",
        profile_url:
          "https://careers.hcltech.com/job/Technical-Specialist-Python%2C-Oracle-PLSQL%2C-Java/163442-en_US/",
        display_name: "Technical Specialist - Python, Oracle PL/SQL, Java Job Details",
        headline: "The Technical Specialist will be responsible..."
      }
    ];

    const { resumeCandidates, rejected } = filterResumeDocumentCandidates(samples, {
      structuredQuery: STRUCTURED
    });
    assert.equal(resumeCandidates.length, 0);
    assert.equal(rejected.length, 2);
  });

  it("treats LinkedIn and GitHub as profile references, not resume candidates", () => {
    const { resumeCandidates, profileReferences } = filterResumeDocumentCandidates(
      [
        {
          provider_key: "serper_web_search",
          profile_url: "https://www.linkedin.com/in/jane-doe-123456/",
          display_name: "Jane Doe - Project Manager | LinkedIn",
          headline: "Java and Python experience"
        },
        {
          provider_key: "github",
          profile_url: "https://github.com/janedoe",
          display_name: "janedoe",
          headline: "Java developer"
        }
      ],
      { structuredQuery: STRUCTURED }
    );

    assert.equal(resumeCandidates.length, 0);
    assert.equal(profileReferences.length, 2);
  });

  it("accepts direct public resume document URLs only", () => {
    const verdict = evaluateExternalSearchHit(
      {
        provider_key: "serper_web_search",
        profile_url: "https://cdn.example.com/resumes/jane-doe-java-resume.pdf",
        display_name: "Jane Doe Java Resume PDF",
        headline: "Curriculum vitae"
      },
      { structuredQuery: STRUCTURED }
    );

    assert.equal(verdict.accept, true);
    assert.equal(verdict.profile.display_name, null);
    assert.equal(verdict.profile.resume_availability, "resume_available");
  });

  it("rejects Indian job board listing URLs as non-resume hits", () => {
    const verdict = evaluateExternalSearchHit(
      {
        provider_key: "serper_web_search",
        profile_url: "https://www.naukri.com/java-developer-resume-sample-123456",
        display_name: "Java Developer Resume - Naukri",
        headline: "Download resume"
      },
      { structuredQuery: STRUCTURED }
    );

    assert.equal(verdict.accept, false);
  });
});
