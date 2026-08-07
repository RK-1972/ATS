const JSZip = require("jszip");

const {
  recognizePlaceholdersInText,
  parsePlaceholderToken
} = require("./placeholderResolver");

const DOCX_PART_PATTERN =
  /^word\/(document\.xml|header\d+\.xml|footer\d+\.xml)$/i;

const UNKNOWN_TOKEN_PATTERN = /\{\{[^}]+\}\}/g;

const SECTION_LABELS = {
  "word/document.xml": "Body",
  "word/header1.xml": "Header",
  "word/header2.xml": "Header",
  "word/header3.xml": "Header",
  "word/footer1.xml": "Footer",
  "word/footer2.xml": "Footer",
  "word/footer3.xml": "Footer"
};

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractTextFromOoxml(xml) {
  const parts = [];
  const regex = /<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g;
  let match = regex.exec(xml);

  while (match) {
    parts.push(decodeXmlEntities(match[1]));
    match = regex.exec(xml);
  }

  return parts.join("");
}

function getSectionLabel(partName) {
  const normalized = String(partName || "").toLowerCase();

  if (SECTION_LABELS[normalized]) {
    return SECTION_LABELS[normalized];
  }

  if (/^word\/header/i.test(normalized)) {
    return "Header";
  }

  if (/^word\/footer/i.test(normalized)) {
    return "Footer";
  }

  return "Body";
}

async function readDocxSections(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const partNames = Object.keys(zip.files)
    .filter((name) => DOCX_PART_PATTERN.test(name))
    .sort();

  const sections = [];

  for (const partName of partNames) {
    const file = zip.file(partName);

    if (!file) {
      continue;
    }

    const xml = await file.async("string");
    const text = extractTextFromOoxml(xml);

    sections.push({
      partName,
      section: getSectionLabel(partName),
      text
    });
  }

  return sections;
}

function collectUnknownTokens(text, knownTokens) {
  const knownSet = new Set(knownTokens);
  const unknown = new Set();
  const pattern = new RegExp(UNKNOWN_TOKEN_PATTERN.source, "g");
  let match = pattern.exec(text);

  while (match) {
    const token = match[0];

    if (!knownSet.has(token)) {
      unknown.add(token);
    }

    match = pattern.exec(text);
  }

  return [...unknown];
}

function scanTextForPlaceholders(text, source) {
  const recognized = recognizePlaceholdersInText(text);
  const validTokens = recognized.map((item) => item.token);
  const unknownTokens = collectUnknownTokens(text, validTokens);

  return {
    source,
    recognized,
    unknownTokens
  };
}

function scanDocxSections(sections) {
  const recognized = [];
  const unknownTokens = new Set();
  const scannedSections = [];

  sections.forEach((section) => {
    const result = scanTextForPlaceholders(section.text, section.section);
    scannedSections.push({
      section: section.section,
      partName: section.partName,
      recognizedCount: result.recognized.length,
      unknownCount: result.unknownTokens.length
    });

    result.recognized.forEach((item) => {
      recognized.push({
        ...item,
        source: section.section
      });
    });

    result.unknownTokens.forEach((token) => unknownTokens.add(token));
  });

  const tokenMap = new Map();

  recognized.forEach((item) => {
    if (!tokenMap.has(item.token)) {
      tokenMap.set(item.token, {
        token: item.token,
        type: item.type,
        namespace: item.namespace || "TABLE",
        key: item.key || item.collection,
        occurrences: 0,
        sections: new Set()
      });
    }

    const entry = tokenMap.get(item.token);
    entry.occurrences += 1;
    entry.sections.add(item.source || "Body");
  });

  return {
    scannedSections,
    recognized: [...tokenMap.values()].map((item) => ({
      ...item,
      sections: [...item.sections]
    })),
    unknownTokens: [...unknownTokens]
  };
}

async function scanDocxBuffer(buffer) {
  const sections = await readDocxSections(buffer);
  return scanDocxSections(sections);
}

function buildPlaceholderRecord(templateId, token, validation) {
  const parsed = parsePlaceholderToken(token);

  return {
    template_placeholder_id: `TP-${templateId}-${Buffer.from(token).toString("base64url").slice(0, 24)}`,
    placeholder_token: token,
    namespace:
      validation.placeholderType === "table"
        ? "TABLE"
        : validation.namespace || parsed?.namespace || null,
    placeholder_key:
      validation.placeholderType === "table"
        ? validation.placeholderKey || parsed?.collection || null
        : validation.placeholderKey || parsed?.key || null,
    placeholder_type: validation.placeholderType,
    is_valid: Boolean(validation.isValid)
  };
}

module.exports = {
  readDocxSections,
  scanDocxSections,
  scanDocxBuffer,
  scanTextForPlaceholders,
  buildPlaceholderRecord
};
