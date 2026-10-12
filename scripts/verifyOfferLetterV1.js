/**
 * Production V1 verification:
 * SalaryCalculationService = persisted breakup = Offer Summary aggregation = Annexure mapping
 * compared against uploaded Salary Calculation Excel reference values.
 */
const PizZip = require("pizzip");

const salaryCalculationService = require("../services/salaryCalculationService");
const offerTemplateMergeService = require("../services/offerTemplateMergeService");
const {
  ANNEXURE_LABEL_ROWS,
  resolveAnnexureRowByLabel
} = require("../services/offerAnnexureMergeMapping");

const EXCEL_REFERENCE_CTC = 1550884.6153846153;
const LOW_CTC_CASE = 300000;

const EXCEL_REFERENCE = {
  basicMonthly: 49720,
  basicAnnual: 596640,
  hraMonthly: 31075,
  hraAnnual: 372900,
  conveyanceMonthly: 1600,
  conveyanceAnnual: 19200,
  medicalMonthly: 1250,
  medicalAnnual: 15000,
  educationMonthly: 200,
  educationAnnual: 2400,
  specialAllowanceMonthly: 40455,
  specialAllowanceAnnual: 485460,
  grossMonthly: 124300,
  grossAnnual: 1491600,
  employerPF: 1950,
  employerPFAnnual: 23400,
  gratuity: 2390.3846153846157,
  gratuityAnnual: 28684.61538461539,
  mediclaimMonthly: 600,
  mediclaimAnnual: 7200,
  esicMonthly: 0,
  esicAnnual: 0,
  statutoryBonusMonthly: 0,
  statutoryBonusAnnual: 0,
  employerContribution: 4940.3846153846152,
  employerContributionAnnual: 59284.61538461539,
  totalCTCMonthly: 129240.38461538461,
  totalCTC: 1550884.6153846153
};

const ANNEXURE_FIELDS = [
  ["basicMonthly", "basicAnnual"],
  ["hraMonthly", "hraAnnual"],
  ["conveyanceMonthly", "conveyanceAnnual"],
  ["medicalMonthly", "medicalAnnual"],
  ["educationMonthly", "educationAnnual"],
  ["specialAllowanceMonthly", "specialAllowanceAnnual"],
  ["grossMonthly", "grossAnnual"],
  ["employerPF", "employerPFAnnual"],
  ["gratuity", "gratuityAnnual"],
  ["mediclaimMonthly", "mediclaimAnnual"],
  ["esicMonthly", "esicAnnual"],
  ["statutoryBonusMonthly", "statutoryBonusAnnual"],
  ["employerContribution", "employerContributionAnnual"],
  ["totalCTCMonthly", "totalCTC"]
];

const DOCX_ANNEXURE_ROW_IDS = [
  "basic",
  "hra",
  "conveyance",
  "medical-reimbursement",
  "education",
  "special-allowance",
  "gross-salary",
  "provident-fund",
  "gratuity",
  "mediclaim-insurance",
  "esic",
  "statutory-bonus",
  "company-contribution-total",
  "total-ctc"
];

function assertClose(actual, expected, label, tolerance = 0.02) {
  const delta = Math.abs(Number(actual) - Number(expected));

  if (delta > tolerance) {
    return {
      ok: false,
      label,
      expected,
      actual,
      delta
    };
  }

  return { ok: true, label, expected, actual };
}

function compareBreakup(actual, expected, prefix) {
  const results = [];

  Object.keys(expected).forEach((key) => {
    results.push(assertClose(actual[key], expected[key], `${prefix}.${key}`));
  });

  return results;
}

function compareAnnexure(salaryBreakup, excel) {
  return ANNEXURE_FIELDS.flatMap(([monthlyKey, annualKey]) => [
    assertClose(salaryBreakup[monthlyKey], excel[monthlyKey], `Annexure.${monthlyKey}`),
    assertClose(salaryBreakup[annualKey], excel[annualKey], `Annexure.${annualKey}`)
  ]);
}

