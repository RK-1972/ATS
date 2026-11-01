"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGitHubUserSearchQuery,
  buildGitHubResumeCodeSearchQueries,
  buildRawGitHubContentUrl,
  isPublicResumeDocumentPath,
  mapGitHubResumeCodeHit
} = require("../services/oti/connectors/githubResumeDiscovery");
const { classifyUrl, SOURCE_SURFACE } = require("../services/oti/otiExternalProfileCandidateGate");

describe("oti GitHub resume discovery", () => {
  const requisition = {
    job_title: "Senior Backend Engineer",
    position_title: "Senior Backend Engineer",
    location: "Bengaluru, Karnataka, India",
    work_location: "Bangalore"
  };

  const structuredQuery = {
    skill_tokens: ["Java", "Spring Boot", "PostgreSQL"]
  };

  it("builds India-relevant GitHub user search query from requisition context", () => {
    const query = buildGitHubUserSearchQuery({
      queryText: "Senior Backend Engineer",
      structuredQuery,
      requisition
    });

    assert.match(query, /Senior Backend Engineer/i);
    assert.match(query, /Java/i);
    assert.match(query, /location:"India"|location:India/i);
    assert.match(query, /in:bio,location type:user/);
  });

  it("builds per-user and skill-based code search queries for public resumes", () => {
    const queries = buildGitHubResumeCodeSearchQueries({
      structuredQuery,
      queryText: "Senior Backend Engineer",
      requisition,
      userLogins: ["dev-india"]
    });

    assert.ok(queries.some((row) => row.startsWith("user:dev-india")));
    assert.ok(queries.some((row) => /filename:resume extension:pdf/i.test(row)));
    for (const row of queries) {
      assert.doesNotMatch(row, /\(filename:/);
      assert.doesNotMatch(row, /\(extension:/);
    }
  });

  it("maps GitHub code hits to raw resume URLs and classifies as public resume documents", () => {
    const profile = mapGitHubResumeCodeHit({
      name: "resume.pdf",
      path: "docs/resume.pdf",
      sha: "abc123",
      html_url: "https://github.com/dev-india/portfolio/blob/main/docs/resume.pdf",
      repository: {
        full_name: "dev-india/portfolio",
        default_branch: "main",
        owner: { login: "dev-india" }
      }
    });

    assert.ok(profile);
    assert.equal(
      profile.profile_url,
      "https://raw.githubusercontent.com/dev-india/portfolio/main/docs/resume.pdf"
    );
    assert.equal(profile.source_attribution.provider, "GitHub");
    assert.equal(profile.source_attribution.api, "search/code");

    const urlClass = classifyUrl(profile.profile_url);
    assert.equal(urlClass.kind, SOURCE_SURFACE.PUBLIC_RESUME);
  });

  it("ignores non-resume repository files", () => {
    assert.equal(isPublicResumeDocumentPath("README.md", "README.md"), false);
    assert.equal(isPublicResumeDocumentPath("package.json", "package.json"), false);
    assert.equal(isPublicResumeDocumentPath("resume.pdf", "assets/resume.pdf"), true);
  });

  it("buildRawGitHubContentUrl falls back to repository default branch", () => {
    const url = buildRawGitHubContentUrl({
      htmlUrl: null,
      repository: { full_name: "user/repo", default_branch: "develop" },
      path: "cv/resume.pdf"
    });

    assert.equal(url, "https://raw.githubusercontent.com/user/repo/develop/cv/resume.pdf");
  });
});
