const MASTER_DATA_DOMAINS = [
  {
    key: "organization",
    label: "Organization",
    entityTypes: [
      { key: "business_units", label: "Business Units" },
      { key: "departments", label: "Departments" },
      { key: "cost_centers", label: "Cost Centers" },
      { key: "legal_entities", label: "Legal Entities" },
      { key: "delivery_units", label: "Delivery Units" },
      { key: "practice_areas", label: "Practice Areas" }
    ]
  },
  {
    key: "workforce",
    label: "Workforce",
    entityTypes: [
      { key: "grades", label: "Grades" },
      { key: "job_levels", label: "Job Levels" },
      { key: "designations", label: "Designations" },
      { key: "employment_types", label: "Employment Types" },
      { key: "position_types", label: "Position Types" },
      { key: "workforce_categories", label: "Workforce Categories" }
    ]
  },
  {
    key: "recruitment",
    label: "Recruitment",
    entityTypes: [
      { key: "skills", label: "Skills" },
      { key: "skill_categories", label: "Skill Categories" },
      { key: "interview_types", label: "Interview Types" },
      { key: "interview_modes", label: "Interview Modes" },
      { key: "candidate_sources", label: "Candidate Sources" },
      { key: "vendor_partners", label: "Vendor Partners" },
      { key: "referral_programs", label: "Referral Programs" }
    ]
  },
  {
    key: "geography",
    label: "Geography",
    entityTypes: [
      { key: "countries", label: "Countries" },
      { key: "states", label: "States" },
      { key: "cities", label: "Cities" },
      { key: "work_locations", label: "Work Locations" },
      { key: "regions", label: "Regions" },
      { key: "time_zones", label: "Time Zones" }
    ]
  },
  {
    key: "financial",
    label: "Financial",
    entityTypes: [
      { key: "currencies", label: "Currency" },
      { key: "salary_bands", label: "Salary Bands" },
      { key: "budget_categories", label: "Budget Categories" },
      { key: "cost_types", label: "Cost Types" }
    ]
  },
  {
    key: "system",
    label: "System",
    entityTypes: [
      { key: "document_types", label: "Document Types" },
      { key: "notification_templates", label: "Notification Templates" },
      { key: "email_templates", label: "Email Templates" },
      { key: "offer_templates", label: "Offer Templates" },
      { key: "calendar_types", label: "Calendar Types" },
      { key: "holiday_calendars", label: "Holiday Calendars" }
    ]
  }
];

const DEFAULT_USED_BY = {
  grades: [
    "Business Rules",
    "Workflow",
    "Approval Matrix",
    "Requisitions",
    "Budget",
    "Offer",
    "Reports",
    "AI"
  ],
  departments: [
    "Workforce Planning",
    "Requisitions",
    "Business Rules",
    "Approval Matrix",
    "Reports"
  ],
  work_locations: [
    "Requisitions",
    "Business Rules",
    "Interview Management",
    "Offer"
  ],
  employment_types: [
    "Requisitions",
    "Business Rules",
    "Workforce Planning"
  ],
  currencies: [
    "Platform Configuration",
    "Workforce Planning",
    "Budget",
    "Offer"
  ],
  skills: ["Recruitment", "AI", "Reports"]
};

const ENTITY_TYPE_KEYS = MASTER_DATA_DOMAINS.flatMap(
  (domain) => domain.entityTypes.map((item) => item.key)
);

function kebabToSnake(value) {
  return value.replace(/-/g, "_");
}

function snakeToKebab(value) {
  return value.replace(/_/g, "-");
}

function isValidEntityType(entityType) {
  return ENTITY_TYPE_KEYS.includes(entityType);
}

function tableNameForEntity(entityType) {
  return `md_${entityType}`;
}

module.exports = {
  MASTER_DATA_DOMAINS,
  DEFAULT_USED_BY,
  ENTITY_TYPE_KEYS,
  kebabToSnake,
  snakeToKebab,
  isValidEntityType,
  tableNameForEntity
};
