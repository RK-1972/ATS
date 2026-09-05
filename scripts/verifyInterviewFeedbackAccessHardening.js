require("dotenv").config();

const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const interviewService = require("../services/interviewService");

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

async function findPanelMemberScheduleFixture() {
  const result = await pool.query(
    `SELECT
        s.schedule_id,
        s.interviewer_id AS panel_id,
        ipm.employee_code AS panel_employee_code,
        ipm.user_id AS panel_user_id,
        i.interview_id,
        f.feedback_id
     FROM interview_schedule_trn s
     INNER JOIN interview_panel_mstr ipm
       ON ipm.panel_id = s.interviewer_id
      AND ipm.is_active = true
     LEFT JOIN im_interviews i ON i.schedule_id = s.schedule_id
     LEFT JOIN im_feedback f ON f.schedule_id = s.schedule_id
     ORDER BY f.feedback_id DESC NULLS LAST, s.schedule_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function findNonPanelScheduleFixture(excludeEmployeeCode) {
  const result = await pool.query(
    `SELECT s.schedule_id, f.feedback_id
     FROM interview_schedule_trn s
     LEFT JOIN im_feedback f ON f.schedule_id = s.schedule_id
     WHERE NOT EXISTS (
       SELECT 1
       FROM interview_panel_mstr ipm
       WHERE ipm.panel_id = s.interviewer_id
         AND ipm.employee_code = $1
         AND ipm.is_active = true
     )
     ORDER BY f.feedback_id DESC NULLS LAST, s.schedule_id DESC
     LIMIT 1`,
    [excludeEmployeeCode]
  );
  return result.rows[0] || null;
}

async function main() {
  console.log("=== Interview Feedback Access Hardening (P1-4 / P1-5) ===\n");

  const admin = await resolveUserByRole("Admin");
  const recruiter = await resolveUserByRole("Recruiter");
  const hiringManager = await resolveUserByRole("Hiring Manager");
  const interviewer = await resolveUserByRole("Interviewer");
  const taLead = await resolveUserByRole("TA Lead");

  if (!admin || !recruiter) {
    fail("fixtures", "Admin and Recruiter users required");
    await pool.end();
    return;
  }

  const panelFixture = await findPanelMemberScheduleFixture();
  const nonPanelFixture = panelFixture
    ? await findNonPanelScheduleFixture(panelFixture.panel_employee_code)
    : null;

  if (!panelFixture) {
    console.log("SKIP: no interview schedule with active panel membership fixture");
  } else {
    console.log(
      `Fixture schedule_id=${panelFixture.schedule_id} panel=${panelFixture.panel_employee_code} feedback=${panelFixture.feedback_id || "none"}`
    );
  }

  const panelUser = panelFixture
    ? (
      await pool.query(
        `SELECT user_id, employee_code, email_id, role_name, secondary_role
         FROM user_mstr
         WHERE employee_code = $1
         LIMIT 1`,
        [panelFixture.panel_employee_code]
      )
    ).rows[0]
    : interviewer;

  const tokens = {
    admin: signToken(admin),
    recruiter: signToken(recruiter),
    hiringManager: hiringManager ? signToken(hiringManager) : null,
    interviewer: interviewer ? signToken(interviewer) : null,
    taLead: taLead ? signToken(taLead) : null,
    panelMember: panelUser ? signToken(panelUser) : null
  };

  console.log("\n--- Service layer ---");

  if (panelFixture && panelUser) {
    const adminReq = { user: admin };
    const panelReq = { user: panelUser };
    const recruiterReq = { user: recruiter };

    try {
      await interviewService.assertInterviewFeedbackAccess(pool, adminReq, {
        scheduleId: panelFixture.schedule_id
      });
      pass("Service: Admin allowed feedback access");
    } catch (error) {
      fail("Service: Admin feedback access", error.message);
    }

    try {
      await interviewService.assertInterviewFeedbackAccess(pool, panelReq, {
        scheduleId: panelFixture.schedule_id
      });
      pass("Service: assigned panel member allowed feedback access");
    } catch (error) {
      fail("Service: panel member feedback access", `${error.status} ${error.message}`);
    }

    try {
      await interviewService.assertInterviewFeedbackAccess(pool, recruiterReq, {
        scheduleId: panelFixture.schedule_id
      });
      fail("Service: recruiter assert", "expected throw");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: Recruiter denied feedback access");
      } else {
        fail("Service: recruiter assert", `expected 403, got ${error.status}`);
      }
    }

    if (hiringManager) {
      try {
        await interviewService.assertInterviewFeedbackAccess(pool, { user: hiringManager }, {
          scheduleId: panelFixture.schedule_id
        });
        fail("Service: HM assert", "expected throw");
      } catch (error) {
        if (error.status === 403) {
          pass("Service: Hiring Manager denied feedback access");
        } else {
          fail("Service: HM assert", `expected 403, got ${error.status}`);
        }
      }
    }

    if (taLead) {
      try {
        await interviewService.assertInterviewFeedbackAccess(pool, { user: taLead }, {
          scheduleId: panelFixture.schedule_id
        });
        fail("Service: TA Lead assert", "expected throw");
      } catch (error) {
        if (error.status === 403) {
          pass("Service: TA Lead denied feedback access");
        } else {
          fail("Service: TA Lead assert", `expected 403, got ${error.status}`);
        }
      }
    }

    if (nonPanelFixture && nonPanelFixture.schedule_id !== panelFixture.schedule_id) {
      try {
        await interviewService.getFeedbackBySchedule(
          pool,
          nonPanelFixture.schedule_id,
          recruiterReq
        );
        fail("Service: non-panel read", "expected throw");
      } catch (error) {
        if (error.status === 403) {
          pass("Service: non-panel user denied read on foreign schedule");
        } else {
          fail("Service: non-panel read", `expected 403, got ${error.status}`);
        }
      }
    } else {
      console.log("SKIP: no distinct non-panel schedule fixture");
    }

    const writeScheduleId = panelFixture.schedule_id;
    const beforeCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS c FROM im_feedback WHERE schedule_id = $1`,
        [writeScheduleId]
      )
    ).rows[0].c;

    try {
      await interviewService.submitFeedback(
        pool,
        {
          schedule_id: writeScheduleId,
          interview_level: "L1 Technical",
          area_of_interview: "Technical",
          overall_rating: "Good",
          strengths: "auth-check",
          improvement_areas: "none",
          overall_comments: "verify script — do not persist",
          final_outcome: "Selected",
          skills: []
        },
        recruiterReq
      );
      fail("Service: unauthorized write", "expected throw before mutation");
    } catch (error) {
      if (error.status === 403) {
        pass("Service: unauthorized write blocked before mutation (403)");
      } else {
        fail("Service: unauthorized write", `expected 403, got ${error.status}: ${error.message}`);
      }
    }

    try {
      await interviewService.assertInterviewFeedbackAccess(pool, panelReq, {
        scheduleId: writeScheduleId
      });
      pass("Service: panel member authorized on assigned schedule (write path pre-check)");
    } catch (error) {
      fail("Service: panel write path pre-check", `${error.status} ${error.message}`);
    }

    const afterCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS c FROM im_feedback WHERE schedule_id = $1`,
        [writeScheduleId]
      )
    ).rows[0].c;

    if (beforeCount === afterCount) {
      pass("Service: unauthorized write did not insert im_feedback row");
    } else {
      fail("Service: im_feedback row count changed after blocked write", `${beforeCount} -> ${afterCount}`);
    }
  }

  console.log("\n--- HTTP layer (requires restarted backend) ---");

  if (panelFixture) {
    const scheduleId = panelFixture.schedule_id;

    const adminRead = await fetchJson(`/feedback/${scheduleId}`, tokens.admin);
    if (adminRead.status === 200 && adminRead.body?.success) {
      pass("HTTP: Admin can read feedback endpoint");
    } else {
      fail("HTTP: Admin feedback read", `status=${adminRead.status}`);
    }

    if (tokens.panelMember) {
      const panelRead = await fetchJson(`/feedback/${scheduleId}`, tokens.panelMember);
      if (panelRead.status === 200 && panelRead.body?.success) {
        pass("HTTP: panel member can read feedback endpoint");
      } else {
        fail("HTTP: panel member feedback read", `status=${panelRead.status}`);
      }
    } else {
      console.log("SKIP: panel member token unavailable");
    }

    const recruiterRead = await fetchJson(`/feedback/${scheduleId}`, tokens.recruiter);
    if (recruiterRead.status === 403) {
      pass("HTTP: Recruiter denied feedback read");
    } else {
      fail("HTTP: Recruiter feedback read", `expected 403, got ${recruiterRead.status}`);
    }

    for (const [label, token] of [
      ["Hiring Manager", tokens.hiringManager],
      ["TA Lead", tokens.taLead]
    ]) {
      if (!token) {
        console.log(`SKIP: ${label} user not found`);
        continue;
      }
      const denied = await fetchJson(`/feedback/${scheduleId}`, token);
      if (denied.status === 403) {
        pass(`HTTP: ${label} denied feedback read`);
      } else {
        fail(`HTTP: ${label} feedback read`, `expected 403, got ${denied.status}`);
      }
    }

    const writeScheduleId = scheduleId;
    const beforeCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS c FROM im_feedback WHERE schedule_id = $1`,
        [writeScheduleId]
      )
    ).rows[0].c;

    const blockedWrite = await fetchJson("/submit-feedback", tokens.recruiter, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schedule_id: writeScheduleId,
        interview_level: "L1 Technical",
        area_of_interview: "Technical",
        overall_rating: "Good",
        strengths: "http-auth-check",
        improvement_areas: "none",
        overall_comments: "verify script — blocked write",
        final_outcome: "Selected",
        skills: []
      })
    });

    if (blockedWrite.status === 403) {
      pass("HTTP: unauthorized submit-feedback blocked (403)");
    } else {
      fail("HTTP: unauthorized submit-feedback", `expected 403, got ${blockedWrite.status}`);
    }

    const afterCount = (
      await pool.query(
        `SELECT COUNT(*)::int AS c FROM im_feedback WHERE schedule_id = $1`,
        [writeScheduleId]
      )
    ).rows[0].c;

    if (beforeCount === afterCount) {
      pass("HTTP: blocked submit-feedback did not mutate im_feedback");
    } else {
      fail("HTTP: im_feedback mutated after blocked write", `${beforeCount} -> ${afterCount}`);
    }
  } else {
    console.log("SKIP: HTTP feedback tests — no panel schedule fixture");
  }

  await pool.end();

  if (process.exitCode) {
    console.log("\nInterview feedback access hardening verification completed with failures.");
  } else {
    console.log("\nAll interview feedback access hardening checks passed.");
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  await pool.end();
});
