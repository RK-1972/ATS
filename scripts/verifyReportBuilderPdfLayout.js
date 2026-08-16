/**
 * Phase 6 — PDF multi-page layout verification.
 * Run: node scripts/verifyReportBuilderPdfLayout.js
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { PDFParse } = require("pdf-parse");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const OUTPUT_DIR = path.join(__dirname, "..", ".export-verify", "pdf-layout");

const TWELVE_FIELD_CONFIG = {
  dataset: "CANDIDATE_PIPELINE",
  fields: [
    "requisition_code",
    "stage_name",
    "applied_on",
    "candidate_code",
    "candidate_name",
    "email_id",
    "primary_skill",
    "candidate_status",
    "position_title",
    "department",
    "assigned_recruiter_code",
    "assigned_recruiter_name"
  ],
  filters: [],
  sort: [{ field: "applied_on", direction: "desc" }],
  groupBy: []
};

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const results = [];

function record(test, passed, detail = "") {
  results.push({ test, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}: ${test}${detail ? ` — ${detail}` : ""}`);
  if (!passed) {
    process.exitCode = 1;
  }
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "8h" });
}

function extractMediaBoxes(buffer) {
  const source = buffer.toString("latin1");
  return [...source.matchAll(/\/MediaBox\s*\[\s*([\d.\s]+)\]/g)].map((match) =>
    match[1].trim().replace(/\s+/g, " ")
  );
}

function normalizeMediaBox(box) {
  const parts = box.split(" ").map(Number);
  if (parts.length !== 4) {
    return box;
  }

  return `${parts[2]}x${parts[3]}`;
}

function isLandscapeBox(box) {
  const parts = box.split("x").map(Number);
  return parts.length === 2 && parts[0] > parts[1];
}

async function postExport(token, body) {
  return fetch(`${API_BASE_URL}/api/v1/reports/export`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function postQuery(token, body) {
  return fetch(`${API_BASE_URL}/api/v1/reports/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function parsePdf(buffer) {
  const parser = new PDFParse(new Uint8Array(buffer));
  return parser.getText();
}

async function renderPdfScreenshots(buffer, prefix) {
  const parser = new PDFParse(new Uint8Array(buffer));
  const screenshots = [];

  for (let page = 1; page <= 6; page += 1) {
    try {
      const shot = await parser.getScreenshot(page, {
        scale: 1.5,
        imageBuffer: true,
        imageDataUrl: false
      });

      if (!shot?.data) {
        break;
      }

      const filePath = path.join(OUTPUT_DIR, `${prefix}-page-${page}.png`);
      fs.writeFileSync(filePath, shot.data);
      screenshots.push(filePath);
    } catch {
      break;
    }
  }

  return screenshots;
}

function countReqCodes(text) {
  return (text.match(/REQ[-\dA-Z]*/g) || []).length;
}

