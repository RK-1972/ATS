/**

 * Maps compensation engine output to offer-letter persistence and DOCX annexure breakup.

 * Display names align with Offer Annexure-A templates (offerAnnexureMergeMapping.js).

 */



const { roundAmount } = require("./compensationEngineService");




const LETTER_DISPLAY_NAME_BY_CODE = {

  BASIC_DA: "Basic",

  HRA: "HRA",

  EMPLOYER_PF: "Employer PF",

  EMPLOYER_ESI: "ESIC",

  GRATUITY: "Gratuity",

  MEDICAL_ALLOWANCE: "Medical Reimbursement",

  BONUS: "Statutory Bonus",

  VARIABLE_PAY: "Monthly Fixed Incentive",

  RETENTION_BONUS: "Retention Bonus",

  SPECIAL_ALLOWANCE: "Special Allowance"

};



const GROSS_COMPONENT_CODES = new Set([

  "BASIC_DA",

  "HRA",

  "MEDICAL_ALLOWANCE",

  "SPECIAL_ALLOWANCE",

  "VARIABLE_PAY"

]);



const EMPLOYER_CONTRIBUTION_CODES = new Set([

  "EMPLOYER_PF",

  "EMPLOYER_ESI",

  "GRATUITY",

  "BONUS"

]);



function resolveLetterDisplayName(component) {

  const code = String(component.componentCode || component.component_code || "").trim();



  if (LETTER_DISPLAY_NAME_BY_CODE[code]) {

    return LETTER_DISPLAY_NAME_BY_CODE[code];

  }



  return String(component.componentName || component.component_name || code || "Component").trim();

}



function isGrossComponentCode(componentCode) {

  return GROSS_COMPONENT_CODES.has(String(componentCode || "").trim());

}



function mapEvaluationToPersistedRows(evaluation) {

  return (evaluation.components || []).map((component, index) => ({

    component_code: component.componentCode,

    component_name: resolveLetterDisplayName(component),

    amount: roundAmount(component.amount),

    display_order: component.displayOrder || index + 1

  }));

}



