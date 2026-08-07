/**
 * Label-based Annexure-A row mapping for Offer Letter DOCX merge.
 * Rows are matched by first-cell text — never by table row index.
 * Add future template rows (LTA, Food Allowance, etc.) here only.
 */

const ANNEXURE_LABEL_ROWS = [
  {
    id: "basic",
    labels: ["Basic"],
    monthly: (breakup) => breakup.basicMonthly,
    annual: (breakup) => breakup.basicAnnual
  },
  {
    id: "hra",
    labels: ["HRA"],
    monthly: (breakup) => breakup.hraMonthly,
    annual: (breakup) => breakup.hraAnnual
  },
  {
    id: "conveyance",
    labels: ["Conveyance"],
    monthly: (breakup) => breakup.conveyanceMonthly,
    annual: (breakup) => breakup.conveyanceAnnual
  },
  {
    id: "medical-reimbursement",
    labels: ["Medical Reimbursement"],
    monthly: (breakup) => breakup.medicalMonthly,
    annual: (breakup) => breakup.medicalAnnual
  },
  {
    id: "education",
    labels: ["Education"],
    monthly: (breakup) => breakup.educationMonthly,
    annual: (breakup) => breakup.educationAnnual
  },
  {
    id: "special-allowance",
    labels: ["Special Allowance"],
    monthly: (breakup) => breakup.specialAllowanceMonthly,
    annual: (breakup) => breakup.specialAllowanceAnnual
  },
  {
    id: "gross-salary",
    labels: ["Gross Salary (Rs.)", "Gross Salary"],
    monthly: (breakup) => breakup.grossMonthly,
    annual: (breakup) => breakup.grossAnnual
  },
  {
    id: "provident-fund",
    labels: ["Provident Fund"],
    monthly: (breakup) => breakup.employerPF,
    annual: (breakup) => breakup.employerPFAnnual
  },
  {
    id: "gratuity",
    labels: ["Gratuity"],
    monthly: (breakup) => breakup.gratuity,
    annual: (breakup) => breakup.gratuityAnnual
  },
  {
    id: "esic",
    labels: ["ESIC"],
    monthly: (breakup) => breakup.esicMonthly,
    annual: (breakup) => breakup.esicAnnual
  },
  {
    id: "statutory-bonus",
    labels: ["Statutory Bonus", "Bonus Payment payable quarterly"],
    monthly: (breakup) => breakup.statutoryBonusMonthly,
    annual: (breakup) => breakup.statutoryBonusAnnual
  },
  {
    id: "company-contribution-total",
    labels: ["Company's Contribution"],
    monthly: (breakup) => breakup.employerContribution,
    annual: (breakup) => breakup.employerContributionAnnual,
    requireAmountCells: true
  },
  {
    id: "total-ctc",
    labels: ["Total CTC", "Total Monthly CTC", "Total Annual CTC"],
    monthly: (breakup) => breakup.totalCTCMonthly,
    annual: (breakup) => breakup.totalCTC
  }
];

function normalizeLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/[^\w\s'()./-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellHasAmountPlaceholder(cellText) {
  return /[\d,]/.test(String(cellText || ""));
}

function labelMatchesPattern(normalizedLabel, pattern) {
  const normalizedPattern = normalizeLabel(pattern);

  if (!normalizedPattern) {
    return false;
  }

  return (
    normalizedLabel === normalizedPattern ||
    normalizedLabel.startsWith(`${normalizedPattern} `) ||
    normalizedLabel.startsWith(normalizedPattern)
  );
}

function resolveAnnexureRowByLabel(labelText, cells) {
  if (!Array.isArray(cells) || cells.length < 3) {
    return null;
  }

  const normalizedLabel = normalizeLabel(labelText);
  const monthlyCellText = cells[1]?.text ?? "";
  const annualCellText = cells[2]?.text ?? "";

  const sortedMappings = [...ANNEXURE_LABEL_ROWS].sort((left, right) => {
    const leftLength = Math.max(...left.labels.map((label) => label.length));
    const rightLength = Math.max(...right.labels.map((label) => label.length));
    return rightLength - leftLength;
  });

  return (
    sortedMappings.find((mapping) => {
      const labelMatched = mapping.labels.some((pattern) =>
        labelMatchesPattern(normalizedLabel, pattern)
      );

      if (!labelMatched) {
        return false;
      }

      if (mapping.requireAmountCells) {
        return (
          cellHasAmountPlaceholder(monthlyCellText) &&
          cellHasAmountPlaceholder(annualCellText)
        );
      }

      return true;
    }) || null
  );
}

module.exports = {
  ANNEXURE_LABEL_ROWS,
  normalizeLabel,
  resolveAnnexureRowByLabel
};