async function inspectPdfExport(name, buffer, expectations = {}) {
  const filePath = path.join(OUTPUT_DIR, `${name}.pdf`);
  fs.writeFileSync(filePath, buffer);

  const mediaBoxes = extractMediaBoxes(buffer);
  const normalized = mediaBoxes.map(normalizeMediaBox);
  const uniqueSizes = [...new Set(normalized)];
  const parsed = await parsePdf(buffer);
  const text = parsed.text || "";

  record(`${name} opens`, buffer.slice(0, 4).toString() === "%PDF", filePath);
  record(`${name} page count`, parsed.total >= expectations.minPages && parsed.total <= expectations.maxPages, `pages=${parsed.total}, expected=${expectations.minPages}-${expectations.maxPages}`);
  record(`${name} uniform page size`, uniqueSizes.length === 1, uniqueSizes.join(" | "));
  record(
    `${name} expected orientation`,
    expectations.landscape == null || isLandscapeBox(normalized[0]) === expectations.landscape,
    `${normalized[0]} landscape=${isLandscapeBox(normalized[0])}`
  );
  record(`${name} no blank-page size drift`, uniqueSizes.length === 1, uniqueSizes.join(" | "));
  record(`${name} footer markers`, (text.match(/OPTALYNX \|/g) || []).length >= 1, "");
  record(`${name} page numbers`, (text.match(/Page\s+\d+/g) || []).length >= 1, "");
  record(`${name} no ISO timestamps`, !/\d{4}-\d{2}-\d{2}T/.test(text), "");

  if (expectations.columns) {
    expectations.columns.forEach((label) => {
      const parts = String(label).split(/\s+/).filter(Boolean);
      const found = text.includes(label) || parts.every((part) => text.includes(part));
      record(`${name} header ${label}`, found, "");
    });
  }

  if (expectations.rowCount != null) {
    const reqCount = countReqCodes(text);
    record(
      `${name} record count`,
      reqCount === expectations.rowCount,
      `reqTokens=${reqCount}, expected=${expectations.rowCount}`
    );
  }

  if (expectations.zeroResult) {
    record(
      `${name} zero message`,
      text.includes("No records match the selected criteria."),
      ""
    );
  }

  const screenshots = await renderPdfScreenshots(buffer, name);
  if (screenshots.length > 0) {
    record(`${name} visual screenshots`, true, screenshots.join(", "));
  }

  return { filePath, text, pages: parsed.total, mediaBoxes: normalized, screenshots };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const admin = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = 'Admin'
     LIMIT 1`
  );

  if (!admin.rows[0]) {
    record("Setup admin user", false, "No admin user");
    await pool.end();
    return;
  }

  const token = signToken(admin.rows[0]);

  console.log("\n=== TEST 1 — 41-row / 12-field Candidate Pipeline ===");
  const twelveQuery = await postQuery(token, { ...TWELVE_FIELD_CONFIG, page: 1, pageSize: 25 });
  const twelveBody = await twelveQuery.json();
  const twelveTotal = twelveBody.data?.pagination?.total_count || 0;
  const twelveExport = await postExport(token, { format: "pdf", ...TWELVE_FIELD_CONFIG });
  const twelveBuffer = Buffer.from(await twelveExport.arrayBuffer());
  await inspectPdfExport("twelve-field-41-row", twelveBuffer, {
    minPages: 2,
    maxPages: 5,
    landscape: true,
    rowCount: twelveTotal,
    columns: [
      "Requisition Code",
      "Pipeline Stage",
      "Applied On",
      "Candidate Code",
      "Candidate Name",
      "Email",
      "Candidate Primary Skill",
      "Candidate Status",
      "Position Title",
      "Department",
      "Assigned Recruiter Code",
      "Assigned Recruiter Name"
    ]
  });

  console.log("\n=== TEST 2 — narrow report ===");
  const narrowExport = await postExport(token, {
    format: "pdf",
    dataset: "CANDIDATE_PIPELINE",
    fields: ["requisition_code", "candidate_name", "stage_name", "applied_on"],
    filters: [],
    sort: [{ field: "applied_on", direction: "desc" }],
    groupBy: []
  });
  const narrowBuffer = Buffer.from(await narrowExport.arrayBuffer());
  await inspectPdfExport("narrow-report", narrowBuffer, {
    minPages: 2,
    maxPages: 4,
    landscape: false,
    rowCount: twelveTotal,
    columns: ["Requisition Code", "Candidate Name", "Pipeline Stage", "Applied On"]
  });

  console.log("\n=== TEST 3 — wide report ===");
  const wideExport = await postExport(token, {
    format: "pdf",
    dataset: "CANDIDATE_PIPELINE",
    fields: [
      "requisition_code",
      "candidate_name",
      "stage_name",
      "applied_on",
      "department",
      "primary_skill",
      "assigned_recruiter_name",
      "hiring_manager",
      "req_primary_skill"
    ],
    filters: [],
    sort: [{ field: "candidate_name", direction: "asc" }],
    groupBy: []
  });
  const wideBuffer = Buffer.from(await wideExport.arrayBuffer());
  await inspectPdfExport("wide-report", wideBuffer, {
    minPages: 2,
    maxPages: 5,
    landscape: true,
    rowCount: twelveTotal
  });

  console.log("\n=== TEST 4 — filtered report ===");
  const filteredExport = await postExport(token, {
    format: "pdf",
    ...TWELVE_FIELD_CONFIG,
    filters: [{ field: "stage_name", operator: "equals", value: "Applied" }]
  });
  const filteredQuery = await postQuery(token, {
    ...TWELVE_FIELD_CONFIG,
    filters: [{ field: "stage_name", operator: "equals", value: "Applied" }],
    page: 1,
    pageSize: 25
  });
  const filteredBody = await filteredQuery.json();
  const filteredTotal = filteredBody.data?.pagination?.total_count || 0;
  const filteredBuffer = Buffer.from(await filteredExport.arrayBuffer());
  await inspectPdfExport("filtered-report", filteredBuffer, {
    minPages: 1,
    maxPages: 4,
    landscape: true,
    rowCount: filteredTotal
  });

  console.log("\n=== TEST 5 — zero-result report ===");
  const zeroExport = await postExport(token, {
    format: "pdf",
    ...TWELVE_FIELD_CONFIG,
    filters: [{ field: "requisition_code", operator: "equals", value: "ZZZ-NO-SUCH-REQ" }]
  });
  const zeroBuffer = Buffer.from(await zeroExport.arrayBuffer());
  await inspectPdfExport("zero-result-report", zeroBuffer, {
    minPages: 1,
    maxPages: 1,
    landscape: true,
    zeroResult: true
  });

  console.log("\n=== Excel / CSV regression ===");
  for (const format of ["xlsx", "csv"]) {
    const response = await postExport(token, { format, ...TWELVE_FIELD_CONFIG });
    const disposition = response.headers.get("content-disposition") || "";
    record(
      `${format.toUpperCase()} regression`,
      response.ok && disposition.includes(`.${format}`),
      disposition
    );
  }

  console.log("\n=== Acceptance matrix ===");
  console.table(results);

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
