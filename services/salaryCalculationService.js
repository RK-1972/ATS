/**
 * Production V1 salary calculation — rules sourced from salary structure.xlsx only.
 * Input: fixed annual CTC. Output: complete monthly/annual breakup object.
 */

const GROSS_THRESHOLD = 37500;
const CONVEYANCE_AMOUNT = 1600;
const MEDICAL_AMOUNT = 1250;
const EDUCATION_AMOUNT = 200;
const PF_WAGE_CEILING = 15000;
const PF_RATE = 0.13;
const GRATUITY_DAYS = 15;
const GRATUITY_DIVISOR_DAYS = 26;
const GRATUITY_MONTHS = 12;
const MEDICLAIM_ANNUAL = 7200;
const CTC_TOLERANCE = 0.01;
const EARNINGS_COMPONENT_NAMES = new Set([
  "Basic",
  "HRA",
  "Conveyance",
  "Medical Reimbursement",
  "Education",
  "Special Allowance"
]);

const COMPONENT_FORMULAS = {
  Basic: "40% of Gross (65% if Gross < 37500)",
  HRA: "25% of Gross (35% if Gross < 37500)",
  Conveyance: "INR 1,600 if Gross > 37499",
  "Medical Reimbursement": "INR 1,250 if Gross > 37499",
  Education: "INR 200 if Gross > 37499",
  "Special Allowance": "Gross minus other earnings",
  "Employer PF": "13% of Basic (PF wage ceiling 15000)",
  Gratuity: "Basic / 26 x 15 / 12",
  "Mediclaim Insurance": "INR 7,200 annual premium",
  ESIC: "0",
  "Statutory Bonus": "0"
};

function roundAmount(value) {
  return Number(Number(value || 0).toFixed(2));
}

function calculateBasic(gross) {
  if (gross < GROSS_THRESHOLD) {
    return gross * 0.65;
  }

  return gross * 0.4;
}

function calculateHra(gross) {
  if (gross < GROSS_THRESHOLD) {
    return gross * 0.35;
  }

  return gross * 0.25;
}

function calculateConveyance(gross) {
  return gross > GROSS_THRESHOLD - 1 ? CONVEYANCE_AMOUNT : 0;
}

function calculateMedical(gross) {
  return gross > GROSS_THRESHOLD - 1 ? MEDICAL_AMOUNT : 0;
}

function calculateEducation(gross) {
  return gross > GROSS_THRESHOLD - 1 ? EDUCATION_AMOUNT : 0;
}

function calculateEmployerPf(basic) {
  const pfBase = Math.min(basic, PF_WAGE_CEILING);
  return pfBase * PF_RATE;
}

function calculateGratuity(basic) {
  return (basic / GRATUITY_DIVISOR_DAYS) * GRATUITY_DAYS / GRATUITY_MONTHS;
}

function calculateEsic() {
  return 0;
}

function calculateBonus() {
  return 0;
}

function calculateMonthlyFixedIncentive() {
  return 0;
}

