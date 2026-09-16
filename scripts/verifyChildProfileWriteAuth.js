/**
 * Child profile write authorization verification.
 * Run: node scripts/verifyChildProfileWriteAuth.js
 */
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

function signToken(user) {
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

async function fetchJson(path, token, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function resolveUserByRole(roleName) {
  const result = await pool.query(
    `SELECT user_id, employee_code, email_id, role_name, secondary_role
     FROM user_mstr
     WHERE role_name = $1 AND COALESCE(is_active, TRUE) = TRUE
     ORDER BY user_id ASC
     LIMIT 1`,
    [roleName]
  );
  return result.rows[0] || null;
}

async function resolveOwnedPipelineCandidate(recruiterCode) {
  const result = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE owner_employee_code = $1
       AND UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
     ORDER BY candidate_id DESC
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function resolveForeignOwnedCandidate(recruiterCode) {
  const result = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE owner_employee_code IS NOT NULL
       AND owner_employee_code <> $1
       AND UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'PIPELINE'
     ORDER BY candidate_id DESC
     LIMIT 1`,
    [recruiterCode]
  );
  return result.rows[0] || null;
}

async function countEducationRows(candidateId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM can_education
     WHERE candidate_id = $1`,
    [candidateId]
  );
  return result.rows[0]?.count || 0;
}

async function countExperienceRows(candidateId) {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM can_experience
     WHERE candidate_id = $1`,
    [candidateId]
  );
  return result.rows[0]?.count || 0;
}

async function main() {
  console.log("=== Child Profile Write Authorization ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const ownedCandidate = await resolveOwnedPipelineCandidate(recruiter.employee_code);
  const foreignCandidate = await resolveForeignOwnedCandidate(recruiter.employee_code);
  const poolCandidate = await pool.query(
    `SELECT candidate_id
     FROM cand_mstr
     WHERE UPPER(COALESCE(candidate_container, 'PIPELINE')) = 'TALENT_POOL'
     ORDER BY candidate_id DESC
     LIMIT 1`
  ).then((result) => result.rows[0] || null);

  const writableCandidateId =
    ownedCandidate?.candidate_id || poolCandidate?.candidate_id || null;

  if (!writableCandidateId) {
    fail("fixtures", "no readable candidate fixture for authorized write tests");
    await pool.end();
    return;
  }

  const candidateId = writableCandidateId;
  const adminToken = signToken(admin);
  const recruiterToken = signToken(recruiter);

  const educationBefore = await countEducationRows(candidateId);
  const experienceBefore = await countExperienceRows(candidateId);

  const recruiterEducation = await fetchJson(
    `/candidate/${candidateId}/education`,
    recruiterToken,
    {
      method: "POST",
      body: JSON.stringify({
        qualification: "Auth Verify Degree",
        institution: "Auth Verify College"
      })
    }
  );

  if (recruiterEducation.status === 201 && recruiterEducation.body?.success) {
    pass("Authorized recruiter can create education (201)");
  } else {
    fail(
      "Authorized recruiter education create",
      `status=${recruiterEducation.status}`
    );
  }

  const educationAfterRecruiter = await countEducationRows(candidateId);
  if (educationAfterRecruiter === educationBefore + 1) {
    pass("Education row count increased by one for authorized recruiter");
  } else {
    fail(
      "Education row count after recruiter create",
      `before=${educationBefore}, after=${educationAfterRecruiter}`
    );
  }

  const educationId = recruiterEducation.body?.data?.education_id;

  const recruiterExperience = await fetchJson(
    `/candidate/${candidateId}/experience`,
    recruiterToken,
    {
      method: "POST",
      body: JSON.stringify({
        company_name: "Auth Verify Corp",
        designation: "Engineer",
        joining_date: "2020-01-01"
      })
    }
  );

  if (recruiterExperience.status === 201 && recruiterExperience.body?.success) {
    pass("Authorized recruiter can create experience (201)");
  } else {
    fail(
      "Authorized recruiter experience create",
      `status=${recruiterExperience.status}`
    );
  }

  const experienceAfterRecruiter = await countExperienceRows(candidateId);
  if (experienceAfterRecruiter === experienceBefore + 1) {
    pass("Experience row count increased by one for authorized recruiter");
  } else {
    fail(
      "Experience row count after recruiter create",
      `before=${experienceBefore}, after=${experienceAfterRecruiter}`
    );
  }

  const experienceId = recruiterExperience.body?.data?.experience_id;

  const adminEducation = await fetchJson(
    `/candidate/${candidateId}/education`,
    adminToken,
    {
      method: "POST",
      body: JSON.stringify({
        qualification: "Admin Auth Verify Degree",
        institution: "Admin Auth Verify College"
      })
    }
  );

  if (adminEducation.status === 201 && adminEducation.body?.success) {
    pass("Admin can create education on readable candidate (201)");
  } else {
    fail("Admin education create", `status=${adminEducation.status}`);
  }

  if (foreignCandidate?.candidate_id) {
    const foreignId = foreignCandidate.candidate_id;
    const foreignEducationBefore = await countEducationRows(foreignId);

    const deniedEducation = await fetchJson(
      `/candidate/${foreignId}/education`,
      recruiterToken,
      {
        method: "POST",
        body: JSON.stringify({
          qualification: "Forbidden Degree",
          institution: "Forbidden College"
        })
      }
    );

    if (deniedEducation.status === 403) {
      pass("Foreign/unowned recruiter education create denied (403)");
    } else {
      fail(
        "Foreign recruiter education create",
        `expected 403, got ${deniedEducation.status}`
      );
    }

    const foreignEducationAfter = await countEducationRows(foreignId);
    if (foreignEducationAfter === foreignEducationBefore) {
      pass("No unauthorized education row mutation on foreign candidate");
    } else {
      fail(
        "Unauthorized education mutation",
        `before=${foreignEducationBefore}, after=${foreignEducationAfter}`
      );
    }

    const foreignExperienceBefore = await countExperienceRows(foreignId);

    const deniedExperience = await fetchJson(
      `/candidate/${foreignId}/experience`,
      recruiterToken,
      {
        method: "POST",
        body: JSON.stringify({
          company_name: "Forbidden Corp",
          designation: "Engineer",
          joining_date: "2019-01-01"
        })
      }
    );

    if (deniedExperience.status === 403) {
      pass("Foreign/unowned recruiter experience create denied (403)");
    } else {
      fail(
        "Foreign recruiter experience create",
        `expected 403, got ${deniedExperience.status}`
      );
    }

    const foreignExperienceAfter = await countExperienceRows(foreignId);
    if (foreignExperienceAfter === foreignExperienceBefore) {
      pass("No unauthorized experience row mutation on foreign candidate");
    } else {
      fail(
        "Unauthorized experience mutation",
        `before=${foreignExperienceBefore}, after=${foreignExperienceAfter}`
      );
    }
  } else {
    console.log("SKIP: foreign recruiter denial — no foreign-owned PIPELINE fixture");
  }

  if (educationId) {
    const updateEducation = await fetchJson(
      `/candidate/${candidateId}/education/${educationId}`,
      recruiterToken,
      {
        method: "PUT",
        body: JSON.stringify({
          qualification: "Auth Verify Degree Updated",
          institution: "Auth Verify College"
        })
      }
    );

    if (updateEducation.status === 200 && updateEducation.body?.success) {
      pass("Authorized recruiter can update education (200)");
    } else {
      fail("Authorized recruiter education update", `status=${updateEducation.status}`);
    }
  }

  if (experienceId) {
    const updateExperience = await fetchJson(
      `/candidate/${candidateId}/experience/${experienceId}`,
      recruiterToken,
      {
        method: "PUT",
        body: JSON.stringify({
          company_name: "Auth Verify Corp Updated",
          designation: "Senior Engineer",
          joining_date: "2020-01-01"
        })
      }
    );

    if (updateExperience.status === 200 && updateExperience.body?.success) {
      pass("Authorized recruiter can update experience (200)");
    } else {
      fail("Authorized recruiter experience update", `status=${updateExperience.status}`);
    }
  }

  if (educationId) {
    await fetchJson(
      `/candidate/${candidateId}/education/${educationId}`,
      recruiterToken,
      { method: "DELETE" }
    );
  }

  if (experienceId) {
    await fetchJson(
      `/candidate/${candidateId}/experience/${experienceId}`,
      recruiterToken,
      { method: "DELETE" }
    );
  }

  const adminCreatedEducationId = adminEducation.body?.data?.education_id;
  if (adminCreatedEducationId) {
    await fetchJson(
      `/candidate/${candidateId}/education/${adminCreatedEducationId}`,
      adminToken,
      { method: "DELETE" }
    );
  }

  const educationFinal = await countEducationRows(candidateId);
  if (educationFinal === educationBefore) {
    pass("Education write cleanup restored original row count");
  } else {
    fail(
      "Education cleanup",
      `expected ${educationBefore}, got ${educationFinal}`
    );
  }

  const experienceFinal = await countExperienceRows(candidateId);
  if (experienceFinal === experienceBefore) {
    pass("Experience write cleanup restored original row count");
  } else {
    fail(
      "Experience cleanup",
      `expected ${experienceBefore}, got ${experienceFinal}`
    );
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nChild profile write authorization verification completed with failures.");
  } else {
    console.log("\nAll child profile write authorization checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
