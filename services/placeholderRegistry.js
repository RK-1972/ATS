/**
 * Enterprise Placeholder Registry — Sprint 12.3.2
 * Namespace-based placeholders only. No flat names.
 */

const SCALAR_DEFINITIONS = [
  {
    namespace: "Candidate",
    key: "Name",
    label: "Candidate Name",
    description: "Full name of the candidate or employee"
  },
  {
    namespace: "Candidate",
    key: "Email",
    label: "Candidate Email",
    description: "Primary email address of the candidate"
  },
  {
    namespace: "Offer",
    key: "Number",
    label: "Offer Number",
    description: "Unique offer reference number"
  },
  {
    namespace: "Offer",
    key: "Designation",
    label: "Offer Designation",
    description: "Position or designation offered"
  },
  {
    namespace: "Offer",
    key: "JoiningDate",
    label: "Joining Date",
    description: "Expected date of joining"
  },
  {
    namespace: "Offer",
    key: "AnnualCTC",
    label: "Annual CTC",
    description: "Approved annual cost to company"
  },
  {
    namespace: "Company",
    key: "Name",
    label: "Company Name",
    description: "Legal or brand name of the company"
  },
  {
    namespace: "Company",
    key: "Address",
    label: "Company Address",
    description: "Registered or primary company address"
  },
  {
    namespace: "Organization",
    key: "Name",
    label: "Organization Name",
    description: "Legal or brand name of the organization"
  },
  {
    namespace: "Organization",
    key: "Address",
    label: "Organization Address",
    description: "Registered or primary organization address"
  },
  {
    namespace: "Recruiter",
    key: "Name",
    label: "Recruiter Name",
    description: "Assigned recruiter for the offer"
  },
  {
    namespace: "ReportingManager",
    key: "Name",
    label: "Reporting Manager Name",
    description: "Reporting manager for the offered role"
  },
  {
    namespace: "Compensation",
    key: "TotalCTC",
    label: "Total CTC",
    description: "Total cost to company from compensation structure"
  }
];

const TABLE_DEFINITIONS = [
  {
    collection: "Compensation",
    label: "Compensation Breakup",
    description: "Tabular compensation component rows",
    status: "Active"
  },
  {
    collection: "Education",
    label: "Education History",
    description: "Tabular education records",
    status: "Future"
  },
  {
    collection: "Experience",
    label: "Work Experience",
    description: "Tabular employment history",
    status: "Future"
  },
  {
    collection: "Documents",
    label: "Supporting Documents",
    description: "Tabular document checklist or attachments",
    status: "Future"
  }
];

function buildScalarToken(namespace, key) {
  return `{{${namespace}.${key}}}`;
}

function buildTableToken(collection) {
  return `{{TABLE:${collection}}}`;
}

function getScalarPlaceholders() {
  return SCALAR_DEFINITIONS.map((item) => ({
    type: "scalar",
    namespace: item.namespace,
    key: item.key,
    label: item.label,
    description: item.description,
    token: buildScalarToken(item.namespace, item.key)
  }));
}

function getTablePlaceholders() {
  return TABLE_DEFINITIONS.map((item) => ({
    type: "table",
    collection: item.collection,
    label: item.label,
    description: item.description,
    status: item.status,
    token: buildTableToken(item.collection)
  }));
}

function getAllDefinitions() {
  return {
    scalars: getScalarPlaceholders(),
    tables: getTablePlaceholders()
  };
}

function getGroupedByNamespace() {
  const groups = {};

  getScalarPlaceholders().forEach((placeholder) => {
    if (!groups[placeholder.namespace]) {
      groups[placeholder.namespace] = [];
    }

    groups[placeholder.namespace].push(placeholder);
  });

  return Object.entries(groups)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([namespace, placeholders]) => ({
      namespace,
      placeholders: placeholders.sort((left, right) =>
        left.key.localeCompare(right.key)
      )
    }));
}

function getTableGroup() {
  return {
    namespace: "TABLE",
    placeholders: getTablePlaceholders()
  };
}

function normalizePlaceholderPart(value) {
  return String(value || "").trim().toLowerCase();
}

function findScalarPlaceholder(namespace, key) {
  const normalizedNamespace = normalizePlaceholderPart(namespace);
  const normalizedKey = normalizePlaceholderPart(key);

  return getScalarPlaceholders().find(
    (item) =>
      normalizePlaceholderPart(item.namespace) === normalizedNamespace &&
      normalizePlaceholderPart(item.key) === normalizedKey
  );
}

function findTablePlaceholder(collection) {
  const normalizedCollection = normalizePlaceholderPart(collection);

  return getTablePlaceholders().find(
    (item) => normalizePlaceholderPart(item.collection) === normalizedCollection
  );
}

module.exports = {
  SCALAR_DEFINITIONS,
  TABLE_DEFINITIONS,
  buildScalarToken,
  buildTableToken,
  getScalarPlaceholders,
  getTablePlaceholders,
  getAllDefinitions,
  getGroupedByNamespace,
  getTableGroup,
  findScalarPlaceholder,
  findTablePlaceholder
};
