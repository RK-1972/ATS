require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const DOWN_SQL = `
BEGIN;

DROP TABLE IF EXISTS can_activity CASCADE;
DROP TABLE IF EXISTS can_notes CASCADE;
DROP TABLE IF EXISTS can_preference CASCADE;
DROP TABLE IF EXISTS can_social_profile CASCADE;
DROP TABLE IF EXISTS can_document CASCADE;
DROP TABLE IF EXISTS can_language CASCADE;
DROP TABLE IF EXISTS can_certification CASCADE;
DROP TABLE IF EXISTS can_skill_map CASCADE;
DROP TABLE IF EXISTS can_experience CASCADE;
DROP TABLE IF EXISTS can_education CASCADE;
DROP TABLE IF EXISTS can_address CASCADE;

DROP INDEX IF EXISTS idx_cand_mstr_active;
DROP INDEX IF EXISTS idx_cand_mstr_source_code;
DROP INDEX IF EXISTS idx_cand_mstr_skill_primary;

ALTER TABLE cand_mstr DROP COLUMN IF EXISTS salutation;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS middle_name;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS preferred_name;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS gender;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS date_of_birth;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS nationality;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS marital_status;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS alternate_email;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS alternate_mobile;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS current_designation;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS current_department;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS current_country;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS current_state;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS current_city;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS total_experience_years;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS total_experience_months;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS relevant_experience_years;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS relevant_experience_months;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS currency_code;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS willing_to_relocate;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS preferred_work_mode;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS candidate_source_code;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS vendor_partner_code;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS referral_program_code;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS resume_document_id;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS resume_uploaded_on;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS profile_completion;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS modified_by;
ALTER TABLE cand_mstr DROP COLUMN IF EXISTS active_flag;

COMMIT;
`;

async function main() {
  await pool.query(DOWN_SQL);
  console.log("✅ Rolled back 011_candidate_enterprise_schema");
  await pool.end();
}

main().catch((error) => {
  console.error("Rollback failed:", error.message);
  process.exit(1);
});
