/**
 * Read-only runtime trace: compensation calculate → DB → offer detail
 * Usage: node scripts/_traceCompensationRuntime.js [offerId]
 */
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const OFFER_ID = process.argv[2] || "OFF-2026-60559";
const BASE_URL = process.env.TRACE_BASE_URL || "http://localhost:5000";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function section(title) {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

async function getAuthToken() {
  const userResult = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE LOWER(email_id) = LOWER($1)
     LIMIT 1`,
    ["admin@igs.com"]
  );

  if (!userResult.rows[0]) {
    throw new Error("admin@igs.com not found in user_mstr");
  }

  const user = userResult.rows[0];
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function apiRequest(method, path, token, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  return { status: response.status, json };
}

function sumAmounts(rows, field = "amount") {
  return Number(
    rows.reduce((sum, row) => sum + Number(row[field] || 0), 0).toFixed(2)
  );
}

async function main() {
  section(`RUNTIME TRACE — Offer ${OFFER_ID}`);

  const token = await getAuthToken();

  section("STEP 0 — Offer master row (om_offers)");
  const offerRow = await pool.query(
    `SELECT offer_id, offered_ctc, currency, offer_status
     FROM om_offers WHERE offer_id = $1`,
    [OFFER_ID]
  );
  console.log(JSON.stringify(offerRow.rows[0] || null, null, 2));

  if (!offerRow.rows[0]) {
    console.log("Offer not found — stopping trace.");
    await pool.end();
    return;
  }

  const approvedCtc = Number(offerRow.rows[0].offered_ctc || 0);

  section("STEP 1 — GET /api/v1/offer-letters/:id (BEFORE calculate)");
  const detailBefore = await apiRequest(
    "GET",
    `/api/v1/offer-letters/${OFFER_ID}`,
    token
  );
  console.log("HTTP status:", detailBefore.status);
  console.log(JSON.stringify(detailBefore.json, null, 2));

  const letterBefore = await pool.query(
    `SELECT letter_id, status, compensation_calculated_on, compensation_calculated_by
     FROM om_offer_letters WHERE offer_id = $1`,
    [OFFER_ID]
  );
  console.log("\nDB om_offer_letters (before):");
  console.log(JSON.stringify(letterBefore.rows[0] || null, null, 2));

  const ctcBefore = await pool.query(
    `SELECT ctc_id, letter_id, component_name, amount, display_order
     FROM om_offer_letter_ctc
     WHERE letter_id = $1
     ORDER BY display_order ASC, ctc_id ASC`,
    [letterBefore.rows[0]?.letter_id || "__none__"]
  );
  console.log("\nDB om_offer_letter_ctc (before):");
  console.log(JSON.stringify(ctcBefore.rows, null, 2));
  console.log("Sum of persisted amounts (before):", sumAmounts(ctcBefore.rows));

  section("STEP 2 — POST /api/v1/compensation/calculate");
  const calcPayload = { offerId: OFFER_ID, annualCtc: approvedCtc };
  console.log("Request body:", JSON.stringify(calcPayload, null, 2));

  const calcResponse = await apiRequest(
    "POST",
    "/api/v1/compensation/calculate",
    token,
    calcPayload
  );
  console.log("HTTP status:", calcResponse.status);
  console.log("Full JSON response:");
  console.log(JSON.stringify(calcResponse.json, null, 2));

  const calcExecuted = calcResponse.status === 200 && calcResponse.json?.success;
  console.log("\nDoes POST /api/v1/compensation/calculate execute?", calcExecuted ? "YES" : "NO");

  section("STEP 3 — DB om_offer_letter_ctc (AFTER calculate)");
  const letterAfter = await pool.query(
    `SELECT letter_id, status, compensation_calculated_on, compensation_calculated_by
     FROM om_offer_letters WHERE offer_id = $1`,
    [OFFER_ID]
  );
  console.log("DB om_offer_letters (after):");
  console.log(JSON.stringify(letterAfter.rows[0] || null, null, 2));

  const ctcAfter = await pool.query(
    `SELECT ctc_id, letter_id, component_name, amount, display_order
     FROM om_offer_letter_ctc
     WHERE letter_id = $1
     ORDER BY display_order ASC, ctc_id ASC`,
    [letterAfter.rows[0]?.letter_id || "__none__"]
  );
  console.log("\nDB om_offer_letter_ctc rows written:");
  console.log(JSON.stringify(ctcAfter.rows, null, 2));
  console.log("Sum of persisted amounts (after):", sumAmounts(ctcAfter.rows));

  section("STEP 4 — GET /api/v1/offer-letters/:id (AFTER calculate)");
  const detailAfter = await apiRequest(
    "GET",
    `/api/v1/offer-letters/${OFFER_ID}`,
    token
  );
  console.log("HTTP status:", detailAfter.status);
  console.log(JSON.stringify(detailAfter.json, null, 2));

  section("STEP 5 — Reconciliation");
  const calcData = calcResponse.json?.data || {};
  const detailData = detailAfter.json?.data || {};

  const calcTotal = Number(calcData.totalCtc || 0);
  const detailTotal = Number(detailData.totalCtc || 0);
  const dbTotal = sumAmounts(ctcAfter.rows);
  const detailBreakupSum = sumAmounts(detailData.ctcBreakup || [], "amount");

  console.log({
    approvedAnnualCtc: approvedCtc,
    calcApi_totalCtc: calcTotal,
    calcApi_gross: calcData.gross,
    calcApi_componentSum: sumAmounts(calcData.components || [], "amount"),
    db_persistedSum: dbTotal,
    detailApi_totalCtc: detailTotal,
    detailApi_gross: detailData.gross,
    detailApi_ctcBreakupSum: detailBreakupSum,
    calcMatchesApproved: Math.abs(calcTotal - approvedCtc) <= 0.01,
    dbMatchesCalcApi:
      calcExecuted && Math.abs(dbTotal - calcTotal) <= 0.01,
    detailMatchesDb:
      Math.abs(detailBreakupSum - dbTotal) <= 0.01
        && Math.abs(detailTotal - dbTotal) <= 0.01,
    detailMatchesApproved: Math.abs(detailTotal - approvedCtc) <= 0.01
  });

  if (calcData.components?.length) {
    console.log("\nCalc API components:");
    calcData.components.forEach((c) => {
      console.log(
        `  ${c.componentName}: amount=${c.amount}, includeInCtc=${c.includeInCtc}, includeInGross=${c.includeInGross}`
      );
    });
  }

  if (detailData.ctcBreakup?.length) {
    console.log("\nDetail API ctcBreakup:");
    detailData.ctcBreakup.forEach((c) => {
      console.log(`  ${c.componentName}: amount=${c.amount}`);
    });
  }

  section("STEP 6 — Frontend rendering simulation (mapPersistedCtcBreakup)");
  const PERSISTED_EARNINGS = new Set(["Basic + DA", "HRA"]);
  const persistedComponents = (detailData.ctcBreakup || [])
    .filter((item) => {
      const name = String(item.componentName || "").trim();
      return name && Number(item.amount || 0) > 0;
    })
    .map((item, index) => ({
      componentName: item.componentName,
      amount: Number(item.amount || 0),
      displayOrder: Number(item.displayOrder || index + 1)
    }));

  const frontendComponentSum = sumAmounts(persistedComponents);
  const frontendComputedGross = Number(
    persistedComponents
      .filter((item) => PERSISTED_EARNINGS.has(item.componentName))
      .reduce((sum, item) => sum + item.amount, 0)
      .toFixed(2)
  );
  const frontendGross =
    Number(detailData.gross || 0) > 0
      ? Number(detailData.gross)
      : frontendComputedGross;
  const frontendTotalCtc =
    Number(detailData.totalCtc || 0) > 0
      ? Number(detailData.totalCtc)
      : frontendComponentSum;

  console.log({
    source: "persisted detail.ctcBreakup (OfferCompensationSection skips calculate when present)",
    displayedGross: frontendGross,
    displayedTotalCtc: frontendTotalCtc,
    displayedComponentSum: frontendComponentSum,
    approvedAnnualCtc: approvedCtc,
    displayedTotalMatchesApproved:
      Math.abs(frontendTotalCtc - approvedCtc) <= 0.01,
    displayedComponentSumMatchesApproved:
      Math.abs(frontendComponentSum - approvedCtc) <= 0.01,
    calculateApiWouldRunOnOpen: !persistedComponents.length
  });

  console.log("\nComponents UI would render:");
  persistedComponents.forEach((c) => {
    console.log(`  ${c.componentName}: ${c.amount}`);
  });

  await pool.end();
}

main().catch(async (error) => {
  console.error("Trace failed:", error.message);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
