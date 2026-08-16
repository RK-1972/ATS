const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const {
  isPasswordStrong
} = require("../utils/passwordPolicy");

const EMAIL_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MOBILE_REGEX =
  /^\+?[0-9][0-9\s-]{8,18}[0-9]$/;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMobile(mobile) {
  return String(mobile || "").trim().replace(/\s+/g, " ");
}

function splitFullName(fullName) {
  const trimmed = String(fullName || "").trim().replace(/\s+/g, " ");

  if (!trimmed) {
    return { first_name: "", last_name: "" };
  }

  const parts = trimmed.split(" ");

  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" ") || ""
  };
}

async function generateCandidateCode(client) {
  const today = new Date();
  const day = String(today.getDate()).padStart(2, "0");
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const year = String(today.getFullYear()).slice(-2);
  const datePrefix = `${day}${month}${year}`;

  const countResult = await client.query(
    `
    SELECT COUNT(*) AS total
    FROM cand_mstr
    WHERE TO_CHAR(created_on, 'DDMMYY') = $1
    `,
    [datePrefix]
  );

  const runningNumber =
    parseInt(countResult.rows[0].total, 10) + 1;

  return `${datePrefix}${runningNumber}`;
}

async function resolvePortalSourceId(queryable) {
  try {
    const result = await queryable.query(
      `
      SELECT source_id
      FROM rm_candidate_sources
      WHERE source_code = 'PORTAL'
      LIMIT 1
      `
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0].source_id;
  } catch (error) {
    if (error.message?.includes("rm_candidate_sources")) {
      return null;
    }

    throw error;
  }
}

