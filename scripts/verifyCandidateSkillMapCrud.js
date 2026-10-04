/**

 * Verifies can_skill_map batch insert, update, delete, and additive primary_skill sync.

 * Usage: node scripts/verifyCandidateSkillMapCrud.js

 */



require("dotenv").config();

const { Pool } = require("pg");



const candidateService = require("../services/candidateService");

const { collectCandidateSkillCodes } = require("../services/resumeMatchService");



const pool = new Pool({

  host: process.env.DB_HOST,

  user: process.env.DB_USER,

  password: process.env.DB_PASSWORD,

  database: process.env.DB_NAME,

  port: process.env.DB_PORT || 5432

});



function pass(message) {

  console.log(`PASS: ${message}`);

}



function fail(message, detail = "") {

  console.error(`FAIL: ${message}${detail ? ` — ${detail}` : ""}`);

  process.exitCode = 1;

}



function normalizeToken(value) {

  return String(value || "").trim().toLowerCase();

}



function splitTokens(value) {

  if (!value) {

    return [];

  }



  return String(value)

    .split(/[,;/|]+/)

    .map((token) => token.trim())

    .filter(Boolean);

}



function tokensIncludeAll(primarySkill, expectedNames) {

  const haystack = splitTokens(primarySkill).map(normalizeToken);



  return expectedNames.every((name) =>

    haystack.includes(normalizeToken(name))

  );

}



function tokensExclude(primarySkill, excludedNames) {

  const haystack = splitTokens(primarySkill).map(normalizeToken);



  return excludedNames.every(

    (name) => !haystack.includes(normalizeToken(name))

  );

}



async function resolveSkillsByNames(names) {

  const result = await pool.query(

    `SELECT code, name

     FROM md_records

     WHERE entity_type = 'skills'

       AND is_deleted = FALSE

       AND status = 'Active'

       AND LOWER(name) = ANY($1::text[])`,

    [names.map((name) => name.toLowerCase())]

  );



  const byName = new Map(

    result.rows.map((row) => [normalizeToken(row.name), row])

  );



  const rows = names.map((name) => byName.get(normalizeToken(name)));



  if (rows.some((row) => !row)) {

    const missing = names.filter((name, index) => !rows[index]);

    const fallback = await pool.query(

      `SELECT code, name

       FROM md_records

       WHERE entity_type = 'skills'

         AND is_deleted = FALSE

         AND status = 'Active'

       ORDER BY code ASC

       LIMIT 5`

    );



    if (fallback.rows.length < 5) {

      throw new Error(`Missing EMD skills for: ${missing.join(", ")}`);

    }



    return fallback.rows;

  }



  return rows;

}



async function resolveCandidateId() {

  const result = await pool.query(

    `SELECT candidate_id FROM cand_mstr ORDER BY candidate_id DESC LIMIT 1`

  );



  if (!result.rows.length) {

    throw new Error("No candidate row available.");

  }



  return result.rows[0].candidate_id;

}



async function cleanupSkillMap(candidateId, codes) {

  await pool.query(

    `DELETE FROM can_skill_map WHERE candidate_id = $1 AND skill_code = ANY($2::text[])`,

    [candidateId, codes]

  );

}



async function setCandidateSkills(candidateId, primarySkill, secondarySkill = null) {

  await pool.query(

    `UPDATE cand_mstr

     SET primary_skill = $1,

         secondary_skill = $2,

         updated_on = NOW()

     WHERE candidate_id = $3`,

    [primarySkill, secondarySkill, candidateId]

  );

}



async function readMaster(candidateId) {

  return candidateService.getCandidateMaster(pool, candidateId);

}



async function buildSkillResolver() {

  const result = await pool.query(

    `SELECT code, name

     FROM md_records

     WHERE entity_type = 'skills'

       AND is_deleted = FALSE

       AND status = 'Active'`

  );



  const byCode = new Map();

  const byName = new Map();



  result.rows.forEach((row) => {

    byCode.set(normalizeToken(row.code), row);

    byName.set(normalizeToken(row.name), row);

  });



  return {

    resolveToken(token) {

      const key = normalizeToken(token);

      const record = byCode.get(key) || byName.get(key);



      if (!record) {

        return null;

      }



      return { code: record.code, name: record.name };

    }

  };

}



