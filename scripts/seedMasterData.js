require("dotenv").config();

const { Pool } = require("pg");

const {
  ENTITY_TYPE_KEYS,
  DEFAULT_USED_BY
} = require("../masterData/entityTypes");

const SEED_TEMPLATES = {
  business_units: [
    ["BU-ENG", "Engineering BU", "Primary engineering delivery unit"],
    ["BU-DEL", "Delivery Excellence", "Global delivery operations"],
    ["BU-SAL", "Sales & Marketing", "Revenue and client acquisition"]
  ],
  departments: [
    ["DEPT-ENG", "Engineering", "Software product engineering"],
    ["DEPT-QA", "Quality Assurance", "Quality engineering and testing"],
    ["DEPT-HR", "Human Resources", "People operations and TA"],
    ["DEPT-FIN", "Finance", "Financial planning and control"],
    ["DEPT-SAL", "Sales", "Enterprise sales division"]
  ],
  cost_centers: [
    ["CC-1001", "Eng Bangalore", "Engineering cost center — Bangalore"],
    ["CC-1002", "Eng Hyderabad", "Engineering cost center — Hyderabad"],
    ["CC-2001", "Delivery Ops", "Delivery operations overhead"]
  ],
  legal_entities: [
    ["LE-IN", "IGS India Pvt Ltd", "India legal entity"],
    ["LE-US", "IGS Americas Inc", "US legal entity"]
  ],
  delivery_units: [
    ["DU-NA", "North America Delivery", "Client delivery — NA region"],
    ["DU-APAC", "APAC Delivery", "Client delivery — APAC region"]
  ],
  practice_areas: [
    ["PA-CLOUD", "Cloud & Platform", "Cloud native practice"],
    ["PA-DATA", "Data & AI", "Analytics and AI practice"]
  ],
  grades: [
    ["G6", "Grade G6", "Individual contributor — entry", DEFAULT_USED_BY.grades],
    ["G7", "Grade G7", "Individual contributor — mid", DEFAULT_USED_BY.grades],
    ["G8", "Grade G8", "Senior individual contributor", DEFAULT_USED_BY.grades],
    ["G9", "Grade G9", "Lead / specialist", DEFAULT_USED_BY.grades],
    ["G10", "Grade G10", "Manager / senior lead", DEFAULT_USED_BY.grades],
    ["G11", "Grade G11", "Senior manager", DEFAULT_USED_BY.grades],
    ["G12", "Grade G12", "Director level", DEFAULT_USED_BY.grades]
  ],
  job_levels: [
    ["JL-1", "Level 1", "Entry level"],
    ["JL-2", "Level 2", "Intermediate"],
    ["JL-3", "Level 3", "Advanced"],
    ["JL-4", "Level 4", "Expert"]
  ],
  designations: [
    ["DES-SE", "Software Engineer", "Standard engineering designation"],
    ["DES-SSE", "Senior Software Engineer", "Senior engineering designation"],
    ["DES-PM", "Project Manager", "Delivery project manager"]
  ],
  employment_types: [
    ["ET-FT", "Full-time", "Permanent full-time employment", DEFAULT_USED_BY.employment_types],
    ["ET-CT", "Contract", "Fixed-term contract", DEFAULT_USED_BY.employment_types],
    ["ET-IN", "Intern", "Internship engagement", DEFAULT_USED_BY.employment_types]
  ],
  position_types: [
    ["PT-NEW", "New Hire", "Net-new headcount position"],
    ["PT-REP", "Replacement", "Backfill for attrition"]
  ],
  workforce_categories: [
    ["WC-BILL", "Billable", "Client billable workforce"],
    ["WC-NBILL", "Non-Billable", "Internal / overhead workforce"]
  ],
  skills: [
    ["SK-JAVA", "Java", "Core Java development", DEFAULT_USED_BY.skills],
    ["SK-REACT", "React", "Frontend React framework", DEFAULT_USED_BY.skills],
    ["SK-AWS", "AWS", "Amazon Web Services cloud", DEFAULT_USED_BY.skills]
  ],
  skill_categories: [
    ["SC-TECH", "Technical", "Technical skill grouping"],
    ["SC-SOFT", "Soft Skills", "Behavioral competencies"]
  ],
  interview_types: [
    ["IT-L1", "L1 Technical", "First-level technical interview"],
    ["IT-L2", "L2 Technical", "Second-level technical interview"],
    ["IT-HM", "Hiring Manager", "HM culture and fit round"]
  ],
  interview_modes: [
    ["IM-FTF", "Face to Face", "In-person interview"],
    ["IM-VID", "Video", "Remote video interview"],
    ["IM-TEL", "Telephonic", "Phone screening"]
  ],
  candidate_sources: [
    ["CS-PORT", "Job Portal", "External job board sourcing"],
    ["CS-REF", "Employee Referral", "Internal referral program"],
    ["CS-VEND", "Vendor", "Staffing vendor submission"]
  ],
  vendor_partners: [
    ["VP-ACME", "Acme Staffing", "Preferred staffing vendor"],
    ["VP-GLOB", "Global Talent Co", "Secondary vendor partner"]
  ],
  referral_programs: [
    ["RP-STD", "Standard Referral", "Default employee referral program"]
  ],
  countries: [
    ["IN", "India", "Republic of India"],
    ["US", "United States", "United States of America"]
  ],
  states: [
    ["IN-KA", "Karnataka", "Karnataka, India"],
    ["IN-MH", "Maharashtra", "Maharashtra, India"],
    ["US-CA", "California", "California, USA"]
  ],
  cities: [
    ["BLR", "Bangalore", "Bengaluru, Karnataka"],
    ["HYD", "Hyderabad", "Hyderabad, Telangana"],
    ["MUM", "Mumbai", "Mumbai, Maharashtra"],
    ["PUN", "Pune", "Pune, Maharashtra"],
    ["DEL", "Delhi", "New Delhi, NCR"],
    ["CHE", "Chennai", "Chennai, Tamil Nadu"]
  ],
  work_locations: [
    ["WL-BLR-HQ", "Bangalore HQ", "Head office — Bangalore", DEFAULT_USED_BY.work_locations],
    ["WL-HYD-DC", "Hyderabad DC", "Delivery center — Hyderabad", DEFAULT_USED_BY.work_locations],
    ["WL-MUM-RO", "Mumbai RO", "Regional office — Mumbai", DEFAULT_USED_BY.work_locations]
  ],
  regions: [
    ["REG-APAC", "APAC", "Asia Pacific region"],
    ["REG-NA", "North America", "North America region"]
  ],
  time_zones: [
    ["TZ-IST", "IST", "India Standard Time (UTC+5:30)"],
    ["TZ-EST", "EST", "US Eastern Standard Time"]
  ],
  currencies: [
    ["INR", "Indian Rupee", "INR — primary operating currency", DEFAULT_USED_BY.currencies],
    ["USD", "US Dollar", "USD — international billing"]
  ],
  salary_bands: [
    ["SB-G8", "G8 Band", "Salary band for Grade G8"],
    ["SB-G10", "G10 Band", "Salary band for Grade G10"]
  ],
  budget_categories: [
    ["BC-HC", "Headcount", "Approved headcount budget"],
    ["BC-PROJ", "Project", "Project-specific budget pool"]
  ],
  cost_types: [
    ["CT-DIRECT", "Direct Cost", "Direct employee cost"],
    ["CT-OVERHEAD", "Overhead", "Indirect overhead allocation"]
  ],
  document_types: [
    ["DT-RES", "Resume", "Candidate resume document"],
    ["DT-OFR", "Offer Letter", "Employment offer letter"]
  ],
  notification_templates: [
    ["NT-REQ", "Requisition Submitted", "Requisition workflow notification"],
    ["NT-OFR", "Offer Approval", "Offer approval request template"]
  ],
  email_templates: [
    ["EM-WEL", "Welcome Email", "New hire welcome communication"],
    ["EM-INT", "Interview Invite", "Interview scheduling email"]
  ],
  offer_templates: [
    ["OT-STD", "Standard Offer", "Default offer letter template"],
    ["OT-EXEC", "Executive Offer", "Leadership offer template"]
  ],
  calendar_types: [
    ["CAL-BIZ", "Business Calendar", "Standard business working days"],
    ["CAL-CLI", "Client Calendar", "Client-specific calendar"]
  ],
  holiday_calendars: [
    ["HC-IN-2026", "India Holidays 2026", "India public holiday calendar"],
    ["HC-US-2026", "US Holidays 2026", "US federal holiday calendar"]
  ]
};

