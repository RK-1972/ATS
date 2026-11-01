"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { validateResumeDocument } = require("../services/oti/otiResumeDocumentValidation");
const { evaluateExternalSearchHit } = require("../services/oti/otiExternalProfileCandidateGate");
const { loadRunSummary, getRunByPublicId } = require("../services/oti/otiOrchestratorService");

const STRUCTURED = { skill_tokens: ["java", "oracle"] };

describe("OTI confirmed defect regressions", () => {
  describe("loadRunSummary / GET run", () => {
    function buildRunPool(runRow) {
      return {
        query: async (sql, params) => {
          const text = String(sql);

          if (text.includes("FROM oti_sourcing_run WHERE run_id")) {
            return { rows: [runRow] };
          }
          if (text.includes("FROM oti_sourcing_result") && text.includes("COUNT")) {
            return { rows: [{ total: 2 }] };
          }
          if (text.includes("published_payload")) {
            return {
              rows: [
                {
                  published_payload: {
                    modules: [{ key: "ai", enabled: true }],
                    ai_features: [{ key: "talent_intelligence", enabled: true }]
                  }
                }
              ]
            };
          }

          return { rows: [] };
        }
      };
    }

    const adminReq = { user: { role_name: "Admin", employee_code: "ADM001" } };

    it("loadRunSummary uses runRow external_summary when extras omit external_leads_count", async () => {
      const runRow = {
        run_id: 46,
        run_uuid: "oti-run-historical-test",
        requisition_code: "REQ-TEST",
        status: "completed",
        query_text: "java",
        query_structured: {},
        initiated_by: "REC001",
        error_message: null,
        include_external: true,
        include_semantic: false,
        include_ai_assist: false,
        external_summary: { staged_count: 3 },
        semantic_summary: {},
        jd_intelligence_snapshot: {},
        search_strategy_snapshot: {},
        provider_selection_snapshot: {},
        ai_usage_summary: {},
        created_on: new Date().toISOString(),
        completed_on: new Date().toISOString()
      };

      const summary = await loadRunSummary(buildRunPool(runRow), runRow.run_id, adminReq, {});

      assert.equal(summary.run_id, runRow.run_uuid);
      assert.equal(summary.external_leads_count, 3);
      assert.equal(summary.results_count, 2);
    });

    it("getRunByPublicId resolves historical run without ReferenceError", async () => {
      const runRow = {
        run_id: 46,
        run_uuid: "oti-run-get-by-public-id",
        requisition_code: "REQ-TEST",
        status: "completed",
        query_text: "java",
        query_structured: {},
        initiated_by: "REC001",
        error_message: null,
        include_external: true,
        include_semantic: false,
        include_ai_assist: false,
        external_summary: { staged_count: 1 },
        semantic_summary: {},
        jd_intelligence_snapshot: {},
        search_strategy_snapshot: {},
        provider_selection_snapshot: {},
        ai_usage_summary: {},
        created_on: new Date().toISOString(),
        completed_on: new Date().toISOString()
      };

      const pool = {
        query: async (sql, params) => {
          const text = String(sql);

          if (text.includes("run_uuid = $1")) {
            return { rows: [runRow] };
          }
          if (text.includes("FROM oti_sourcing_run WHERE run_id")) {
            return { rows: [runRow] };
          }
          if (text.includes("FROM oti_sourcing_result") && text.includes("COUNT")) {
            return { rows: [{ total: 0 }] };
          }
          if (text.includes("published_payload")) {
            return {
              rows: [
                {
                  published_payload: {
                    modules: [{ key: "ai", enabled: true }],
                    ai_features: [{ key: "talent_intelligence", enabled: true }]
                  }
                }
              ]
            };
          }

          return { rows: [] };
        }
      };

      const summary = await getRunByPublicId(pool, runRow.run_uuid, adminReq);
      assert.equal(summary.external_leads_count, 1);
    });
  });

  describe("resume document validation (GitHub PDF downloads)", () => {
    it("accepts PDF magic after leading newline and UTF-8 BOM", () => {
      const withNewline = Buffer.concat([Buffer.from("\n"), Buffer.from("%PDF-1.4\n")]);
      const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("%PDF-1.4\n")]);

      assert.equal(validateResumeDocument(withNewline, { filenameHint: "cv.pdf" }).ok, true);
      assert.equal(validateResumeDocument(withBom, { filenameHint: "cv.pdf" }).ok, true);
    });

    it("rejects HTML and plain text bodies when URL hint ends with .pdf", () => {
      const html = validateResumeDocument(Buffer.from("<!DOCTYPE html><html><body>resume</body></html>"), {
        filenameHint: "resume.pdf"
      });
      assert.equal(html.ok, false);
      assert.match(html.reason, /HTML or plain text/i);

      const plain = validateResumeDocument(
        Buffer.from("Jane Doe\nThis is a text resume, not a PDF.\n"),
        { filenameHint: "resume.pdf" }
      );
      assert.equal(plain.ok, false);
      assert.match(plain.reason, /HTML or plain text/i);
    });

    it("still accepts DOCX by ZIP magic at byte zero", () => {
      const docxLike = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      const result = validateResumeDocument(docxLike, {
        filenameHint: "resume.docx",
        allowedFormats: ["docx"]
      });
      assert.equal(result.ok, true);
      assert.equal(result.format, "docx");
    });
  });

  describe("Serper URL policy (HTTPS-only resume documents)", () => {
    it("rejects HTTP resume document URLs before ingestion with non_https_resume_url", () => {
      const verdict = evaluateExternalSearchHit(
        {
          provider_key: "serper_web_search",
          profile_url: "http://dcfashionfoundation.org/files/sample-resume.pdf",
          display_name: "Sample Resume PDF",
          headline: "Curriculum vitae"
        },
        { structuredQuery: STRUCTURED }
      );

      assert.equal(verdict.accept, false);
      assert.equal(verdict.rejection_reason, "non_https_resume_url");
    });

    it("still accepts HTTPS direct resume document URLs", () => {
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
    });
  });
});