function createCandidatePortalService(pool) {
  async function findPortalAccountByEmail(emailId) {
    const result = await pool.query(
      `
      SELECT *
      FROM candidate_portal_account
      WHERE LOWER(email_id) = LOWER($1)
      LIMIT 1
      `,
      [emailId]
    );

    return result.rows[0] || null;
  }

  async function findEmployeeByEmail(emailId) {
    const result = await pool.query(
      `
      SELECT user_id, email_id
      FROM user_mstr
      WHERE LOWER(email_id) = LOWER($1)
      LIMIT 1
      `,
      [emailId]
    );

    return result.rows[0] || null;
  }

  async function findCandidateByEmail(emailId) {
    const result = await pool.query(
      `
      SELECT
        candidate_id,
        candidate_code,
        first_name,
        last_name,
        email_id,
        mobile_number,
        candidate_status,
        profile_completion
      FROM cand_mstr
      WHERE LOWER(email_id) = LOWER($1)
      LIMIT 1
      `,
      [emailId]
    );

    return result.rows[0] || null;
  }

  async function findPortalAccountByCandidateId(candidateId) {
    const result = await pool.query(
      `
      SELECT portal_account_id, email_id
      FROM candidate_portal_account
      WHERE candidate_id = $1
      LIMIT 1
      `,
      [candidateId]
    );

    return result.rows[0] || null;
  }

  async function createDraftCandidate(client, {
    fullName,
    emailId,
    mobileNumber,
    sourceId = null
  }) {
    const { first_name, last_name } = splitFullName(fullName);
    const candidateCode = await generateCandidateCode(client);

    const result = await client.query(
      `
      INSERT INTO cand_mstr (
        candidate_code,
        first_name,
        last_name,
        email_id,
        mobile_number,
        source_channel,
        candidate_source_code,
        candidate_status,
        remarks,
        created_by
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10
      )
      RETURNING candidate_id, candidate_code, candidate_status, profile_completion
      `,
      [
        candidateCode,
        first_name,
        last_name,
        emailId,
        mobileNumber,
        sourceId,
        "PORTAL",
        "DRAFT",
        "Created via Candidate Portal registration",
        "CANDIDATE_PORTAL"
      ]
    );

    return result.rows[0];
  }

  function signCandidateToken(account) {
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is not configured");
    }

    return jwt.sign(
      {
        account_type: "candidate",
        portal_account_id: account.portal_account_id,
        candidate_id: account.candidate_id,
        email_id: account.email_id,
        full_name: account.full_name
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );
  }

  function validateRegistrationInput({
    full_name,
    mobile_number,
    email_id,
    password,
    confirm_password
  }) {
    const fullName = String(full_name || "").trim();
    const mobileNumber = normalizeMobile(mobile_number);
    const emailId = normalizeEmail(email_id);

    if (!fullName) {
      return { ok: false, status: 400, message: "Full name is required" };
    }

    if (!mobileNumber) {
      return { ok: false, status: 400, message: "Mobile number is required" };
    }

    if (!MOBILE_REGEX.test(mobileNumber)) {
      return {
        ok: false,
        status: 400,
        message: "Enter a valid mobile number"
      };
    }

    if (!emailId) {
      return { ok: false, status: 400, message: "Email is required" };
    }

    if (!EMAIL_REGEX.test(emailId)) {
      return {
        ok: false,
        status: 400,
        message: "Enter a valid email address"
      };
    }

    if (!password) {
      return { ok: false, status: 400, message: "Password is required" };
    }

    if (!isPasswordStrong(password)) {
      return {
        ok: false,
        status: 400,
        message: "Password does not meet security requirements"
      };
    }

    if (password !== confirm_password) {
      return {
        ok: false,
        status: 400,
        message: "Passwords do not match"
      };
    }

    return {
      ok: true,
      data: {
        fullName,
        mobileNumber,
        emailId
      }
    };
  }

  async function registerCandidateAccount(input) {
    const validation = validateRegistrationInput(input);

    if (!validation.ok) {
      return validation;
    }

    const { fullName, mobileNumber, emailId } = validation.data;

    const existingPortalAccount =
      await findPortalAccountByEmail(emailId);

    if (existingPortalAccount) {
      return {
        ok: false,
        status: 409,
        message:
          "An account already exists for this email address. Please sign in."
      };
    }

    const existingEmployee = await findEmployeeByEmail(emailId);

    if (existingEmployee) {
      return {
        ok: false,
        status: 409,
        message:
          "This email is associated with an employee account and cannot be used for candidate registration."
      };
    }

    const client = await pool.connect();
    const portalSourceId = await resolvePortalSourceId(pool);

    try {
      await client.query("BEGIN");

      const existingCandidateResult = await client.query(
        `
        SELECT
          candidate_id,
          candidate_code,
          first_name,
          last_name,
          email_id,
          mobile_number,
          candidate_status,
          profile_completion
        FROM cand_mstr
        WHERE LOWER(email_id) = LOWER($1)
        LIMIT 1
        FOR UPDATE
        `,
        [emailId]
      );

      let candidateRecord = existingCandidateResult.rows[0] || null;
      let linkedExistingCandidate = false;

      if (candidateRecord) {
        linkedExistingCandidate = true;

        const existingPortalForCandidateResult = await client.query(
          `
          SELECT portal_account_id, email_id
          FROM candidate_portal_account
          WHERE candidate_id = $1
          LIMIT 1
          `,
          [candidateRecord.candidate_id]
        );

        if (existingPortalForCandidateResult.rows.length > 0) {
          await client.query("ROLLBACK");
          return {
            ok: false,
            status: 409,
            message:
              "An account already exists for this email address. Please sign in."
          };
        }

        await client.query(
          `
          UPDATE cand_mstr
          SET
            mobile_number = COALESCE(NULLIF($1, ''), mobile_number),
            updated_on = NOW()
          WHERE candidate_id = $2
          `,
          [mobileNumber, candidateRecord.candidate_id]
        );
      } else {
        candidateRecord = await createDraftCandidate(client, {
          fullName,
          emailId,
          mobileNumber,
          sourceId: portalSourceId
        });
      }

      const passwordHash = await bcrypt.hash(input.password, 10);

      const accountResult = await client.query(
        `
        INSERT INTO candidate_portal_account (
          candidate_id,
          email_id,
          password_hash,
          full_name,
          mobile_number
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          portal_account_id,
          candidate_id,
          email_id,
          full_name,
          mobile_number,
          is_active,
          created_on
        `,
        [
          candidateRecord.candidate_id,
          emailId,
          passwordHash,
          fullName,
          mobileNumber
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        data: {
          account: accountResult.rows[0],
          candidate: candidateRecord,
          linked_existing_candidate: linkedExistingCandidate
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function loginCandidateAccount({ email_id, password }) {
    const emailId = normalizeEmail(email_id);

    if (!emailId || typeof password !== "string") {
      return {
        ok: false,
        status: 400,
        message: "Email and password are required"
      };
    }

    const account = await findPortalAccountByEmail(emailId);

    if (!account || !account.is_active) {
      return {
        ok: false,
        status: 401,
        message: "Invalid Email"
      };
    }

    const validPassword = await bcrypt.compare(
      password,
      account.password_hash
    );

    if (!validPassword) {
      return {
        ok: false,
        status: 401,
        message: "Invalid Password"
      };
    }

    await pool.query(
      `
      UPDATE candidate_portal_account
      SET
        last_login_on = NOW(),
        updated_on = NOW()
      WHERE portal_account_id = $1
      `,
      [account.portal_account_id]
    );

    const candidateResult = await pool.query(
      `
      SELECT
        candidate_id,
        candidate_code,
        candidate_status,
        profile_completion,
        first_name,
        last_name,
        email_id,
        mobile_number
      FROM cand_mstr
      WHERE candidate_id = $1
      LIMIT 1
      `,
      [account.candidate_id]
    );

    const candidate = candidateResult.rows[0] || null;
    const token = signCandidateToken(account);

    return {
      ok: true,
      data: {
        token,
        account: {
          portal_account_id: account.portal_account_id,
          candidate_id: account.candidate_id,
          email_id: account.email_id,
          full_name: account.full_name,
          mobile_number: account.mobile_number
        },
        candidate
      }
    };
  }

  async function getCandidateWorkspaceSummary(candidateId) {
    const result = await pool.query(
      `
      SELECT
        c.candidate_id,
        c.candidate_code,
        c.first_name,
        c.last_name,
        c.email_id,
        c.mobile_number,
        c.candidate_status,
        c.profile_completion,
        c.resume_path,
        c.candidate_source_code,
        a.full_name AS portal_full_name,
        i.review_status AS portal_review_status,
        i.parsing_status AS portal_parsing_status
      FROM cand_mstr c
      JOIN candidate_portal_account a
        ON a.candidate_id = c.candidate_id
      LEFT JOIN LATERAL (
        SELECT review_status, parsing_status
        FROM rm_candidate_intake
        WHERE source_reference = $2
        ORDER BY created_on DESC
        LIMIT 1
      ) i ON TRUE
      WHERE c.candidate_id = $1
      LIMIT 1
      `,
      [candidateId, `portal-candidate:${candidateId}`]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const profileCompletion = Number(row.profile_completion || 0);
    const hasResume = Boolean(row.resume_path);

    let profile_status = "Profile Incomplete";

    if (row.candidate_status === "REGISTERED") {
      profile_status = "Registered";
    } else if (row.portal_review_status === "SUBMITTED") {
      profile_status = "Under Recruiter Review";
    } else if (hasResume && profileCompletion >= 50) {
      profile_status = "Profile Complete";
    } else if (hasResume || profileCompletion > 0) {
      profile_status = "Profile Complete";
    }

    return {
      candidate_id: row.candidate_id,
      candidate_code: row.candidate_code,
      full_name: row.portal_full_name,
      email_id: row.email_id,
      mobile_number: row.mobile_number,
      candidate_status: row.candidate_status,
      profile_completion: profileCompletion,
      has_resume: hasResume,
      profile_status,
      portal_review_status: row.portal_review_status || null
    };
  }

  return {
    normalizeEmail,
    validateRegistrationInput,
    registerCandidateAccount,
    loginCandidateAccount,
    getCandidateWorkspaceSummary,
    signCandidateToken
  };
}

module.exports = {
  createCandidatePortalService,
  splitFullName,
  normalizeEmail,
  normalizeMobile
};
