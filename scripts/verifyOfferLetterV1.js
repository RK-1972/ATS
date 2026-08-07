/**
 * Production V1 verification:
 * SalaryCalculationService = persisted breakup = Offer Summary aggregation = Annexure mapping
 * compared against uploaded Salary Calculation Excel reference values.
 */
const salaryCalculationService = require("../services/salaryCalculationService");
const offerTemplateMergeService = require("../services/offerTemplateMergeService");

const EXCEL_REFERENCE_CTC = 1550884.6153846153;

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
  ["grossMonthly", "grossAnnual"],
  ["employerPF", "employerPFAnnual"],
  ["gratuity", "gratuityAnnual"],
  ["esicMonthly", "esicAnnual"],
  ["statutoryBonusMonthly", "statutoryBonusAnnual"],
  ["employerContribution", "employerContributionAnnual"],
  ["totalCTCMonthly", "totalCTC"]
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

  const mergedDocx = offerTemplateMergeService.mergeOfferLetterTemplate({
    offerRow: {
      candidate_name: "Verification Candidate",
      position_title: "Verification Role",
      offered_ctc: EXCEL_REFERENCE_CTC,
      valid_until: "2026-07-01"
    },
    organizationRow: { organization_name: "IGS Engineering Quality" },
    salaryBreakup: annexureBreakup
  });

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

  console.log(`\nMerged DOCX size: ${mergedDocx.length} bytes`);

  const allOk = calcOk && summaryOk && annexureOk && parityOk;

  if (!allOk) {
    process.exitCode = 1;
    console.log("\nVERIFICATION RESULT: FAILED");
    return;
  }

  console.log("\nVERIFICATION RESULT: PASSED");
  console.log(
    "Offer Summary = Offer Letter Annexure = Salary Calculation Excel for all checked components."
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
