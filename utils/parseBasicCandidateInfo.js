/**
 * Shared resume text parsing for Candidate Intake (recruiter upload, portal, OTI external).
 */

const RESUME_SECTION_HEADINGS = [
  "Education",
  "Experience",
  "Work Experience",
  "Professional Experience",
  "Skills",
  "Technical Skills",
  "Technical Expertise",
  "Projects",
  "Projects Undertaken",
  "Certifications",
  "Summary",
  "Professional Summary",
  "Objective",
  "Career Objective",
  "Profile",
  "Declaration",
  "Achievements",
  "Strengths",
  "Internship",
  "Internships",
  "Languages",
  "Interests",
  "References",
  "Contact",
  "Personal Details",
  "Personal Information",
  "About Me",
  "Work History",
  "Employment History",
  "Key Skills",
  "Core Competencies",
  "Core Skills",
  "Hobbies",
  "Extra Curricular Activities",
  "Extracurricular Activities",
  "Areas of Interest",
  "Area of Interest",
  "Technical Proficiency",
  "Qualifications",
  "Academic Qualifications",
  "Career Summary",
  "Career Highlights",
  "Professional Profile",
  "Personal Profile",
  "Software Skills",
  "Skill Set",
  "Resume",
  "Curriculum Vitae",
  "CV",
  "Head Particulars",
  "Personal Particulars",
  "General Particulars"
];

const SECTION_HEADING_WORDS = new Set(
  [
    "technical",
    "expertise",
    "professional",
    "summary",
    "skills",
    "skill",
    "experience",
    "education",
    "profile",
    "competency",
    "competencies",
    "qualifications",
    "qualification",
    "objective",
    "career",
    "employment",
    "work",
    "history",
    "projects",
    "project",
    "certifications",
    "certification",
    "strengths",
    "achievements",
    "achievement",
    "languages",
    "language",
    "interests",
    "interest",
    "references",
    "reference",
    "contact",
    "personal",
    "information",
    "details",
    "detail",
    "proficiency",
    "core",
    "key",
    "area",
    "areas",
    "software",
    "hardware",
    "declaration",
    "resume",
    "about",
    "internship",
    "internships",
    "hobbies",
    "extracurricular",
    "curriculum",
    "vitae",
    "employment",
    "undertaken",
    "highlights",
    "highlight",
    "academic",
    "functional",
    "regression",
    "smoke",
    "head",
    "particulars",
    "general",
    "overview",
    "table",
    "contents"
  ]
);

const NAME_LINE_STOPWORDS = new Set([
  "with",
  "and",
  "the",
  "for",
  "from",
  "having",
  "experienced",
  "skilled",
  "proficient",
  "working",
  "including",
  "using",
  "knowledge",
  "years",
  "year",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "of",
  "or",
  "as",
  "by",
  "is",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "over",
  "more",
  "than",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "under",
  "again",
  "further",
  "then",
  "once",
  "seeking",
  "looking",
  "aspiring",
  "strong",
  "excellent",
  "good",
  "well",
  "hands"
]);

const TECH_NAME_TOKENS = new Set([
  "playwright",
  "selenium",
  "python",
  "java",
  "sql",
  "pytest",
  "jenkins",
  "docker",
  "kubernetes",
  "postman",
  "rest assured",
  "mysql",
  "jira",
  "git",
  "typescript",
  "javascript",
  "react",
  "node",
  "api testing",
  "regression testing",
  "smoke testing",
  "functional testing",
  "oracle",
  "spring",
  "boot",
  "hibernate",
  "microservices",
  "api",
  "rest",
  "assured",
  "aws",
  "azure",
  "gcp",
  "linux",
  "unix",
  "html",
  "css",
  "angular",
  "vue",
  "kotlin",
  "scala",
  "golang",
  "go",
  "rust",
  "testing",
  "test",
  "automation",
  "framework",
  "manual",
  "agile",
  "scrum"
]);

const NAME_SCAN_LINE_LIMIT = 18;