async function main() {

  const candidateId = await resolveCandidateId();

  const skills = await resolveSkillsByNames([

    "Java",

    "React",

    "SQL",

    "Python",

    "AWS"

  ]);



  const java = skills[0];

  const react = skills[1];

  const sql = skills[2];

  const python = skills[3];

  const aws = skills[4];

  const baselineNames = [java.name, react.name, sql.name];

  const manualNames = [python.name, aws.name];

  const touchedCodes = skills.map((row) => row.code);



  await cleanupSkillMap(candidateId, touchedCodes);

  await setCandidateSkills(candidateId, baselineNames.join(", "), null);



  const batch = await candidateService.insertSkillMapBatch(pool, candidateId, [

    {

      skill_code: python.code,

      experience_years: 2,

      experience_months: 0,

      proficiency: "Advanced",

      last_used: "2025-01-15"

    },

    {

      skill_code: aws.code,

      experience_years: 3,

      experience_months: 0,

      proficiency: "Intermediate",

      last_used: "2024-06-01"

    }

  ]);



  if (batch.skills?.length !== 2) {

    fail("batch insert returns two rows", String(batch.skills?.length));

  } else {

    pass("batch insert returns two rows");

  }



  let master = await readMaster(candidateId);

  const allFive = [...baselineNames, ...manualNames];



  if (!tokensIncludeAll(master.primary_skill, allFive)) {

    fail("additive primary_skill after manual add", master.primary_skill);

  } else {

    pass("additive primary_skill after manual add");

  }



  master = await readMaster(candidateId);



  if (!tokensIncludeAll(master.primary_skill, allFive)) {

    fail("reload preserves parsed and manual skills", master.primary_skill);

  } else {

    pass("reload preserves parsed and manual skills");

  }



  const pythonMapId = batch.skills.find(

    (row) => normalizeToken(row.skill_code) === normalizeToken(python.code)

  )?.skill_map_id;



  const awsMapId = batch.skills.find(

    (row) => normalizeToken(row.skill_code) === normalizeToken(aws.code)

  )?.skill_map_id;



  const updated = await candidateService.updateSkillMapRecord(

    pool,

    candidateId,

    pythonMapId,

    {

      experience_years: 5,

      proficiency: "Expert"

    }

  );



  master = await readMaster(candidateId);



  if (Number(updated.skill.experience_years) !== 5) {

    fail("edit persists metadata");

  } else if (!tokensIncludeAll(master.primary_skill, allFive)) {

    fail("edit keeps all skills", master.primary_skill);

  } else {

    pass("edit keeps all skills");

  }



  await candidateService.deleteSkillMapRecord(pool, candidateId, awsMapId);

  master = await readMaster(candidateId);



  if (

    !tokensIncludeAll(master.primary_skill, [...baselineNames, python.name]) ||

    !tokensExclude(master.primary_skill, [aws.name])

  ) {

    fail("delete manual AWS only", master.primary_skill);

  } else {

    pass("delete manual AWS only");

  }



  try {

    await candidateService.insertSkillMapBatch(pool, candidateId, [

      { skill_code: react.code, experience_years: 1 }

    ]);

    fail("duplicate baseline React rejected", "expected 409");

  } catch (error) {

    if (error.status === 409) {

      pass("duplicate baseline React rejected");

    } else {

      fail("duplicate baseline React rejected", error.message);

    }

  }



  try {

    await candidateService.insertSkillMapBatch(pool, candidateId, [

      { skill_code: python.code, experience_years: 1 }

    ]);

    fail("duplicate map skill rejected", "expected 409");

  } catch (error) {

    if (error.status === 409) {

      pass("duplicate map skill rejected");

    } else {

      fail("duplicate map skill rejected", error.message);

    }

  }



  const resolver = await buildSkillResolver();

  const candidateCodes = collectCandidateSkillCodes(master, resolver);



  if (

    !candidateCodes.has(java.code) ||

    !candidateCodes.has(react.code) ||

    !candidateCodes.has(sql.code) ||

    !candidateCodes.has(python.code)

  ) {

    fail("resume match path sees combined skills");

  } else {

    pass("resume match path sees combined skills");

  }



  try {

    await candidateService.insertSkillMapBatch(pool, candidateId, [

      { skill_code: aws.code, experience_years: -1 }

    ]);

    fail("reject experience_years -1", "expected 400");

  } catch (error) {

    if (error.status === 400) {

      pass("reject experience_years -1");

    } else {

      fail("reject experience_years -1", error.message);

    }

  }



  try {

    await candidateService.updateSkillMapRecord(pool, candidateId, pythonMapId, {

      experience_months: 12

    });

    fail("reject experience_months 12", "expected 400");

  } catch (error) {

    if (error.status === 400) {

      pass("reject experience_months 12");

    } else {

      fail("reject experience_months 12", error.message);

    }

  }



  await cleanupSkillMap(candidateId, touchedCodes);

  await setCandidateSkills(candidateId, baselineNames.join(", "), null);



  console.log("\nCandidate skill-map verification finished.");

  await pool.end();

}



main().catch((error) => {

  console.error(error);

  process.exitCode = 1;

  pool.end();

});


