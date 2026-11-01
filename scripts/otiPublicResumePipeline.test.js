"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildExternalMatchExplanation } = require("../services/oti/otiExternalExplainService");
const { isQualifyingExternalLead } = require("../services/oti/otiRecommendationQualification");
const { processDiscoveredResumeDocument } = require("../services/oti/otiPublicResumeDocumentService");

const MIN_PDF = Buffer.from(
  "%PDF-1.4\nJane Doe\nSenior Java Engineer\nSkills: Java Oracle Python MySQL\n"
);

describe("oti public resume pipeline", () => {
  it("scores match from extracted resume skills, not search snippets", () => {
    const explanation = buildExternalMatchExplanation({
      profile: {
        provider_key: "serper_web_search",
        resume_index_status: "indexed",
        resume_qualified: true,
        skills: ["Java", "Oracle", "Python"],
        profile_completeness: 0.8,
        headline: "Senior Java Engineer"
      },
      structuredQuery: { skill_tokens: ["java", "oracle", "Python", "Mysql"] },
      requisition: { job_title: "Project Manager" }
    });

    assert.equal(explanation.resume_qualified, true);
    assert.ok(explanation.match_score >= 0.5);
    assert.ok(explanation.matched_skill_tokens.length > 0);

    assert.equal(
      isQualifyingExternalLead({
        match_score: explanation.match_score,
        match_explanation: explanation,
        resume_index_status: "indexed"
      }),
      true
    );
  });

  it("retrieves, stores and indexes a public resume document end-to-end (mocked IO)", async () => {
    let storedKey = null;
    const state = {
      leadId: 1,
      indexSkills: ["Java", "Oracle", "Python"],
      extractedText: "Jane Doe\nSenior Java Engineer\nJava Oracle Python"
    };

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("FROM oti_external_lead_source") && text.includes("provider_key = $1")) {
          return { rows: [] };
        }
        if (text.includes("FROM oti_external_lead") && text.includes("dedup_fingerprint")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_lead")) {
          return { rows: [{ external_lead_id: state.leadId }] };
        }
        if (text.includes("INSERT INTO oti_external_lead_source")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_lead_snapshot")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_resume_document")) {
          return {
            rows: [
              {
                document_id: 99,
                storage_key: storedKey,
                detected_format: "pdf",
                byte_length: MIN_PDF.length
              }
            ]
          };
        }
        if (text.includes("FROM oti_external_resume_document") && text.includes("content_hash")) {
          return { rows: [] };
        }
        if (text.includes("SELECT lead_uuid FROM oti_external_lead")) {
          return { rows: [{ lead_uuid: "oti-ext-test" }] };
        }
        if (text.includes("FROM oti_external_resume_index")) {
          return {
            rows: [
              {
                extracted_skills: JSON.stringify(
                  state.indexSkills.map((name) => ({ name, code: name.toUpperCase() }))
                ),
                extraction_status: "indexed",
                extracted_text: state.extractedText
              }
            ]
          };
        }
        if (text.includes("UPDATE oti_external_lead")) {
          return { rows: [] };
        }

        return { rows: [] };
      }
    };

    const entry = await processDiscoveredResumeDocument(
      pool,
      42,
      {
        provider_key: "serper_web_search",
        source_record_id: "https://files.example.org/resume/jane-doe.pdf",
        profile_url: "https://files.example.org/resume/jane-doe.pdf",
        display_name: null,
        headline: null
      },
      {
        structuredQuery: { skill_tokens: ["java", "oracle", "Python"] },
        requisition: { job_title: "Project Manager" }
      },
      {
        downloadPublicResumeBuffer: async () => ({
          buffer: MIN_PDF,
          filename_hint: "jane-doe.pdf"
        }),
        uploadResumeBuffer: async (key) => {
          storedKey = key;
          return { bucket: "test", key };
        },
        indexExternalLeadDocument: async (poolArg, externalLeadId) => {
          await poolArg.query(
            `UPDATE oti_external_resume_index SET extraction_status = 'indexed', extracted_skills = $2, extracted_text = $3 WHERE external_lead_id = $1`,
            [externalLeadId, JSON.stringify(state.indexSkills.map((name) => ({ name }))), state.extractedText]
          );
          return { extraction_status: "indexed" };
        }
      }
    );

    assert.ok(entry);
    assert.equal(entry.skipped, undefined);
    assert.equal(entry.profile.resume_index_status, "indexed");
    assert.equal(entry.explanation.resume_qualified, true);
    assert.ok(storedKey);
    assert.ok(entry.explanation.match_score >= 0.5);
  });

  it("reuses indexed leads with skills hydrated from resume index before upsert", async () => {
    const existingLeadId = 48;
    const profileUrl = "https://files.example.org/resume/existing.pdf";
    let skillsWritten = null;
    const indexSkills = ["Java", "Python"];

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("WHERE s.provider_key = $1 AND s.source_record_id = $2")) {
          return { rows: [] };
        }
        if (text.includes("WHERE s.profile_url IS NOT NULL") && text.includes("LIMIT 250")) {
          return {
            rows: [
              {
                external_lead_id: existingLeadId,
                profile_url: profileUrl,
                lead_uuid: "oti-ext-reuse",
                resume_index_status: "indexed",
                latest_document_id: 99
              }
            ]
          };
        }
        if (text.includes("dedup_fingerprint = $1")) {
          return { rows: [] };
        }
        if (text.includes("SELECT resume_index_status, latest_document_id") && text.includes("FROM oti_external_lead")) {
          return { rows: [{ resume_index_status: "indexed", latest_document_id: 99 }] };
        }
        if (text.includes("FROM oti_external_resume_index")) {
          return {
            rows: [
              {
                extracted_skills: JSON.stringify(indexSkills.map((name) => ({ name }))),
                extraction_status: "indexed"
              }
            ]
          };
        }
        if (text.includes("UPDATE oti_external_lead") && text.includes("skills = COALESCE($7, skills)")) {
          skillsWritten = params[6] ? JSON.parse(params[6]) : null;
          return { rows: [] };
        }
        if (text.includes("INSERT INTO oti_external_lead_source") || text.includes("INSERT INTO oti_external_lead_snapshot")) {
          return { rows: [] };
        }
        if (text.includes("SELECT COUNT(*)::int AS total FROM oti_external_lead_source")) {
          return { rows: [{ total: 1 }] };
        }
        if (text.includes("SELECT lead_uuid, display_name, headline, skills, resume_index_status")) {
          return {
            rows: [
              {
                lead_uuid: "oti-ext-reuse",
                display_name: "Candidate",
                headline: null,
                skills: JSON.stringify(indexSkills),
                resume_index_status: "indexed"
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    const entry = await processDiscoveredResumeDocument(
      pool,
      40,
      {
        provider_key: "serper_web_search",
        source_record_id: profileUrl,
        profile_url: profileUrl,
        skills: [],
        display_name: "Serper title"
      },
      {
        structuredQuery: { skill_tokens: ["java"] },
        requisition: { job_title: "Engineer" }
      },
      {
        downloadPublicResumeBuffer: async () => {
          throw new Error("should not download on reuse");
        }
      }
    );

    assert.ok(entry);
    assert.equal(entry.skipped, undefined);
    assert.equal(entry.external_lead_id, existingLeadId);
    assert.deepEqual(skillsWritten, indexSkills);
    assert.ok(entry.explanation.match_score >= 0.5);
  });
});