function normalizeResumeHeadingLine(line) {
  return String(line || "")
    .trim()
    .toLowerCase()
    .replace(/[:|.\-–—]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isResumeSectionHeading(line) {
  const normalized = normalizeResumeHeadingLine(line);

  if (!normalized) {
    return false;
  }

  return RESUME_SECTION_HEADINGS.some((heading) => {
    const headingNormalized = normalizeResumeHeadingLine(heading);

    return (
      normalized === headingNormalized || normalized.startsWith(`${headingNormalized} `)
    );
  });
}

function isCompositeSectionHeading(line) {
  const words = normalizeResumeHeadingLine(line).split(" ").filter(Boolean);

  if (words.length === 0 || words.length > 5) {
    return false;
  }

  return words.every((word) => SECTION_HEADING_WORDS.has(word));
}

function isDescriptiveOrSummaryLine(line) {
  const trimmed = String(line || "").trim();

  if (!trimmed) {
    return true;
  }

  if (trimmed.length > 72) {
    return true;
  }

  const lower = trimmed.toLowerCase();

  if (
    /^(with|having|experienced|skilled|proficient|working|looking|seeking|aspiring|strong|excellent|good|well|hands\s+-?\s*on)\b/.test(
      lower
    )
  ) {
    return true;
  }

  if (/\d+(?:\.\d+)?\+?\s*years?\b/i.test(trimmed)) {
    return true;
  }

  if (/[,;]/.test(trimmed)) {
    return true;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);

  if (words.some((word) => NAME_LINE_STOPWORDS.has(word.toLowerCase()))) {
    return true;
  }

  const techHits = words.filter((word) => TECH_NAME_TOKENS.has(word.toLowerCase())).length;

  if (techHits >= 2) {
    return true;
  }

  if (techHits >= 1 && words.length >= 3) {
    return true;
  }

  return false;
}

function countTechTokensInLine(line) {
  const words = String(line || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return words.filter((word) => TECH_NAME_TOKENS.has(word.toLowerCase())).length;
}

function isDocumentTitleOrIdentityNoise(line) {
  const trimmed = String(line || "").trim();

  if (!trimmed) {
    return true;
  }

  if (/\bresume\s*[-–|]\s/i.test(trimmed)) {
    return true;
  }

  if (/\brecruit\s+agent\b/i.test(trimmed)) {
    return true;
  }

  return false;
}

function normalizeNameFieldText(value) {
  return String(value || "")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripNameFieldLabel(value) {
  const trimmed = normalizeNameFieldText(value);

  if (!trimmed) {
    return "";
  }

  const patterns = [
    /^(?:full\s+name|candidate\s+name)\s*[:\-]\s*(.+)$/i,
    /^(?:full\s+name|candidate\s+name)\s+(.+)$/i,
    /^name\b\s*[:\-]\s*(.+)$/i,
    /^name\b\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);

    if (match && String(match[1] || "").trim()) {
      return normalizeNameFieldText(match[1]);
    }
  }

  return trimmed;
}

function looksLikeCandidateName(line) {
  const normalized = String(line || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return false;
  }

  if (isDocumentTitleOrIdentityNoise(normalized)) {
    return false;
  }

  if (normalized.includes(":") || normalized.includes("|")) {
    return false;
  }

  if (isResumeSectionHeading(normalized) || isCompositeSectionHeading(normalized)) {
    return false;
  }

  if (isDescriptiveOrSummaryLine(normalized)) {
    return false;
  }

  if (!/^[A-Za-z][A-Za-z .'-]*$/.test(normalized)) {
    return false;
  }

  const words = normalized.split(" ").filter(Boolean);

  if (words.length < 1 || words.length > 8) {
    return false;
  }

  if (words.length === 1) {
    const token = words[0];

    if (token.length < 3 || token.length > 24) {
      return false;
    }

    if (TECH_NAME_TOKENS.has(token.toLowerCase())) {
      return false;
    }

    if (NAME_LINE_STOPWORDS.has(token.toLowerCase())) {
      return false;
    }

    if (SECTION_HEADING_WORDS.has(token.toLowerCase())) {
      return false;
    }

    if (token.toLowerCase() === "name") {
      return false;
    }

    return true;
  }

  if (countTechTokensInLine(normalized) >= 1) {
    return false;
  }

  const hasPersonalNameSignal = words.some(
    (word) => !TECH_NAME_TOKENS.has(word.toLowerCase()) && word.length >= 2
  );

  if (!hasPersonalNameSignal) {
    return false;
  }

  return true;
}

function isCandidateNameLabelLine(line) {
  const trimmed = normalizeNameFieldText(line);

  if (/^(?:full\s+name|candidate\s+name)\b/i.test(trimmed)) {
    return true;
  }

  return /^name\b\s*(?:[:\-]\s*|\s+)\S/i.test(trimmed);
}

function extractLabelledCandidateName(lines) {
  for (const line of lines.slice(0, 45)) {
    if (!isCandidateNameLabelLine(line)) {
      continue;
    }

    const value = stripNameFieldLabel(line);

    if (!value || value === line) {
      continue;
    }

    if (looksLikeCandidateName(value)) {
      return value.replace(/\s+/g, " ").trim();
    }
  }

  return null;
}

function extractHeaderCandidateName(lines, isIgnoredCandidateNameLine) {
  for (const line of lines.slice(0, NAME_SCAN_LINE_LIMIT)) {
    if (isIgnoredCandidateNameLine(line)) {
      continue;
    }

    if (/^(?:full\s+name|candidate\s+name)\b/i.test(line) || /^name\b\s*(?:[:\-]|\s+)\S/i.test(line)) {
      continue;
    }

    if (!looksLikeCandidateName(line)) {
      continue;
    }

    return line.replace(/\s+/g, " ").trim();
  }

  return null;
}

function resolveCandidateIdentity(lines, isIgnoredCandidateNameLine) {
  const labelled = extractLabelledCandidateName(lines);

  if (labelled) {
    return labelled;
  }

  return extractHeaderCandidateName(lines, isIgnoredCandidateNameLine);
}

function splitCandidateFullName(candidateName) {
  const cleaned = stripNameFieldLabel(candidateName).replace(/\s+/g, " ").trim();

  if (!cleaned || !looksLikeCandidateName(cleaned)) {
    return {
      first_name: "",
      last_name: ""
    };
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);

  return {
    first_name: parts[0] || "",
    last_name: parts.slice(1).join(" ") || ""
  };
}

function sanitizeCandidateDisplayName(value) {
  const cleaned = stripNameFieldLabel(value).replace(/\s+/g, " ").trim();

  if (!cleaned || !looksLikeCandidateName(cleaned)) {
    return null;
  }

  return cleaned;
}

function parseBasicCandidateInfo(extractedText) {
  const text = (extractedText || "").trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i;
  const mobileRegex = /(?:\+91[\s-]*)?[6-9][\d\s-]{8,12}\d/;

  const emailMatch = text.match(emailRegex);
  const email = emailMatch ? emailMatch[0] : null;

  const mobileMatch = text.match(mobileRegex);
  const mobile = mobileMatch ? mobileMatch[0].trim() : null;

  const isIgnoredCandidateNameLine = (line) => {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      return true;
    }

    if (/^\d+$/.test(trimmedLine)) {
      return true;
    }

    if (/^Page/i.test(trimmedLine)) {
      return true;
    }

    if (trimmedLine.startsWith("--")) {
      return true;
    }

    if (trimmedLine.includes("@")) {
      return true;
    }

    if (mobileRegex.test(trimmedLine)) {
      return true;
    }

    if (/^http/i.test(trimmedLine) || /^www/i.test(trimmedLine)) {
      return true;
    }

    if (isResumeSectionHeading(trimmedLine) || isCompositeSectionHeading(trimmedLine)) {
      return true;
    }

    return false;
  };

  const resolvedName = resolveCandidateIdentity(lines, isIgnoredCandidateNameLine);
  const candidate_name = resolvedName && looksLikeCandidateName(resolvedName) ? resolvedName : null;
  const { first_name, last_name } = splitCandidateFullName(candidate_name || "");

  const experienceRegex = /\d+(?:\.\d+)?\+?\s*years?/i;
  const experienceMatch = text.match(experienceRegex);
  const experience = experienceMatch ? experienceMatch[0].trim() : null;

  const educationKeywords = [
    "Bachelor",
    "B.E",
    "B.Tech",
    "M.Tech",
    "MCA",
    "MBA",
    "Diploma",
    "Degree"
  ];

  let education = null;

  for (const line of lines) {
    const matchedKeyword = educationKeywords.find((keyword) =>
      line.toLowerCase().includes(keyword.toLowerCase())
    );

    if (matchedKeyword) {
      education = line.trim();
      break;
    }
  }

  const skillKeywords = [
    "Playwright",
    "Selenium",
    "Python",
    "Java",
    "SQL",
    "Pytest",
    "Jenkins",
    "Docker",
    "Kubernetes",
    "Postman",
    "REST Assured",
    "MySQL",
    "Jira",
    "Git",
    "TypeScript",
    "JavaScript",
    "React",
    "Node",
    "API Testing",
    "Regression Testing",
    "Smoke Testing",
    "Functional Testing"
  ];

  const lowerText = text.toLowerCase();
  const skills = [];

  for (const skill of skillKeywords) {
    if (lowerText.includes(skill.toLowerCase())) {
      skills.push(skill);
    }
  }

  return {
    candidate_name,
    first_name,
    last_name,
    email,
    mobile,
    experience,
    education,
    skills
  };
}

module.exports = {
  parseBasicCandidateInfo,
  splitCandidateFullName,
  sanitizeCandidateDisplayName,
  stripNameFieldLabel,
  looksLikeCandidateName
};