function buildRecordId(entityType, code) {
  return `md-${entityType}-${code.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function seed() {
  let inserted = 0;

  for (const entityType of ENTITY_TYPE_KEYS) {
    const items = SEED_TEMPLATES[entityType] || [];

    for (const [code, name, description, usedBy] of items) {
      const id = buildRecordId(entityType, code);
      const usedByJson = JSON.stringify(usedBy || ["Platform Configuration"]);

      const exists = await pool.query(
        "SELECT id FROM md_records WHERE id = $1",
        [id]
      );

      if (exists.rows.length) {
        continue;
      }

      await pool.query(
        `INSERT INTO md_records (
          id, entity_type, code, name, description, status, version, version_status,
          used_by, created_by, modified_by
        ) VALUES ($1,$2,$3,$4,$5,'Active',1.0,'Published',$6,'System Admin','System Admin')`,
        [id, entityType, code, name, description, usedByJson]
      );

      await pool.query(
        `INSERT INTO md_record_history
          (record_id, entity_type, version, status, changed_by, reason)
         VALUES ($1,$2,1.0,'Published','System Admin','Initial publish')`,
        [id, entityType]
      );

      inserted += 1;
    }
  }

  console.log(`✅ Seeded ${inserted} master data records`);
}

seed()
  .catch((error) => {
    console.error("Seed failed:", error.message);
    process.exit(1);
  })
  .finally(() => pool.end());