function compareOfferSummary(aggregated, excel) {
  const results = [];

  results.push(
    assertClose(aggregated.gross, excel.grossAnnual, "OfferSummary.grossAnnual")
  );
  results.push(
    assertClose(aggregated.totalCtc, excel.totalCTC, "OfferSummary.totalCTC")
  );

  const expectedRows = {
    Basic: excel.basicAnnual,
    HRA: excel.hraAnnual,
    Conveyance: excel.conveyanceAnnual,
    "Medical Reimbursement": excel.medicalAnnual,
    Education: excel.educationAnnual,
    "Special Allowance": excel.specialAllowanceAnnual,
    "Employer PF": excel.employerPFAnnual,
    Gratuity: excel.gratuityAnnual,
    "Mediclaim Insurance": excel.mediclaimAnnual,
    ESIC: excel.esicAnnual,
    "Statutory Bonus": excel.statutoryBonusAnnual
  };

  Object.entries(expectedRows).forEach(([componentName, amount]) => {
    const row = aggregated.ctcBreakup.find(
      (item) => item.componentName === componentName
    );

    results.push(
      assertClose(row?.amount || 0, amount, `OfferSummary.row.${componentName}`)
    );
  });

  return results;
}

function getCellText(cellXml) {
  return [...cellXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => match[1])
    .join("")
    .trim();
}

function parseIndianAmount(value) {
  const normalized = String(value || "")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "")
    .trim();

  if (!normalized) {
    return 0;
  }

  return Number(normalized);
}

