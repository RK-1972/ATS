require("dotenv").config();

const { Pool } = require("pg");
const skillsMasterDataService = require("../services/skillsMasterDataService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

const mockReq = {
  user: {
    full_name: "Validation User",
    role_name: "Admin"
  }
};

async function cleanup(code) {
  await pool.query(
    "UPDATE md_records SET is_deleted = TRUE WHERE entity_type = 'skills' AND code = $1",
    [code]
  );
}

async function main() {
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'md_records' AND column_name = 'skill_category_code'`
  );
  console.log("Column skill_category_code exists:", cols.rowCount > 0);

  const categories = await pool.query(
    `SELECT code, name FROM md_records
     WHERE entity_type = 'skill_categories' AND is_deleted = FALSE`
  );
  console.log("Skill categories in DB:", categories.rows.length);

  const skills = await pool.query(
    `SELECT code, skill_category_code FROM md_records
     WHERE entity_type = 'skills' AND is_deleted = FALSE LIMIT 5`
  );
  console.log("Skills sample:", skills.rows);

  if (!categories.rows.length) {
    console.log("SKIP: live mutation tests — no skill categories in DB");
    await pool.end();
    return;
  }

  const categoryCode = categories.rows[0].code;
  console.log("Using category code for tests:", categoryCode);

  const testCode = `SK-TEST-${Date.now()}`;

  console.log("=== Skills category validation scenarios ===");

  try {
    await skillsMasterDataService.createSkill(pool, {
      code: testCode,
      name: `Test Skill ${Date.now()}`,
      description: "Validation skill",
      skillCategoryCode: "INVALID-CAT"
    }, mockReq);
    console.log("FAIL: create with invalid category should throw");
  } catch (error) {
    console.log("PASS: invalid category rejected -", error.message);
  }

  try {
    await skillsMasterDataService.createSkill(pool, {
      code: testCode,
      name: `Test Skill ${Date.now()}`,
      description: "Validation skill"
    }, mockReq);
    console.log("FAIL: create without category should throw");
  } catch (error) {
    console.log("PASS: missing category rejected -", error.message);
  }

  const created = await skillsMasterDataService.createSkill(pool, {
    code: testCode,
    name: `Test Skill ${Date.now()}`,
    description: "Validation skill",
    skillCategoryCode: categoryCode
  }, mockReq);

  console.log("PASS: create skill with category -", created.skillCategory);

  const secondCategory = categories.rows[1]?.code || categoryCode;

  const preview = await skillsMasterDataService.previewSkillsImport(pool, [
    { code: testCode, skillCategory: categoryCode, name: "Duplicate Name", description: "dup code" },
    { code: "SK-NEW-1", skillCategory: secondCategory, name: created.name, description: "dup name" },
    { code: "SK-NEW-2", skillCategory: "BAD", name: "Bad Category Skill", description: "bad cat" },
    { code: "", skillCategory: categoryCode, name: "Missing Code", description: "missing code" },
    { code: "SK-NEW-3", skillCategory: "", name: "Missing Category", description: "missing cat" },
    { code: "SK-NEW-4", skillCategory: categoryCode, name: "", description: "missing name" },
    { code: "SK-NEW-5", skillCategory: categoryCode, name: "Valid Import Skill", description: "ok" },
    { code: "SK-NEW-5", skillCategory: categoryCode, name: "Valid Import Skill 2", description: "dup row" }
  ]);

  preview.forEach((row) => {
    console.log(`Preview row ${row.row}: ${row.status}`);
  });

  const list = await skillsMasterDataService.listSkills(pool);
  const found = list.find((item) => item.code === testCode);
  console.log("PASS: list skills returns category -", found?.skillCategory);

  const exported = await skillsMasterDataService.exportSkills(pool);
  console.log("PASS: export skills count -", exported.length);

  await cleanup(testCode);
  await cleanup("SK-NEW-5");

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
