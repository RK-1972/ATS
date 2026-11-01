/**
 * Candidate-oriented web search queries for OTI connectors (metadata-only APIs).
 * Phase 1: India-first external resume discovery (override via OTI_EXTERNAL_SOURCING_COUNTRY).
 */

const DEFAULT_SOURCING_COUNTRY = "India";
const DEFAULT_SERPER_GEO = Object.freeze({ gl: "in", hl: "en" });

const INDIAN_CITY_ALIASES = [
  { tokens: ["bengaluru", "bangalore"], label: "Bangalore" },
  { tokens: ["mumbai", "bombay"], label: "Mumbai" },
  { tokens: ["delhi", "new delhi", "ncr"], label: "Delhi NCR" },
  { tokens: ["gurgaon", "gurugram"], label: "Gurugram" },
  { tokens: ["noida"], label: "Noida" },
  { tokens: ["hyderabad"], label: "Hyderabad" },
  { tokens: ["chennai", "madras"], label: "Chennai" },
  { tokens: ["pune"], label: "Pune" },
  { tokens: ["kolkata", "calcutta"], label: "Kolkata" },
  { tokens: ["ahmedabad"], label: "Ahmedabad" },
  { tokens: ["kochi", "cochin"], label: "Kochi" },
  { tokens: ["coimbatore"], label: "Coimbatore" },
  { tokens: ["jaipur"], label: "Jaipur" },
  { tokens: ["chandigarh"], label: "Chandigarh" },
  { tokens: ["indore"], label: "Indore" },
  { tokens: ["bhubaneswar"], label: "Bhubaneswar" },
  { tokens: ["visakhapatnam", "vizag"], label: "Visakhapatnam" },
  { tokens: ["mysore", "mysuru"], label: "Mysuru" }
];

function uniqueTokens(tokens) {
  const seen = new Set();
  const output = [];

  for (const token of tokens || []) {
    const value = String(token || "").trim();
    if (!value) {
      continue;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(value);
  }

  return output;
}

function resolveSourcingCountry(requisition) {
  const fromEnv = String(process.env.OTI_EXTERNAL_SOURCING_COUNTRY || "").trim();
  const configured = fromEnv || DEFAULT_SOURCING_COUNTRY;
  const locationHint = String(requisition?.location || requisition?.work_location || "").trim();

  if (/india|indian|\bin\b/i.test(locationHint) && !/outside india|international/i.test(locationHint)) {
    return configured || DEFAULT_SOURCING_COUNTRY;
  }

  return configured || DEFAULT_SOURCING_COUNTRY;
}

function resolveSerperGeo(countryName) {
  const normalized = String(countryName || DEFAULT_SOURCING_COUNTRY).trim().toLowerCase();

  if (normalized === "india") {
    return { ...DEFAULT_SERPER_GEO };
  }

  return { gl: undefined, hl: "en" };
}

function extractIndianCityLabels(requisition) {
  const haystack = [
    requisition?.location,
    requisition?.work_location,
    requisition?.preferred_location,
    requisition?.job_description
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) {
    return [];
  }

  const labels = [];

  for (const entry of INDIAN_CITY_ALIASES) {
    if (entry.tokens.some((token) => haystack.includes(token))) {
      labels.push(entry.label);
    }
  }

  return uniqueTokens(labels);
}

function buildExperienceHint(requisition) {
  const minYears = requisition?.experience_min ?? requisition?.min_experience;
  const maxYears = requisition?.experience_max ?? requisition?.max_experience;

  if (minYears != null && minYears !== "" && maxYears != null && maxYears !== "") {
    return `${minYears}-${maxYears} years experience`;
  }

  if (minYears != null && minYears !== "") {
    return `${minYears}+ years experience`;
  }

  if (maxYears != null && maxYears !== "") {
    return `up to ${maxYears} years experience`;
  }

  return "";
}

function buildNegativeTerms() {
  return [
    "-jobs",
    "-job",
    "-hiring",
    "-careers",
    "-career",
    "-tutorial",
    "-course",
    "-certificate",
    "-training",
    "-program",
    "-enroll",
    "-recruitment",
    '-"job description"',
    "-stackoverflow",
    "-wikipedia",
    "-linkedin",
    "-site:linkedin.com",
    "-site:naukri.com",
    "-site:shine.com",
    "-site:foundit.in",
    "-site:instahyre.com",
    "-site:timesjobs.com"
  ].join(" ");
}

function buildWebSearchCandidateQuery({ queryText, structuredQuery, requisition } = {}) {
  const country = resolveSourcingCountry(requisition);
  const cities = extractIndianCityLabels(requisition);
  const tokens = uniqueTokens(structuredQuery?.skill_tokens).slice(0, 4);
  const role = String(
    requisition?.job_title || requisition?.position_title || queryText || ""
  ).trim();
  const skillExpr = tokens.length ? `(${tokens.join(" OR ")})` : "";
  const roleExpr = role ? `"${role.replace(/"/g, "")}"` : "";
  const experienceExpr = buildExperienceHint(requisition);
  const locationExpr = cities.length
    ? `(${cities.map((city) => `"${city}"`).join(" OR ")} OR ${country})`
    : country;

  const positive = [
    roleExpr,
    skillExpr,
    experienceExpr,
    locationExpr,
    "(filetype:pdf OR filetype:doc OR filetype:docx)",
    '(resume OR CV OR "curriculum vitae")'
  ]
    .filter(Boolean)
    .join(" ");

  return `${positive} ${buildNegativeTerms()}`.replace(/\s+/g, " ").trim();
}

function buildSerperIndiaResumeSearches({ queryText, structuredQuery, requisition, limit = 10 } = {}) {
  const country = resolveSourcingCountry(requisition);
  const geo = resolveSerperGeo(country);
  const primary = buildWebSearchCandidateQuery({ queryText, structuredQuery, requisition });
  const role = String(
    requisition?.job_title || requisition?.position_title || queryText || ""
  ).trim();
  const tokens = uniqueTokens(structuredQuery?.skill_tokens).slice(0, 3);
  const cities = extractIndianCityLabels(requisition);
  const negative = buildNegativeTerms();

  const searches = [{ q: primary, ...geo, num: Math.min(limit, 20) }];

  if (role && tokens.length) {
    const cityClause = cities[0] ? `"${cities[0]}"` : country;
    searches.push({
      q: `"${role.replace(/"/g, "")}" (${tokens.join(" OR ")}) ${cityClause} India (filetype:pdf OR filetype:doc OR filetype:docx) resume ${negative}`.replace(
        /\s+/g,
        " "
      ),
      ...geo,
      num: Math.min(limit, 15)
    });
  }

  if (cities.length > 1) {
    searches.push({
      q: `"${role.replace(/"/g, "")}" "${cities[0]}" "${cities[1]}" India resume filetype:pdf ${negative}`.replace(
        /\s+/g,
        " "
      ),
      ...geo,
      num: Math.min(limit, 12)
    });
  }

  const seen = new Set();
  return searches.filter((entry) => {
    const key = entry.q.toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function isResumeFocusedQuery(queryText) {
  const value = String(queryText || "").trim();

  if (!value) {
    return false;
  }

  return (
    /filetype:(pdf|doc|docx)/i.test(value) &&
    /(resume|curriculum vitae|\bcv\b)/i.test(value)
  );
}

module.exports = {
  DEFAULT_SOURCING_COUNTRY,
  buildWebSearchCandidateQuery,
  buildSerperIndiaResumeSearches,
  extractIndianCityLabels,
  resolveSourcingCountry,
  resolveSerperGeo,
  isResumeFocusedQuery,
  uniqueTokens
};