function buildSalaryBreakupFromAmounts(amountByDisplay, evaluationMeta = {}) {

  const basicAnnual = amountByDisplay.Basic || 0;

  const hraAnnual = amountByDisplay.HRA || 0;

  const medicalAnnual = amountByDisplay["Medical Reimbursement"] || 0;

  const specialAnnual = amountByDisplay["Special Allowance"] || 0;

  const incentiveAnnual = amountByDisplay["Monthly Fixed Incentive"] || 0;



  const grossAnnual = roundAmount(

    evaluationMeta.grossAnnual != null

      ? evaluationMeta.grossAnnual

      : Object.entries(amountByDisplay).reduce((sum, [name, amount]) => {

          const code = Object.entries(LETTER_DISPLAY_NAME_BY_CODE).find(

            ([, display]) => display === name

          )?.[0];



          if (code && isGrossComponentCode(code)) {

            return sum + Number(amount || 0);

          }



          return sum;

        }, 0)

  );



  const employerPFAnnual = amountByDisplay["Employer PF"] || 0;

  const gratuityAnnual = amountByDisplay.Gratuity || 0;

  const mediclaimAnnual = 0;

  const esicAnnual = amountByDisplay.ESIC || 0;

  const statutoryBonusAnnual = amountByDisplay["Statutory Bonus"] || 0;



  const employerContributionAnnual = roundAmount(

    employerPFAnnual + gratuityAnnual + mediclaimAnnual + esicAnnual + statutoryBonusAnnual

  );



  const totalCTC = roundAmount(

    evaluationMeta.totalCtc != null

      ? evaluationMeta.totalCtc

      : grossAnnual +

          employerPFAnnual +

          gratuityAnnual +

          esicAnnual +

          statutoryBonusAnnual

  );



  return {

    basicMonthly: roundAmount(basicAnnual / 12),

    basicAnnual: roundAmount(basicAnnual),

    hraMonthly: roundAmount(hraAnnual / 12),

    hraAnnual: roundAmount(hraAnnual),

    conveyanceMonthly: 0,

    conveyanceAnnual: 0,

    medicalMonthly: roundAmount(medicalAnnual / 12),

    medicalAnnual: roundAmount(medicalAnnual),

    educationMonthly: 0,

    educationAnnual: 0,

    specialAllowanceMonthly: roundAmount(specialAnnual / 12),

    specialAllowanceAnnual: roundAmount(specialAnnual),

    monthlyFixedIncentive: roundAmount(incentiveAnnual / 12),

    monthlyFixedIncentiveAnnual: roundAmount(incentiveAnnual),

    grossMonthly: roundAmount(grossAnnual / 12),

    grossAnnual: roundAmount(grossAnnual),

    employerPF: roundAmount(employerPFAnnual / 12),

    employerPFAnnual: roundAmount(employerPFAnnual),

    gratuity: roundAmount(gratuityAnnual / 12),

    gratuityAnnual: roundAmount(gratuityAnnual),

    mediclaimMonthly: 0,

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



function buildSalaryBreakupFromEvaluation(evaluation) {

  const amountByDisplay = Object.fromEntries(

    (evaluation.components || []).map((component) => [

      resolveLetterDisplayName(component),

      roundAmount(component.amount)

    ])

  );



  const grossAnnual = roundAmount(

    (evaluation.components || [])

      .filter((item) => item.includeInGross)

      .reduce((sum, item) => sum + Number(item.amount || 0), 0)

  );



  return buildSalaryBreakupFromAmounts(amountByDisplay, {

    grossAnnual,

    totalCtc: evaluation.totalCtc || evaluation.verifiedCtcTotal

  });

}



function buildSnapshotPayload(structure, components, evaluation, annualCtc) {

  return {

    structureId: structure.structureId,

    structureCode: structure.structureCode,

    structureName: structure.structureName,

    annualCtc: roundAmount(annualCtc),

    capturedOn: new Date().toISOString(),

    components: (components || []).map((row) => ({

      structureComponentId: row.structureComponentId,

      componentCode: row.componentCode,

      componentName: row.componentName,

      formulaType: row.formulaType,

      formulaValue: row.formulaValue,

      fixedAmount: row.fixedAmount,

      displayOrder: row.displayOrder,

      includeInCtc: row.includeInCtc,

      componentCategory: row.componentCategory

    })),

    calculationTrace: evaluation.calculationTrace || []

  };

}



function aggregatePersistedLetterRows(rows, structureName = "Compensation Engine") {

  const sortedRows = [...(rows || [])].sort(

    (left, right) => Number(left.display_order || 0) - Number(right.display_order || 0)

  );



  const amountByDisplay = Object.fromEntries(

    sortedRows.map((row) => [row.component_name, Number(row.amount || 0)])

  );



  const grossAnnual = sortedRows

    .filter((row) => isGrossComponentCode(row.component_code))

    .reduce((sum, row) => sum + Number(row.amount || 0), 0);



  const totalCTC = sortedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);



  const salaryBreakup = buildSalaryBreakupFromAmounts(amountByDisplay, {

    grossAnnual,

    totalCtc: totalCTC

  });



  const ctcBreakup = sortedRows.map((row) => ({

    componentName: row.component_name,

    componentCode: row.component_code || null,

    amount: Number(row.amount || 0),

    displayOrder: Number(row.display_order || 0),

    includeInCtc: true,

    includeInGross: isGrossComponentCode(row.component_code),

    formula: row.component_code || row.component_name

  }));



  return {

    structureName,

    gross: roundAmount(grossAnnual),

    totalCtc: roundAmount(totalCTC),

    ctcBreakup,

    salaryBreakup

  };

}



module.exports = {

  LETTER_DISPLAY_NAME_BY_CODE,

  GROSS_COMPONENT_CODES,

  EMPLOYER_CONTRIBUTION_CODES,

  resolveLetterDisplayName,

  mapEvaluationToPersistedRows,

  buildSalaryBreakupFromEvaluation,

  buildSalaryBreakupFromAmounts,

  buildSnapshotPayload,

  aggregatePersistedLetterRows,

  isGrossComponentCode

};