function calculateFromGrossMonthly(grossMonthly) {
  const basicMonthly = calculateBasic(grossMonthly);
  const hraMonthly = calculateHra(grossMonthly);
  const conveyanceMonthly = calculateConveyance(grossMonthly);
  const medicalMonthly = calculateMedical(grossMonthly);
  const educationMonthly = calculateEducation(grossMonthly);
  const specialAllowanceMonthly =
    grossMonthly -
    basicMonthly -
    hraMonthly -
    conveyanceMonthly -
    medicalMonthly -
    educationMonthly;

  const employerPF = calculateEmployerPf(basicMonthly);
  const gratuity = calculateGratuity(basicMonthly);
  const mediclaimMonthly = MEDICLAIM_ANNUAL / 12;
  const esicMonthly = calculateEsic();
  const bonusMonthly = calculateBonus();
  const monthlyFixedIncentive = calculateMonthlyFixedIncentive();

  const employerContribution =
    employerPF +
    gratuity +
    mediclaimMonthly +
    esicMonthly +
    bonusMonthly +
    monthlyFixedIncentive;

  const totalCTCMonthly = grossMonthly + employerContribution;
  const totalCTCAnnual = totalCTCMonthly * 12;

  return {
    basicMonthly: roundAmount(basicMonthly),
    basicAnnual: roundAmount(basicMonthly * 12),
    hraMonthly: roundAmount(hraMonthly),
    hraAnnual: roundAmount(hraMonthly * 12),
    conveyanceMonthly: roundAmount(conveyanceMonthly),
    conveyanceAnnual: roundAmount(conveyanceMonthly * 12),
    medicalMonthly: roundAmount(medicalMonthly),
    medicalAnnual: roundAmount(medicalMonthly * 12),
    educationMonthly: roundAmount(educationMonthly),
    educationAnnual: roundAmount(educationMonthly * 12),
    specialAllowanceMonthly: roundAmount(specialAllowanceMonthly),
    specialAllowanceAnnual: roundAmount(specialAllowanceMonthly * 12),
    grossMonthly: roundAmount(grossMonthly),
    grossAnnual: roundAmount(grossMonthly * 12),
    employerPF: roundAmount(employerPF),
    employerPFAnnual: roundAmount(employerPF * 12),
    gratuity: roundAmount(gratuity),
    gratuityAnnual: roundAmount(gratuity * 12),
    mediclaimMonthly: roundAmount(mediclaimMonthly),
    mediclaimAnnual: roundAmount(MEDICLAIM_ANNUAL),
    esicMonthly: roundAmount(esicMonthly),
    esicAnnual: roundAmount(esicMonthly * 12),
    statutoryBonusMonthly: roundAmount(bonusMonthly),
    statutoryBonusAnnual: roundAmount(bonusMonthly * 12),
    monthlyFixedIncentive: roundAmount(monthlyFixedIncentive),
    employerContribution: roundAmount(employerContribution),
    employerContributionAnnual: roundAmount(employerContribution * 12),
    totalCTCMonthly: roundAmount(totalCTCMonthly),
    totalCTC: roundAmount(totalCTCAnnual)
  };
}

