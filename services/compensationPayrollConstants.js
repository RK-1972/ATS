/** Component categories summed into offer-letter gross earnings (configurable taxonomy, not statutory). */
const GROSS_EARNING_CATEGORIES = new Set(["EARNINGS", "ALLOWANCE", "VARIABLE"]);

/** ESI contribution wage ceiling (monthly gross) — verify against current EPFO/ESIC notifications. */
const ESI_MONTHLY_WAGE_THRESHOLD = 21000;

/** PF wage ceiling for contribution base (monthly) — EPFO ceiling; confirm with payroll policy. */
const PF_MONTHLY_WAGE_CEILING = 15000;

/** Default employer PF rate on PF wage base when structure does not override. */
const EMPLOYER_PF_RATE_PERCENT = 12;

function isIncludedInGrossCategory(componentCategory) {
  return GROSS_EARNING_CATEGORIES.has(String(componentCategory || "").trim());
}

module.exports = {
  GROSS_EARNING_CATEGORIES,
  ESI_MONTHLY_WAGE_THRESHOLD,
  PF_MONTHLY_WAGE_CEILING,
  EMPLOYER_PF_RATE_PERCENT,
  isIncludedInGrossCategory
};
