require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:5000";

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function signEmployeeToken(user) {
  return jwt.sign(
    {
      user_id: user.user_id,
      employee_code: user.employee_code,
      email_id: user.email_id,
      role_name: user.role_name,
      secondary_role: user.secondary_role || null
    },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function fetchList(path, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json();

  if (!response.ok || body.success === false) {
    throw new Error(body.message || `${path} returned ${response.status}`);
  }

  return body.data || [];
}

function includesCandidate(rows, candidateId) {
  return rows.some((row) => Number(row.candidate_id) === Number(candidateId));
}

function searchRows(rows, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) {
    return rows;
  }

  return rows.filter((row) => {
    const name = [row.first_name, row.middle_name, row.last_name, row.preferred_name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const code = String(row.candidate_code || "").toLowerCase();
    const email = String(row.email_id || "").toLowerCase();
    return name.includes(needle) || code.includes(needle) || email.includes(needle);
  });
}

async function returnToTalentPool(candidateId, token) {
  const response = await fetch(
    `${API_BASE_URL}/return-candidate-to-talent-pool/${candidateId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  const body = await response.json();

  if (!response.ok || body.success === false) {
    throw new Error(
      body.message || `return-candidate-to-talent-pool/${candidateId} failed`
    );
  }

  return body;
}

async function registerContainer(candidateId, token, employeeCode, container) {
  const formData = new FormData();
  formData.append("first_name", "Pool");
  formData.append("last_name", "Segregation");
  formData.append("email_id", `pool.segregation.${candidateId}@example.com`);
  formData.append("mobile_number", "9876502222");
  formData.append("primary_skill", "Java");
  formData.append("total_experience", "3");
  formData.append("candidate_status", "REGISTERED");
  formData.append("candidate_container", container);
  formData.append("created_by", employeeCode);

  const response = await fetch(`${API_BASE_URL}/candidate/${candidateId}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: formData
  });
  const body = await response.json();

  if (!response.ok || body.success === false) {
    throw new Error(body.message || `PUT /candidate/${candidateId} failed`);
  }

  return body.data || body;
}

async function main() {
  const recruiterResult = await pool.query(
    `
    SELECT user_id, employee_code, email_id, role_name, secondary_role
    FROM user_mstr
    WHERE role_name = 'Recruiter'
      AND is_active = TRUE
    ORDER BY user_id
    LIMIT 1
    `
  );

  if (recruiterResult.rows.length === 0) {
    fail("active recruiter exists in user_mstr");
    await pool.end();
    return;
  }

  const recruiter = recruiterResult.rows[0];
  const recruiterToken = signEmployeeToken(recruiter);

  const nonRecruiterResult = await pool.query(
    `
    SELECT user_id, employee_code, email_id, role_name, secondary_role
    FROM user_mstr
    WHERE role_name <> 'Recruiter'
      AND is_active = TRUE
      AND employee_code IS NOT NULL
    ORDER BY user_id
    LIMIT 1
    `
  );

  const nonRecruiter =
    nonRecruiterResult.rows.length > 0 ? nonRecruiterResult.rows[0] : null;
  const nonRecruiterToken = nonRecruiter ? signEmployeeToken(nonRecruiter) : null;

  const insertResult = await pool.query(
    `
    INSERT INTO cand_mstr (
      first_name,
      last_name,
      email_id,
      mobile_number,
      primary_skill,
      total_experience,
      candidate_status,
      created_by
    )
    VALUES (
      'Pool',
      'SegregationDraft',
      $1,
      '9876503333',
      'Java',
      2,
      'DRAFT',
      $2
    )
    RETURNING candidate_id
    `,
    [`pool.segregation.draft.${Date.now()}@example.com`, recruiter.employee_code]
  );

  const candidateId = insertResult.rows[0].candidate_id;
  let talentCandidateId = null;

  try {
    await registerContainer(
      candidateId,
      recruiterToken,
      recruiter.employee_code,
      "PIPELINE"
    );
    pass("seed candidate registered to PIPELINE");

    const dbPipeline = await pool.query(
      `
      SELECT candidate_id, candidate_container, owner_employee_code, candidate_status
      FROM cand_mstr
      WHERE candidate_id = $1
      `,
      [candidateId]
    );
    const pipelineRow = dbPipeline.rows[0];

    if (pipelineRow.candidate_container !== "PIPELINE") {
      fail("database stores PIPELINE container", pipelineRow.candidate_container);
    } else {
      pass("database stores PIPELINE container");
    }

    const myPipelineRows = await fetchList("/my-candidates-list", recruiterToken);
    const talentPoolRows = await fetchList("/available-candidates", recruiterToken);

    if (!includesCandidate(myPipelineRows, candidateId)) {
      fail("PIPELINE candidate appears in My Pipeline list");
    } else {
      pass("PIPELINE candidate appears in My Pipeline list");
    }

    if (includesCandidate(talentPoolRows, candidateId)) {
      fail("PIPELINE candidate excluded from Talent Pool list");
    } else {
      pass("PIPELINE candidate excluded from Talent Pool list");
    }

    const otherRecruiterResult = await pool.query(
      `
      SELECT user_id, employee_code, email_id, role_name, secondary_role
      FROM user_mstr
      WHERE role_name = 'Recruiter'
        AND is_active = TRUE
        AND employee_code <> $1
      ORDER BY user_id
      LIMIT 1
      `,
      [recruiter.employee_code]
    );

    if (otherRecruiterResult.rows.length > 0) {
      const otherToken = signEmployeeToken(otherRecruiterResult.rows[0]);
      const otherMyPipeline = await fetchList("/my-candidates-list", otherToken);

      if (includesCandidate(otherMyPipeline, candidateId)) {
        fail("My Pipeline ownership rule excludes other recruiter");
      } else {
        pass("My Pipeline ownership rule excludes other recruiter");
      }
    } else {
      pass("My Pipeline ownership rule excludes other recruiter (single recruiter environment)");
    }

    const pipelineSearch = searchRows(myPipelineRows, "Pool Segregation");
    const talentSearchWhilePipeline = searchRows(talentPoolRows, "Pool Segregation");

    if (pipelineSearch.length === 0 || !includesCandidate(pipelineSearch, candidateId)) {
      fail("search in My Pipeline finds PIPELINE candidate");
    } else {
      pass("search in My Pipeline finds PIPELINE candidate");
    }

    if (includesCandidate(talentSearchWhilePipeline, candidateId)) {
      fail("search in Talent Pool excludes PIPELINE candidate");
    } else {
      pass("search in Talent Pool excludes PIPELINE candidate");
    }

    if (nonRecruiterToken) {
      const nonRecruiterTalent = await fetchList(
        "/available-candidates",
        nonRecruiterToken
      );
      const nonRecruiterMy = await fetchList("/my-candidates-list", nonRecruiterToken);

      if (includesCandidate(nonRecruiterTalent, candidateId)) {
        fail("non-recruiter Talent Pool excludes PIPELINE candidate");
      } else {
        pass("non-recruiter Talent Pool excludes PIPELINE candidate");
      }

      if (nonRecruiter.employee_code === pipelineRow.owner_employee_code) {
        if (!includesCandidate(nonRecruiterMy, candidateId)) {
          fail("non-recruiter owner sees owned PIPELINE candidate in My Pipeline");
        } else {
          pass("non-recruiter owner sees owned PIPELINE candidate in My Pipeline");
        }
      } else if (includesCandidate(nonRecruiterMy, candidateId)) {
        fail("non-recruiter My Pipeline excludes candidate owned by another user");
      } else {
        pass("non-recruiter My Pipeline excludes candidate owned by another user");
      }
    } else {
      pass("non-recruiter API access (no non-recruiter user in environment)");
    }

    await returnToTalentPool(candidateId, recruiterToken);
    pass("candidate transitioned to TALENT_POOL via return-candidate-to-talent-pool");

    const dbTalent = await pool.query(
      `
      SELECT candidate_id, candidate_container, owner_employee_code
      FROM cand_mstr
      WHERE candidate_id = $1
      `,
      [candidateId]
    );
    const talentRow = dbTalent.rows[0];

    if (talentRow.candidate_container !== "TALENT_POOL") {
      fail("database stores TALENT_POOL after transition", talentRow.candidate_container);
    } else {
      pass("database stores TALENT_POOL after transition");
    }

    const myAfterTalent = await fetchList("/my-candidates-list", recruiterToken);
    const talentAfterTransition = await fetchList("/available-candidates", recruiterToken);

    if (includesCandidate(myAfterTalent, candidateId)) {
      fail("My Pipeline excludes candidate after TALENT_POOL transition");
    } else {
      pass("My Pipeline excludes candidate after TALENT_POOL transition");
    }

    if (!includesCandidate(talentAfterTransition, candidateId)) {
      fail("Talent Pool includes candidate after TALENT_POOL transition");
    } else {
      pass("Talent Pool includes candidate after TALENT_POOL transition");
    }

    const talentSearchAfter = searchRows(talentAfterTransition, "Pool Segregation");
    const pipelineSearchAfterTalent = searchRows(myAfterTalent, "Pool Segregation");

    if (!includesCandidate(talentSearchAfter, candidateId)) {
      fail("search in Talent Pool finds TALENT_POOL candidate");
    } else {
      pass("search in Talent Pool finds TALENT_POOL candidate");
    }

    if (includesCandidate(pipelineSearchAfterTalent, candidateId)) {
      fail("search in My Pipeline excludes TALENT_POOL candidate");
    } else {
      pass("search in My Pipeline excludes TALENT_POOL candidate");
    }

    const talentInsertResult = await pool.query(
      `
      INSERT INTO cand_mstr (
        first_name,
        last_name,
        email_id,
        mobile_number,
        primary_skill,
        total_experience,
        candidate_status,
        created_by
      )
      VALUES (
        'Pool',
        'TalentOnly',
        $1,
        '9876504444',
        'Java',
        2,
        'DRAFT',
        $2
      )
      RETURNING candidate_id
      `,
      [
        `pool.segregation.talent.${Date.now()}@example.com`,
        recruiter.employee_code
      ]
    );
    const talentCandidateId = talentInsertResult.rows[0].candidate_id;

    await registerContainer(
      talentCandidateId,
      recruiterToken,
      recruiter.employee_code,
      "TALENT_POOL"
    );
    pass("TALENT_POOL candidate registered via existing PUT /candidate/:id");

    const dbTalentOnly = await pool.query(
      `
      SELECT candidate_id, candidate_container, owner_employee_code
      FROM cand_mstr
      WHERE candidate_id = $1
      `,
      [talentCandidateId]
    );
    const talentOnlyRow = dbTalentOnly.rows[0];

    if (talentOnlyRow.candidate_container !== "TALENT_POOL") {
      fail("TALENT_POOL registration stores TALENT_POOL container", talentOnlyRow.candidate_container);
    } else {
      pass("TALENT_POOL registration stores TALENT_POOL container");
    }

    const myForTalentOnly = await fetchList("/my-candidates-list", recruiterToken);
    const talentForTalentOnly = await fetchList("/available-candidates", recruiterToken);

    if (includesCandidate(myForTalentOnly, talentCandidateId)) {
      fail("My Pipeline excludes TALENT_POOL-only candidate");
    } else {
      pass("My Pipeline excludes TALENT_POOL-only candidate");
    }

    if (!includesCandidate(talentForTalentOnly, talentCandidateId)) {
      fail("Talent Pool includes TALENT_POOL-only candidate");
    } else {
      pass("Talent Pool includes TALENT_POOL-only candidate");
    }

    const duplicateCount = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM cand_mstr
      WHERE candidate_id = ANY($1::int[])
      `,
      [[candidateId, talentCandidateId]]
    );

    if (duplicateCount.rows[0]?.total !== 2) {
      fail("no duplicate cand_mstr after container transitions", duplicateCount.rows[0]?.total);
    } else {
      pass("no duplicate cand_mstr after container transitions");
    }
  } finally {
    await pool.query(
      `DELETE FROM cand_mstr WHERE candidate_id = ANY($1::int[])`,
      [[candidateId, talentCandidateId].filter(Boolean)]
    );
    pass("pool segregation verification cleanup completed");
  }

  if (process.exitCode) {
    console.error("Candidate pool segregation verification failed.");
  } else {
    console.log("Candidate pool segregation verification passed.");
  }

  await pool.end();
}

main().catch(async (error) => {
  fail("unexpected error", error.message);
  await pool.end();
});