function resolveGrossMonthlyForFixedCtc(fixedAnnualCtc) {
  const target = Number(fixedAnnualCtc || 0);

  if (!target || target <= 0) {
    throw new Error("Fixed annual CTC must be greater than zero.");
  }

  let low = 0;
  let high = target / 12;

  for (let index = 0; index < 100; index += 1) {
    const mid = (low + high) / 2;
    const result = calculateFromGrossMonthly(mid);

    if (Math.abs(result.totalCTC - target) <= CTC_TOLERANCE) {
      return mid;
    }

    if (result.totalCTC < target) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return (low + high) / 2;
}

function calculateSalaryBreakup(fixedAnnualCtc) {
  const grossMonthly = resolveGrossMonthlyForFixedCtc(fixedAnnualCtc);
  const breakup = calculateFromGrossMonthly(grossMonthly);

  return {
    fixedAnnualCtc: roundAmount(fixedAnnualCtc),
    ...breakup
  };
}

function mapBreakupToPersistedRows(breakup) {
  return [
    { component_name: "Basic", amount: breakup.basicAnnual, display_order: 1 },
    { component_name: "HRA", amount: breakup.hraAnnual, display_order: 2 },
    {
      component_name: "Conveyance",
      amount: breakup.conveyanceAnnual,
      display_order: 3
    },
    {
      component_name: "Medical Reimbursement",
      amount: breakup.medicalAnnual,
      display_order: 4
    },
    { component_name: "Education", amount: breakup.educationAnnual, display_order: 5 },
    {
      component_name: "Special Allowance",
      amount: breakup.specialAllowanceAnnual,
      display_order: 6
    },
    {
      component_name: "Employer PF",
      amount: breakup.employerPFAnnual,
      display_order: 7
    },
    { component_name: "Gratuity", amount: breakup.gratuityAnnual, display_order: 8 },
    {
      component_name: "Mediclaim Insurance",
      amount: breakup.mediclaimAnnual,
      display_order: 9
    },
    { component_name: "ESIC", amount: breakup.esicAnnual, display_order: 10 },
    {
      component_name: "Statutory Bonus",
      amount: breakup.statutoryBonusAnnual,
      display_order: 11
    }
  ];
}

function mapPersistedRowsToBreakup(rows) {
  const amountByName = Object.fromEntries(
    (rows || []).map((row) => [row.component_name, Number(row.amount || 0)])
  );

  const basicAnnual = amountByName.Basic || 0;
  const hraAnnual = amountByName.HRA || 0;
  const conveyanceAnnual = amountByName.Conveyance || 0;
  const medicalAnnual = amountByName["Medical Reimbursement"] || 0;
  const educationAnnual = amountByName.Education || 0;
  const specialAllowanceAnnual = amountByName["Special Allowance"] || 0;
  const employerPFAnnual = amountByName["Employer PF"] || 0;
  const gratuityAnnual = amountByName.Gratuity || 0;
  const mediclaimAnnual = amountByName["Mediclaim Insurance"] || 0;
  const esicAnnual = amountByName.ESIC || 0;
  const statutoryBonusAnnual = amountByName["Statutory Bonus"] || 0;

  const grossAnnual =
    basicAnnual +
    hraAnnual +
    conveyanceAnnual +
    medicalAnnual +
    educationAnnual +
    specialAllowanceAnnual;
  const employerContributionAnnual =
    employerPFAnnual + gratuityAnnual + mediclaimAnnual + esicAnnual + statutoryBonusAnnual;
  const totalCTC = grossAnnual + employerContributionAnnual;

  return {
    basicMonthly: roundAmount(basicAnnual / 12),
    basicAnnual: roundAmount(basicAnnual),
    hraMonthly: roundAmount(hraAnnual / 12),
    hraAnnual: roundAmount(hraAnnual),
    conveyanceMonthly: roundAmount(conveyanceAnnual / 12),
    conveyanceAnnual: roundAmount(conveyanceAnnual),
    medicalMonthly: roundAmount(medicalAnnual / 12),
    medicalAnnual: roundAmount(medicalAnnual),
    educationMonthly: roundAmount(educationAnnual / 12),
    educationAnnual: roundAmount(educationAnnual),
    specialAllowanceMonthly: roundAmount(specialAllowanceAnnual / 12),
    specialAllowanceAnnual: roundAmount(specialAllowanceAnnual),
    grossMonthly: roundAmount(grossAnnual / 12),
    grossAnnual: roundAmount(grossAnnual),
    employerPF: roundAmount(employerPFAnnual / 12),
    employerPFAnnual: roundAmount(employerPFAnnual),
    gratuity: roundAmount(gratuityAnnual / 12),
    gratuityAnnual: roundAmount(gratuityAnnual),
    mediclaimMonthly: roundAmount(mediclaimAnnual / 12),
    mediclaimAnnual: roundAmount(mediclaimAnnual),
    esicMonthly: roundAmount(esicAnnual / 12),
    esicAnnual: roundAmount(esicAnnual),
    statutoryBonusMonthly: roundAmount(statutoryBonusAnnual / 12),
    statutoryBonusAnnual: roundAmount(statutoryBonusAnnual),
    employerContribution: roundAmount(employerContributionAnnual / 12),
    employerContributionAnnual: roundAmount(employerContributionAnnual),
    totalCTCMonthly: roundAmount(totalCTC / 12),
    totalCTC: roundAmount(totalCTC)
  };
}

function aggregatePersistedRows(rows) {
  const sortedRows = [...(rows || [])].sort(
    (left, right) => Number(left.display_order || 0) - Number(right.display_order || 0)
  );

  const breakup = mapPersistedRowsToBreakup(sortedRows);
  const ctcBreakup = sortedRows.map((row) => ({
    componentName: row.component_name,
    amount: Number(row.amount || 0),
    displayOrder: Number(row.display_order || 0),
    includeInCtc: true,
    includeInGross: EARNINGS_COMPONENT_NAMES.has(row.component_name),
    formula: COMPONENT_FORMULAS[row.component_name] || "Excel specification"
  }));

  return {
    structureName: "Salary Calculation Excel (V1)",
    gross: breakup.grossAnnual,
    totalCtc: breakup.totalCTC,
    ctcBreakup,
    salaryBreakup: breakup
  };
}

module.exports = {
  calculateSalaryBreakup,
  calculateFromGrossMonthly,
  mapBreakupToPersistedRows,
  mapPersistedRowsToBreakup,
  aggregatePersistedRows,
  roundAmount
};
