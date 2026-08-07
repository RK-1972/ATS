const fs = require("fs");
const path = require("path");

const PizZip = require("pizzip");

const {
  ANNEXURE_LABEL_ROWS,
  resolveAnnexureRowByLabel
} = require("./offerAnnexureMergeMapping");

const TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "assets",
  "templates",
  "offer-letter-v1.docx"
);

const DOCX_PART_PATTERN =
  /^word\/(document\.xml|header\d+\.xml|footer\d+\.xml)$/i;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatIndianAmount(amount) {
  return Number(amount || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatOfferDate(value) {
  if (!value) {
    return "";
  }

  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function formatOfferCtc(amount) {
  return Number(amount || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

function buildMergeData({ offerRow, organizationRow }) {
  const organizationName =
    organizationRow?.organization_name ||
    organizationRow?.company_name ||
    "IGS Engineering Quality";

  return {
    ORGANIZATION: {
      NAME: organizationName
    },
    Candidate: {
      Name: offerRow?.candidate_name || ""
    },
    Offer: {
      Designation: offerRow?.position_title || "",
      JoiningDate: formatOfferDate(offerRow?.valid_until),
      AnnualCTC: formatOfferCtc(offerRow?.offered_ctc)
    }
  };
}

function flattenMergeData(value, prefix = "") {
  if (value === null || value === undefined) {
    return prefix ? { [prefix]: "" } : {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return prefix ? { [prefix]: value } : {};
  }

  return Object.entries(value).reduce((accumulator, [key, nestedValue]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const flattened =
      typeof nestedValue === "object" &&
      nestedValue !== null &&
      !Array.isArray(nestedValue)
        ? flattenMergeData(nestedValue, path)
        : { [path]: nestedValue ?? "" };

    return {
      ...accumulator,
      ...flattened
    };
  }, {});
}

function buildScalarReplacements(context) {
  const mergeData = buildMergeData(context);
  const flattened = flattenMergeData(mergeData);

  return Object.fromEntries(
    Object.entries(flattened).map(([placeholderName, value]) => [
      `{{${placeholderName}}}`,
      String(value ?? "")
    ])
  );
}

function getCellText(cellXml) {
  return [...cellXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => match[1])
    .join("")
    .trim();
}

function repairSplitPlaceholders(xml) {
  const runBody = "(?:(?!<w:r\\b)[\\s\\S])*?";
  const splitTagPattern = new RegExp(
    `<w:r\\b[^>]*>${runBody}<w:t(?:\\s[^>]*)?>\\{\\{<\\/w:t><\\/w:r>\\s*(?:<w:proofErr[^>]*\\/>?\\s*)*<w:r\\b[^>]*>${runBody}<w:t(?:\\s[^>]*)?>([A-Za-z0-9_.]+)<\\/w:t><\\/w:r>\\s*(?:<w:proofErr[^>]*\\/>?\\s*)*<w:r\\b[^>]*>${runBody}<w:t(?:\\s[^>]*)?>\\}\\}<\\/w:t><\\/w:r>`,
    "g"
  );

  return xml.replace(splitTagPattern, (fullMatch, tagName) => {
    const rPrMatch = fullMatch.match(/<w:rPr[\s\S]*?<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[0] : "";

    return `<w:r>${rPr}<w:t xml:space="preserve">{{${tagName}}}</w:t></w:r>`;
  });
}

function generateDocxBuffer(zip) {
  return zip.generate({
    type: "nodebuffer",
    compression: "DEFLATE"
  });
}

function applyScalarReplacements(xml, context) {
  const replacements = buildScalarReplacements(context);
  let updated = repairSplitPlaceholders(xml);

  Object.entries(replacements).forEach(([placeholder, value]) => {
    updated = updated.split(placeholder).join(escapeXml(value));
  });

  return updated;
}

function mergeScalarPlaceholders(templateBuffer, context) {
  const zip = new PizZip(templateBuffer);

  Object.keys(zip.files).forEach((partName) => {
    if (!DOCX_PART_PATTERN.test(partName)) {
      return;
    }

    zip.file(
      partName,
      applyScalarReplacements(zip.files[partName].asText(), context)
    );
  });

  return generateDocxBuffer(zip);
}

function setCellText(cellXml, text) {
  if (!/<w:t(?:\s|>)/.test(cellXml)) {
    return cellXml;
  }

  let isFirstTextNode = true;
  const formatted = escapeXml(text);

  return cellXml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, (match) => {
    if (isFirstTextNode) {
      isFirstTextNode = false;
      return match.replace(
        /(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/,
        `$1${formatted}$2`
      );
    }

    return match.replace(/(<w:t(?:\s[^>]*)?>)[\s\S]*?(<\/w:t>)/, "$1$2");
  });
}

function setCellAmount(cellXml, amount) {
  return setCellText(cellXml, formatIndianAmount(amount));
}

function updateAnnexureTable(xml, salaryBreakup) {
  return xml.replace(/<w:tr[\s\S]*?<\/w:tr>/g, (rowXml) => {
    const cells = [...rowXml.matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)].map((match) => ({
      xml: match[0],
      text: getCellText(match[0])
    }));

    const mapping = resolveAnnexureRowByLabel(cells[0]?.text || "", cells);

    if (!mapping) {
      return rowXml;
    }

    const updatedMonthlyCell = setCellAmount(cells[1].xml, mapping.monthly(salaryBreakup));
    const updatedAnnualCell = setCellAmount(cells[2].xml, mapping.annual(salaryBreakup));

    let cellIndex = 0;

    return rowXml.replace(/<w:tc[\s\S]*?<\/w:tc>/g, () => {
      cellIndex += 1;

      if (cellIndex === 2) {
        return updatedMonthlyCell;
      }

      if (cellIndex === 3) {
        return updatedAnnualCell;
      }

      return cells[cellIndex - 1].xml;
    });
  });
}

function injectAnnexureAmounts(docxBuffer, salaryBreakup) {
  const zip = new PizZip(docxBuffer);

  Object.keys(zip.files).forEach((partName) => {
    if (!DOCX_PART_PATTERN.test(partName)) {
      return;
    }

    const file = zip.files[partName];
    const updated = updateAnnexureTable(file.asText(), salaryBreakup);
    zip.file(partName, updated);
  });

  return generateDocxBuffer(zip);
}

function loadTemplateBuffer(templatePath = TEMPLATE_PATH) {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Offer letter template not found at ${templatePath}`);
  }

  return fs.readFileSync(templatePath);
}

function mergeOfferLetterTemplate(context) {
  const templateBuffer = loadTemplateBuffer(context?.templatePath);
  const mergedScalars = mergeScalarPlaceholders(templateBuffer, context);

  return injectAnnexureAmounts(mergedScalars, context.salaryBreakup);
}

module.exports = {
  TEMPLATE_PATH,
  ANNEXURE_LABEL_ROWS,
  buildMergeData,
  buildScalarReplacements,
  flattenMergeData,
  mergeOfferLetterTemplate,
  mergeScalarPlaceholders,
  formatIndianAmount,
  repairSplitPlaceholders,
  updateAnnexureTable,
  resolveAnnexureRowByLabel
};
