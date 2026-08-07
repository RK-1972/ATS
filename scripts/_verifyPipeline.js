const fs = require("fs");
const PizZip = require("pizzip");
const offerTemplateMergeService = require("../services/offerTemplateMergeService");
const salaryCalculationService = require("../services/salaryCalculationService");

function countRuns(buffer) {
  const xml = new PizZip(buffer).files["word/document.xml"].asText();
  return {
    open: (xml.match(/<w:r\b/g) || []).length,
    close: (xml.match(/<\/w:r>/g) || []).length
  };
}

const templatePath =
  "c:/Users/Raghavendra_Karanik/OneDrive - Intact Green Services (India) PVT LTD/Desktop/Offer Letter .docx";
const breakup = salaryCalculationService.calculateSalaryBreakup(2500000);
const context = {
  templatePath,
  offerRow: {
    candidate_name: "Test Candidate",
    position_title: "Senior Engineer",
    offered_ctc: 2500000,
    valid_until: "2026-07-01"
  },
  organizationRow: { organization_name: "IGS Engineering Quality" },
  salaryBreakup: breakup
};

const templateBuffer = fs.readFileSync(templatePath);
console.log("Template runs:", countRuns(templateBuffer));

const mergedScalars = offerTemplateMergeService.mergeScalarPlaceholders(
  templateBuffer,
  context
);
console.log("After scalars:", countRuns(mergedScalars));

fs.writeFileSync("scripts/_verify-scalars.docx", mergedScalars);
console.log("Scalars file size:", mergedScalars.length);

const merged = offerTemplateMergeService.mergeOfferLetterTemplate(context);
console.log("After full merge:", countRuns(merged));

fs.writeFileSync("scripts/_verify-merged.docx", merged);
console.log("Wrote scripts/_verify-merged.docx", merged.length, "bytes");
