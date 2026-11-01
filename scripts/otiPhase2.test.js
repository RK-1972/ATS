"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeResumeText,
  hashResumeContent,
  classifyExtractionFailure
} = require("../services/oti/otiResumeTextUtils");
const otiHybridRankService = require("../services/oti/otiHybridRankService");
const otiResumeIndexService = require("../services/oti/otiResumeIndexService");
const otiResumeRetrievalService = require("../services/oti/otiResumeRetrievalService");
const otiMatchRankAgentService = require("../services/oti/otiMatchRankAgentService");
const candidateAccessService = require("../services/candidateAccessService");

describe("oti phase2 resume text utils", () => {
  it("normalizes whitespace and null bytes", () => {
    const raw = "Java  \r\n\r\n\r\nSpring\t\tBoot\u0000";
    assert.equal(normalizeResumeText(raw), "Java \n\nSpring Boot");
  });

  it("hashes buffers deterministically", () => {
    const left = hashResumeContent(Buffer.from("same"));
    const right = hashResumeContent(Buffer.from("same"));
    assert.equal(left, right);
    assert.notEqual(left, hashResumeContent(Buffer.from("other")));
  });

  it("classifies password-protected PDF failures", () => {
    const result = classifyExtractionFailure(new Error("Password required"), "");
    assert.equal(result.status, "unsupported");
  });
});

describe("oti phase2 hybrid ranking", () => {
  it("blends structured match with fts and resume skills using documented weights", async () => {
    mock.method(otiMatchRankAgentService, "rankInternalCandidates", async () => ({
      required_skills: [
        { code: "SK-JAVA", name: "Java" },
        { code: "SK-SPRING", name: "Spring" }
      ],
      ranked_results: [
        {
          candidate_id: 10,
          candidate_code: "C-10",
          candidate_name: "Hybrid User",
          match_pct: 50,
          rank_score: 0.5,
          rank_order: 1,
          matched_skills: [{ code: "SK-JAVA", name: "Java" }],
          missing_skills: [{ code: "SK-SPRING", name: "Spring" }],
          source_type: "talent_pool",
          explanation: { required_skills: [{ code: "SK-JAVA", name: "Java" }] },
          total_experience: 5
        }
      ]
    }));

    const ranked = await otiHybridRankService.rankInternalCandidatesHybrid(
      {},
      { primary_skill: "Java" },
      [{ candidate_id: 10, source_type: "talent_pool" }],
      [
        {
          candidate_id: 10,
          fts_rank: 0.4,
          index_metadata: {
            extracted_skills: [{ code: "SK-JAVA", name: "Java" }]
          }
        }
      ],
      { queryText: "Java Spring" }
    );

    assert.equal(ranked.ranked_results.length, 1);
    const row = ranked.ranked_results[0];
    assert.equal(row.explanation.scoring, "oti_phase2_hybrid");
    assert.deepEqual(row.explanation.weights, otiHybridRankService.WEIGHTS);
    assert.ok(row.rank_score > 0.25 && row.rank_score < 0.85);
    assert.equal(row.explanation.resume_extracted_skills.length, 1);

    mock.restoreAll();
  });

  it("merges structured and retrieval candidate lists without duplicating ids", () => {
    const merged = otiHybridRankService.mergeDiscoveredCandidates(
      [{ candidate_id: 1, source_type: "talent_pool", fts_rank: 0 }],
      [{ candidate_id: 1, source_type: "indexed_resume", fts_rank: 0.9 }]
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].fts_rank, 0.9);
    assert.match(String(merged[0].source_type), /talent_pool/);
  });
});

describe("oti phase2 resume skill extraction", () => {
  it("finds published skills in normalized resume text", () => {
    const skills = otiResumeIndexService.extractSkillsFromText("Experienced in Java and PostgreSQL.", [
      { code: "SK-JAVA", name: "Java", status: "Active" },
      { code: "SK-PG", name: "PostgreSQL", status: "Active" },
      { code: "SK-RUST", name: "Rust", status: "Active" }
    ]);

    assert.deepEqual(
      skills.map((row) => row.name).sort(),
      ["Java", "PostgreSQL"]
    );
  });
});

describe("oti phase2 retrieval authorization", () => {
  it("excludes candidates the requester cannot read", async () => {
    mock.method(candidateAccessService, "loadCandidateAccessRow", async (pool, id) => ({
      candidate_id: id
    }));
    mock.method(candidateAccessService, "canReadCandidateRow", () => false);
    mock.method(candidateAccessService, "canReviewDraftCandidateRow", async () => false);

    const pool = {
      query: async () => ({
        rows: [{ candidate_id: 55, fts_rank: 0.5, extracted_skills: [], experience_highlights: [], role_highlights: [] }]
      })
    };

    const result = await otiResumeRetrievalService.searchIndexedCandidates(
      pool,
      { user: { employee_code: "REC-1", role_name: "Recruiter" } },
      {
        requisitionCode: "REQ-1",
        queryText: "Java",
        requisition: { primary_skill: "Java", job_title: "Developer" }
      }
    );

    assert.equal(result.candidates.length, 0);
    assert.equal(result.excluded[0].reason, "access_denied");

    mock.restoreAll();
  });
});

describe("oti phase2 index idempotency", () => {
  it("skips re-index when content hash is unchanged and status is indexed", async () => {
    const hash = hashResumeContent(Buffer.from("pdf-bytes"));
    let upsertCalled = false;

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM cand_mstr")) {
          return {
            rows: [
              {
                candidate_id: 7,
                resume_path: "resumes/c7.pdf",
                primary_skill: "Java",
                secondary_skill: null,
                current_designation: "Engineer"
              }
            ]
          };
        }

        if (text.includes("content_hash, extraction_status FROM oti_resume_index")) {
          return { rows: [{ content_hash: hash, extraction_status: "indexed" }] };
        }

        if (text.includes("UPDATE oti_resume_index") && text.includes("processing")) {
          return { rows: [] };
        }

        if (text.includes("INSERT INTO oti_resume_index_event")) {
          return { rows: [] };
        }

        if (text.includes("SELECT candidate_id, extraction_status")) {
          return {
            rows: [
              {
                candidate_id: 7,
                extraction_status: "indexed",
                indexed_on: new Date(),
                failure_reason: null,
                content_hash: hash,
                version_num: 1,
                attempt_count: 1,
                text_length: 100,
                extracted_skills: []
              }
            ]
          };
        }

        if (text.includes("UPDATE oti_resume_index") && text.includes("search_vector")) {
          upsertCalled = true;
        }

        return { rows: [] };
      }
    };

    const status = await otiResumeIndexService.performIndexForCandidate(pool, 7, {
      downloadResumeBuffer: async () => Buffer.from("pdf-bytes"),
      extractResumeText: async () => ({ ok: true, text: "Java developer" })
    });

    assert.equal(status.extraction_status, "indexed");
    assert.equal(upsertCalled, false);
  });
});
