/**
 * Verifies My Approvals client-side global search covers enterprise fields.
 * Search is frontend-only; backend returns all active assignments (no SQL filter).
 */
const path = require("path");

const frontendRoot = path.resolve(__dirname, "../../ats-frontend");
const {
  buildApprovalSearchHaystack,
  matchesApprovalSearch
} = require(path.join(frontendRoot, "src/utils/myApprovalsSearch.js"));

function formatDocumentType(row) {
  const key = String(row?.document_type || row?.workflow_type || "")
    .trim()
    .toUpperCase();
  const labels = {
    BUDGET: "Budget",
    REQUISITION: "Requisition",
    OFFER: "Offer"
  };
  return labels[key] || key || "";
}

const sampleOffer = {
  document_type: "OFFER",
  workflow_type: "OFFER",
  document_number: "OFF-2026-31090",
  document_title: "Sr Automation Engineer",
  requestor: "raghavendra.karanik@igsglobal.com",
  current_approval_step: "Approval Step 1 — OFF-2026-31090",
  stage_key: "approval_step_1",
  status: "Pending",
  priority: "Normal",
  candidateName: "NIKHIL PAGA",
  businessUnit: "acendion",
  department: "Project -Asce",
  submitted_date: "2026-08-07T08:00:31.000Z"
};

const sampleRequisition = {
  document_type: "REQUISITION",
  workflow_type: "REQUISITION",
  document_number: "REQ-2026-0042",
  requisition_code: "REQ-2026-0042",
  document_title: "Manager - QMO",
  requestor: "Requestor Admin",
  current_approval_step: "Approval Step 1 — REQ-2026-0042",
  submitted_date: "2026-07-28T10:15:00.000Z",
  status: "Pending",
  priority: "Normal"
};

const cases = [
  { row: sampleOffer, term: "nikhil", label: "Candidate Name" },
  { row: sampleOffer, term: "off-2026", label: "Offer Number / Document Number" },
  { row: sampleRequisition, term: "req-2026", label: "Requisition Number" },
  { row: sampleOffer, term: "automation", label: "Position / Designation" },
  { row: sampleOffer, term: "acendion", label: "Client Name" },
  { row: sampleOffer, term: "project -asce", label: "Project Name" },
  { row: sampleOffer, term: "raghavendra", label: "Requestor" },
  { row: sampleOffer, term: "2026", label: "Submitted Date (year partial)" },
  { row: sampleOffer, term: "approval step 1", label: "Workflow Step" },
  { row: sampleOffer, term: "31090", label: "Document Number partial" }
];

let failed = 0;

for (const testCase of cases) {
  const haystack = buildApprovalSearchHaystack(testCase.row, formatDocumentType);
  const matched = matchesApprovalSearch(
    testCase.row,
    testCase.term,
    formatDocumentType
  );

  if (!matched) {
    console.error(`FAIL: ${testCase.label} — term "${testCase.term}" not found`);
    console.error(`  haystack: ${haystack.slice(0, 120)}...`);
    failed += 1;
  } else {
    console.log(`PASS: ${testCase.label}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log("\nAll My Approvals search field checks passed.");
