"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  indexExternalLeadDocument
} = require("../services/oti/otiExternalResumeIndexService");

const MIN_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<<>>\nendobj\nJane Doe\nJava Oracle Python\n"
);

describe("oti external resume index byte_length", () => {
  it("persists actual buffer byte_length when indexing a public PDF (partial document row)", async () => {
    const captured = {
      indexedByteLength: null
    };

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("SELECT index_id FROM oti_external_resume_index")) {
          return { rows: [] };
        }

        if (text.includes("INSERT INTO oti_external_resume_index")) {
          return { rows: [{ index_id: 1 }] };
        }

        if (text.includes("SELECT content_hash, extraction_status FROM oti_external_resume_index")) {
          return { rows: [] };
        }

        if (
          text.includes("FROM oti_external_resume_document") &&
          text.includes("WHERE document_id = $1")
        ) {
          return {
            rows: [
              {
                document_id: 7,
                storage_key: "oti/external-leads/10/abc.pdf",
                content_hash: "hash-abc",
                detected_format: "pdf",
                byte_length: MIN_PDF.length
              }
            ]
          };
        }

        if (text.includes("extraction_status = 'indexed'") && text.includes("byte_length = $8")) {
          captured.indexedByteLength = params[7];
          return { rows: [] };
        }

        if (text.includes("UPDATE oti_external_lead SET resume_index_status")) {
          return { rows: [] };
        }

        if (text.includes("FROM oti_external_resume_index") && text.includes("external_lead_id = $1")) {
          return {
            rows: [
              {
                external_lead_id: 10,
                extraction_status: "indexed",
                text_length: 20,
                attempt_count: 1
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    await indexExternalLeadDocument(
      pool,
      10,
      { document_id: 7 },
      {
        downloadResumeBuffer: async () => MIN_PDF,
        extractResumeText: async () => ({
          ok: true,
          text: "Jane Doe Java Oracle Python"
        })
      }
    );

    assert.equal(captured.indexedByteLength, MIN_PDF.length);
  });

  it("hydrates duplicate document metadata before unsupported-format index update", async () => {
    const captured = {
      unsupportedByteLength: null
    };

    const pool = {
      query: async (sql, params) => {
        const text = String(sql);

        if (text.includes("SELECT index_id FROM oti_external_resume_index")) {
          return { rows: [{ index_id: 2 }] };
        }

        if (text.includes("SELECT content_hash, extraction_status FROM oti_external_resume_index")) {
          return { rows: [] };
        }

        if (
          text.includes("FROM oti_external_resume_document") &&
          text.includes("WHERE document_id = $1")
        ) {
          return {
            rows: [
              {
                document_id: 8,
                storage_key: "oti/external-leads/11/doc.docx",
                content_hash: "hash-docx",
                detected_format: "docx",
                byte_length: 4096
              }
            ]
          };
        }

        if (text.includes("extraction_status = 'unsupported'") && text.includes("byte_length = $6")) {
          captured.unsupportedByteLength = params[5];
          return { rows: [] };
        }

        if (text.includes("UPDATE oti_external_lead SET resume_index_status = 'unsupported'")) {
          return { rows: [] };
        }

        if (text.includes("FROM oti_external_resume_index") && text.includes("external_lead_id = $1")) {
          return {
            rows: [
              {
                external_lead_id: 11,
                extraction_status: "unsupported",
                attempt_count: 1
              }
            ]
          };
        }

        return { rows: [] };
      }
    };

    await indexExternalLeadDocument(pool, 11, { document_id: 8 });

    assert.equal(captured.unsupportedByteLength, 4096);
  });
});