function extractAnnexureRowsFromDocx(docxBuffer) {
  const zip = new PizZip(docxBuffer);
  const documentXml = zip.file("word/document.xml")?.asText() || "";
  const rows = [];

  for (const match of documentXml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)) {
    const cells = [...match[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map((cellMatch) => ({
      xml: cellMatch[0],
      text: getCellText(cellMatch[0])
    }));

    if (cells.length < 3) {
      continue;
    }

    const mapping = resolveAnnexureRowByLabel(cells[0].text, cells);

    if (!mapping) {
      continue;
    }

    rows.push({
      id: mapping.id,
      label: cells[0].text,
      monthly: parseIndianAmount(cells[1].text),
      annual: parseIndianAmount(cells[2].text)
    });
  }

  return rows;
}

function compareMergedDocxAnnexure(docxBuffer, salaryBreakup, prefix) {
  const extractedRows = extractAnnexureRowsFromDocx(docxBuffer);
  const byId = new Map(extractedRows.map((row) => [row.id, row]));
  const results = [];

  DOCX_ANNEXURE_ROW_IDS.forEach((rowId) => {
    const mapping = ANNEXURE_LABEL_ROWS.find((item) => item.id === rowId);
    const row = byId.get(rowId);

    if (!mapping) {
      results.push({
        ok: false,
        label: `${prefix}.mapping.${rowId}`,
        expected: "mapping",
        actual: "missing"
      });
      return;
    }

    if (!row) {
      results.push({
        ok: false,
        label: `${prefix}.row.${rowId}`,
        expected: "present in merged DOCX",
        actual: "missing"
      });
      return;
    }

    const expectedMonthly = mapping.monthly(salaryBreakup);
    const expectedAnnual = mapping.annual(salaryBreakup);

    results.push(
      assertClose(row.monthly, expectedMonthly, `${prefix}.${rowId}.monthly`)
    );
    results.push(
      assertClose(row.annual, expectedAnnual, `${prefix}.${rowId}.annual`)
    );
  });

  return results;
}

function mergeOfferLetterForBreakup(salaryBreakup, offeredCtc) {
  return offerTemplateMergeService.mergeOfferLetterTemplate({
    offerRow: {
      candidate_name: "Verification Candidate",
      position_title: "Verification Role",
      offered_ctc: offeredCtc,
      valid_until: "2026-07-01"
    },
    organizationRow: { organization_name: "IGS Engineering Quality" },
    salaryBreakup
  });
}

function printResults(title, results) {
  const failures = results.filter((item) => !item.ok);

  console.log(`\n${title}`);
  console.log(`  Checks: ${results.length}`);
  console.log(`  Passed: ${results.length - failures.length}`);
  console.log(`  Failed: ${failures.length}`);

  failures.forEach((item) => {
    console.log(
      `  FAIL ${item.label}: expected ${item.expected}, actual ${item.actual}, delta ${item.delta}`
    );
  });

  return failures.length === 0;
}

async function main() {
  const calculated = salaryCalculationService.calculateSalaryBreakup(EXCEL_REFERENCE_CTC);
  const persistedRows = salaryCalculationService.mapBreakupToPersistedRows(calculated);
  const offerSummary = salaryCalculationService.aggregatePersistedRows(persistedRows);
  const annexureBreakup = offerSummary.salaryBreakup;

  const mergedDocx = mergeOfferLetterForBreakup(annexureBreakup, EXCEL_REFERENCE_CTC);

  const calcOk = printResults(
    "1. SalaryCalculationService vs Excel",
    compareBreakup(calculated, EXCEL_REFERENCE, "Calculate")
  );

  const summaryOk = printResults(
    "2. Offer Summary (persisted aggregation) vs Excel",
    compareOfferSummary(offerSummary, EXCEL_REFERENCE)
  );

  const annexureOk = printResults(
    "3. Offer Letter Annexure source (persisted salaryBreakup) vs Excel",
    compareAnnexure(annexureBreakup, EXCEL_REFERENCE)
  );

  const parityOk = printResults(
    "4. Offer Summary = Annexure (same persisted breakup)",
    ANNEXURE_FIELDS.flatMap(([monthlyKey, annualKey]) => [
      assertClose(
        offerSummary.salaryBreakup[monthlyKey],
        annexureBreakup[monthlyKey],
        `Parity.${monthlyKey}`
      ),
      assertClose(
        offerSummary.salaryBreakup[annualKey],
        annexureBreakup[annualKey],
        `Parity.${annualKey}`
      )
    ])
  );

  const docxOk = printResults(
    "5. Merged DOCX Annexure-A rows vs salaryBreakup (reference CTC)",
    compareMergedDocxAnnexure(mergedDocx, annexureBreakup, "DocxAnnexure")
  );

  const lowCalculated = salaryCalculationService.calculateSalaryBreakup(LOW_CTC_CASE);
  const lowPersisted = salaryCalculationService.mapBreakupToPersistedRows(lowCalculated);
  const lowSummary = salaryCalculationService.aggregatePersistedRows(lowPersisted);
  const lowMergedDocx = mergeOfferLetterForBreakup(
    lowSummary.salaryBreakup,
    LOW_CTC_CASE
  );

  const lowZeroOk = printResults(
    "6. Low CTC zero-valued optional earnings in salaryBreakup",
    [
      assertClose(lowCalculated.conveyanceMonthly, 0, "LowCtc.conveyanceMonthly"),
      assertClose(lowCalculated.medicalMonthly, 0, "LowCtc.medicalMonthly"),
      assertClose(lowCalculated.educationMonthly, 0, "LowCtc.educationMonthly")
    ]
  );

  const lowDocxOk = printResults(
    `7. Merged DOCX Annexure-A rows vs salaryBreakup (low CTC ${LOW_CTC_CASE})`,
    compareMergedDocxAnnexure(lowMergedDocx, lowSummary.salaryBreakup, "LowCtcDocx")
  );

  console.log(`\nMerged DOCX size: ${mergedDocx.length} bytes`);

  const allOk =
    calcOk &&
    summaryOk &&
    annexureOk &&
    parityOk &&
    docxOk &&
    lowZeroOk &&
    lowDocxOk;

  if (!allOk) {
    process.exitCode = 1;
    console.log("\nVERIFICATION RESULT: FAILED");
    return;
  }

  console.log("\nVERIFICATION RESULT: PASSED");
  console.log(
    "Offer Summary, salaryBreakup, and merged DOCX Annexure-A match for reference and low CTC cases."
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
