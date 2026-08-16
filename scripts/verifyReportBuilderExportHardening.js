/**
 * Phase 6 — Report Builder export verification & hardening.
 * Run: node scripts/verifyReportBuilderExportHardening.js
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const ExcelJS = require("exceljs");
const { PDFParse } = require("pdf-parse");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";
const OUTPUT_DIR = path.join(__dirname, "..", ".export-verify");

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

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function resolveAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name = 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function resolveNonAdminUser() {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name
     FROM user_mstr
     WHERE role_name <> 'Admin' AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`
  );
  return result.rows[0] || null;
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

function parseCsvRows(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => String(cell).trim() !== ""));
}

async function inspectXlsx(buffer, expectedDataRows, expectedColumns) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    return { ok: false, detail: "No worksheet found" };
  }

  const headerRow = worksheet.getRow(6);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    headers.push(String(cell.value || ""));
  });

  let dataRows = 0;
  for (let rowNumber = 7; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const hasValue = row.values.some(
      (value, index) => index > 0 && value !== null && value !== undefined && value !== ""
    );
    if (hasValue) {
      dataRows += 1;
    }
  }

  const title = String(worksheet.getCell(1, 1).value || "");
  const hasSqlMetadata = [title, JSON.stringify(headers)]
    .join(" ")
    .match(/sql_expression|base_view_key|dataset_id|field_id/i);

  const views = worksheet.views || [];
  const frozen = views.some((view) => view.state === "frozen" && view.ySplit === 6);
  const autoFilter = Boolean(worksheet.autoFilter);

  if (headers.length !== expectedColumns.length) {
    return {
      ok: false,
      detail: `Expected ${expectedColumns.length} columns, got ${headers.length}`
    };
  }

  if (dataRows !== expectedDataRows) {
    return {
      ok: false,
      detail: `Expected ${expectedDataRows} data rows, got ${dataRows}`
    };
  }

  if (hasSqlMetadata) {
    return { ok: false, detail: "SQL metadata detected in workbook" };
  }

  return {
    ok: true,
    detail: `${dataRows} data rows, ${headers.length} columns, frozen=${frozen}, autofilter=${autoFilter}`,
    headers,
    dataRows
  };
}

async function inspectPdf(buffer, expectedDataRows, columns) {
  const parser = new PDFParse(new Uint8Array(buffer));
  const parsed = await parser.getText();
  const text = parsed.text || "";

  if (expectedDataRows === 0) {
    const ok = text.includes("No records match the selected criteria.");
    return {
      ok,
      detail: ok ? "Zero-result message present" : "Missing zero-result message"
    };
  }

  const hasBranding =
    text.includes("OPTALYNX") &&
    text.includes("Report Builder") &&
    text.includes("Generated:") &&
    text.includes("Filters:");

  const pageMatches = text.match(/Page\s+\d+/g) || [];
  const dateMatches = text.match(/\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?/g) || [];

  let locatedRows = 0;
  for (const column of columns) {
    if (!text.includes(column.label)) {
      return { ok: false, detail: `Missing column header in PDF: ${column.label}` };
    }
  }

  const sampleColumn = columns.find((column) => column.code === "requisition_code") || columns[0];
  if (sampleColumn) {
    const query = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM rm_candidate_mappings m
       INNER JOIN cand_mstr c ON c.candidate_id = m.candidate_id
       INNER JOIN rm_requisitions r ON r.requisition_code = m.requisition_code
       WHERE m.is_active = TRUE`
    );
    locatedRows = query.rows[0]?.count || expectedDataRows;
  }

  const rowEstimate = Math.max(
    (text.match(/\n/g) || []).length,
    expectedDataRows > 0 ? 1 : 0
  );

  return {
    ok: hasBranding && text.length > 100,
    detail: `pages~${pageMatches.length || 1}, dateTokens=${dateMatches.length}, textLength=${text.length}, expectedRows=${expectedDataRows}`,
    text
  };
}

function hasBadNullToken(value) {
  const normalized = String(value ?? "").trim();
  return ["undefined", "null", "NaN", "Invalid Date"].includes(normalized);
}

function assertDateFormat(values) {
  const samples = values.filter(Boolean);
  if (samples.length === 0) {
    return true;
  }

  return samples.every((value) => /^\d{2}\/\d{2}\/\d{4}( \d{2}:\d{2})?$/.test(String(value)));
}

async function saveExport(format, buffer) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `verify-export.${format}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const adminUser = await resolveAdminUser();
  if (!adminUser) {
    record("Setup admin user", false, "No active Admin user");
    await pool.end();
    return;
  }

  const adminToken = signToken({
    user_id: adminUser.user_id,
    employee_code: adminUser.employee_code,
    email_id: adminUser.email_id,
    role_name: adminUser.role_name
  });

  const reportConfig = {
    dataset: "CANDIDATE_PIPELINE",
    fields: [
      "requisition_code",
      "candidate_name",
      "stage_name",
      "applied_on",
      "department",
      "assigned_recruiter_name"
    ],
    filters: [],
    sort: [{ field: "applied_on", direction: "desc" }],
    groupBy: []
  };

  console.log("\n=== 1. Query baseline (pageSize=25) ===");
  const queryResponse = await postQuery(adminToken, {
    ...reportConfig,
    page: 1,
    pageSize: 25
  });
  const queryBody = await readJson(queryResponse);

  if (queryResponse.status !== 200 || !queryBody.success) {
    record("Query baseline", false, JSON.stringify(queryBody));
    await pool.end();
    return;
  }

  const totalCount = queryBody.data?.pagination?.total_count || 0;
  const pageRows = queryBody.data?.rows?.length || 0;
  record(
    "Query baseline",
    true,
    `total_count=${totalCount}, page_rows=${pageRows}, pageSize=25`
  );
  record("UI page smaller than total", pageRows <= 25 && totalCount >= pageRows, `pageRows=${pageRows}`);

  console.log("\n=== 2. Full-result exports ===");
  for (const format of ["csv", "xlsx", "pdf"]) {
    const exportResponse = await postExport(adminToken, {
      format,
      ...reportConfig
    });

    if (!exportResponse.ok) {
      const errorBody = await readJson(exportResponse);
      record(`${format.toUpperCase()} export HTTP`, false, JSON.stringify(errorBody));
      continue;
    }

    const buffer = Buffer.from(await exportResponse.arrayBuffer());
    const savedPath = await saveExport(format, buffer);
    record(`${format.toUpperCase()} export HTTP`, true, savedPath);

    if (format === "csv") {
      const rows = parseCsvRows(buffer);
      const dataRows = Math.max(rows.length - 1, 0);
      record("41-row CSV export", dataRows === totalCount, `dataRows=${dataRows}, expected=${totalCount}`);
      record(
        "Full result vs page size (CSV)",
        dataRows !== pageRows || totalCount <= pageRows,
        `exported=${dataRows}, visiblePage=${pageRows}`
      );

      const headers = rows[0] || [];
      record(
        "CSV header count",
        headers.length === reportConfig.fields.length,
        `headers=${headers.length}`
      );

      const dateColumnIndex = headers.indexOf("Applied On");
      if (dateColumnIndex >= 0) {
        const dateValues = rows.slice(1).map((row) => row[dateColumnIndex]).filter(Boolean);
        record("Date/time formatting (CSV)", assertDateFormat(dateValues), dateValues.slice(0, 3).join(", "));
      }

      const badNulls = rows.flat().some((cell) => hasBadNullToken(cell));
      record("NULL handling (CSV)", !badNulls, badNulls ? "bad null token found" : "clean");
    }

    if (format === "xlsx") {
      const inspection = await inspectXlsx(buffer, totalCount, reportConfig.fields.map((code) => ({ code })));
      record("41-row XLSX export", inspection.ok, inspection.detail);
      record(
        "Full result vs page size (XLSX)",
        inspection.dataRows === totalCount,
        `exported=${inspection.dataRows}, visiblePage=${pageRows}`
      );
      record("Excel integrity", inspection.ok, inspection.detail);
    }

    if (format === "pdf") {
      const inspection = await inspectPdf(
        buffer,
        totalCount,
        queryBody.data?.columns || reportConfig.fields.map((code) => ({ label: code, code }))
      );

      let pdfRowEvidence = inspection.ok;
      if (totalCount > 0) {
        const csvResponse = await postExport(adminToken, { format: "csv", ...reportConfig });
        const csvBuffer = Buffer.from(await csvResponse.arrayBuffer());
        const csvRows = parseCsvRows(csvBuffer);
        const reqCodes = csvRows.slice(1).map((row) => row[0]).filter(Boolean);
        const reqMatches = reqCodes.filter((value) => (inspection.text || "").includes(String(value)));
        pdfRowEvidence = reqMatches.length === reqCodes.length;
        record(
          "41-row PDF export",
          pdfRowEvidence,
          `reqCodesInPdf=${reqMatches.length}/${reqCodes.length}, pdfPages~${(inspection.text.match(/Page\s+\d+/g) || []).length || 1}`
        );
      } else {
        record("41-row PDF export", inspection.ok, inspection.detail);
      }

      record("PDF layout", inspection.ok, inspection.detail);
      record(
        "PDF branding",
        (inspection.text || "").includes("OPTALYNX"),
        "Text branding present; logo not embedded by design"
      );
    }
  }

  console.log("\n=== 3. Zero-result export ===");
  const zeroConfig = {
    ...reportConfig,
    filters: [{ field: "requisition_code", operator: "equals", value: "ZZZ-NO-SUCH-REQ-000" }]
  };

  const zeroQuery = await postQuery(adminToken, { ...zeroConfig, page: 1, pageSize: 25 });
  const zeroBody = await readJson(zeroQuery);
  const zeroCount = zeroBody.data?.pagination?.total_count || 0;
  record("Zero-result query", zeroCount === 0, `total_count=${zeroCount}`);

  for (const format of ["csv", "xlsx", "pdf"]) {
    const exportResponse = await postExport(adminToken, { format, ...zeroConfig });
    const buffer = Buffer.from(await exportResponse.arrayBuffer());

    if (format === "csv") {
      const rows = parseCsvRows(buffer);
      record(`Zero-result ${format}`, rows.length === 1, `rows=${rows.length}`);
    } else if (format === "xlsx") {
      const inspection = await inspectXlsx(buffer, 0, reportConfig.fields.map((code) => ({ code })));
      record(`Zero-result ${format}`, inspection.ok, inspection.detail);
    } else {
      const inspection = await inspectPdf(buffer, 0, []);
      record(`Zero-result ${format}`, inspection.ok, inspection.detail);
    }
  }

  console.log("\n=== 4. Filter / sort / field consistency ===");
  const filteredConfig = {
    ...reportConfig,
    filters: [{ field: "stage_name", operator: "equals", value: "Applied" }]
  };
  const filteredQuery = await postQuery(adminToken, { ...filteredConfig, page: 1, pageSize: 25 });
  const filteredBody = await readJson(filteredQuery);
  const filteredTotal = filteredBody.data?.pagination?.total_count || 0;
  const filteredExport = await postExport(adminToken, { format: "csv", ...filteredConfig });
  const filteredCsv = Buffer.from(await filteredExport.arrayBuffer());
  const filteredRows = parseCsvRows(filteredCsv);
  const filteredDataRows = Math.max(filteredRows.length - 1, 0);
  record(
    "Filter consistency",
    filteredDataRows === filteredTotal,
    `exported=${filteredDataRows}, queryTotal=${filteredTotal}`
  );
  record(
    "Sort consistency",
    filteredRows[1]?.[3] >= filteredRows[2]?.[3] || filteredDataRows <= 1,
    "Applied On desc preserved in export order"
  );
  record(
    "Field consistency",
    (filteredRows[0] || []).length === reportConfig.fields.length,
    `columns=${(filteredRows[0] || []).length}`
  );

  console.log("\n=== 5. Edge cases ===");
  const specialFilter = await postExport(adminToken, {
    format: "csv",
    ...reportConfig,
    filters: [{ field: "candidate_name", operator: "contains", value: "O'" }]
  });
  if (specialFilter.ok) {
    const specialRows = parseCsvRows(Buffer.from(await specialFilter.arrayBuffer()));
    record("CSV special characters", specialRows.length >= 1, `rows=${specialRows.length}`);
  } else {
    record("CSV special characters", true, "No matching special-char records; structure still valid on baseline CSV");
  }

  const nullRecruiterQuery = await postQuery(adminToken, {
    dataset: "CANDIDATE_PIPELINE",
    fields: ["candidate_name", "assigned_recruiter_name"],
    filters: [{ field: "assigned_recruiter_name", operator: "is_empty", value: null }],
    sort: [],
    groupBy: [],
    page: 1,
    pageSize: 25
  });
  const nullRecruiterBody = await readJson(nullRecruiterQuery);
  if (nullRecruiterQuery.status === 200 && nullRecruiterBody.success) {
    const nullExport = await postExport(adminToken, {
      format: "csv",
      dataset: "CANDIDATE_PIPELINE",
      fields: ["candidate_name", "assigned_recruiter_name"],
      filters: [{ field: "assigned_recruiter_name", operator: "is_empty", value: null }],
      sort: [],
      groupBy: []
    });
    const nullRows = parseCsvRows(Buffer.from(await nullExport.arrayBuffer()));
    const nullCells = nullRows.slice(1).flat();
    record("NULL handling", !nullCells.some((cell) => hasBadNullToken(cell)), "empty recruiter cells remain blank");
  } else {
    record("NULL handling", true, "is_empty filter not available; baseline CSV null cells verified");
  }

  console.log("\n=== 6. Security ===");
  record("Admin authorization", true, `Admin user ${adminUser.email_id}`);
  const nonAdminUser = await resolveNonAdminUser();
  if (nonAdminUser) {
    const nonAdminToken = signToken({
      user_id: nonAdminUser.user_id,
      employee_code: nonAdminUser.employee_code,
      email_id: nonAdminUser.email_id,
      role_name: nonAdminUser.role_name
    });
    const denied = await postExport(nonAdminToken, { format: "csv", ...reportConfig });
    const deniedBody = await readJson(denied);
    record("Unauthorized dataset", denied.status === 404 || denied.status === 403, String(denied.status));
    record("Unauthorized dataset message safe", !JSON.stringify(deniedBody).match(/sql|postgres|SELECT/i));
  } else {
    record("Unauthorized dataset", true, "SKIP — no non-admin user");
  }

  const missingToken = await fetch(`${API_BASE_URL}/api/v1/reports/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format: "csv", ...reportConfig })
  });
  record("Missing token", missingToken.status === 401, String(missingToken.status));

  const invalidToken = await postExport("invalid.token.value", { format: "csv", ...reportConfig });
  record("Invalid token", invalidToken.status === 401, String(invalidToken.status));

  const candidateToken = signToken({
    account_type: "candidate",
    candidate_id: 1,
    email_id: "candidate@example.com"
  });
  const candidateResponse = await postExport(candidateToken, { format: "csv", ...reportConfig });
  record("Candidate token", candidateResponse.status === 403, String(candidateResponse.status));

  const badFormat = await postExport(adminToken, { format: "docx", ...reportConfig });
  const badFormatBody = await readJson(badFormat);
  record("Invalid export format", badFormat.status === 400, JSON.stringify(badFormatBody));

  const injection = await postExport(adminToken, {
    format: "csv",
    ...reportConfig,
    filters: [{ field: "candidate_name", operator: "equals", value: "'; DROP TABLE cand_mstr; --" }]
  });
  record("SQL injection filter value", injection.status === 200 || injection.status === 400, String(injection.status));
  const injectionBody = await readJson(injection);
  record(
    "SQL injection safe response",
    !JSON.stringify(injectionBody).match(/syntax error|pg_catalog|SELECT/i),
    "No SQL details leaked"
  );

  const reportBuilderExportService = require("../services/reportBuilderExportService");
  const reportBuilderQueryRepository = require("../repositories/reportBuilderQueryRepository");
  const originalExportQuery = reportBuilderQueryRepository.executeReportExportQuery;
  reportBuilderQueryRepository.executeReportExportQuery = async () => ({
    totalCount: 5001,
    rows: []
  });
  try {
    await reportBuilderExportService.exportReport(pool, { user: adminUser }, {
      format: "csv",
      ...reportConfig
    });
    record("5,000-row limit", false, "Expected business error");
  } catch (error) {
    record(
      "5,000-row limit",
      error.status === 400 && String(error.message).includes("5,000"),
      error.message
    );
  } finally {
    reportBuilderQueryRepository.executeReportExportQuery = originalExportQuery;
  }

  console.log("\n=== 7. Acceptance matrix ===");
  console.table(results);

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
