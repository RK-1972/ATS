const PORTAL_SOURCE_CODE = "PORTAL";
const PORTAL_SOURCE_REFERENCE_PREFIX = "portal-candidate:";

function buildPortalSourceReference(candidateId) {
  return `${PORTAL_SOURCE_REFERENCE_PREFIX}${candidateId}`;
}

function parsePortalSourceReference(sourceReference) {
  if (
    typeof sourceReference !== "string" ||
    !sourceReference.startsWith(PORTAL_SOURCE_REFERENCE_PREFIX)
  ) {
    return null;
  }

  const candidateId = Number(
    sourceReference.slice(PORTAL_SOURCE_REFERENCE_PREFIX.length)
  );

  return Number.isFinite(candidateId) ? candidateId : null;
}

async function listIntakeReviewQueue(pool) {
  let hasSourceMaster = true;

  try {
    const sourceTable = await pool.query(
      `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'rm_candidate_sources'
      LIMIT 1
      `
    );

    hasSourceMaster = sourceTable.rowCount > 0;
  } catch {
    hasSourceMaster = false;
  }

  const sourceJoin = hasSourceMaster
    ? `
    LEFT JOIN rm_candidate_sources s
      ON s.source_id::text = i.source_id::text
    `
    : "";

  const sourceSelect = hasSourceMaster
    ? `
      COALESCE(s.source_code, c.candidate_source_code) AS source_code,
      COALESCE(s.source_name, 'Career Portal') AS source_name,
    `
    : `
      c.candidate_source_code AS source_code,
      CASE
        WHEN c.candidate_source_code = 'PORTAL' THEN 'Career Portal'
        ELSE COALESCE(c.candidate_source_code, 'Candidate Intake')
      END AS source_name,
    `;

  const result = await pool.query(
    `
    SELECT
      i.intake_id,
      i.review_status,
      i.parsing_status,
      i.source_reference,
      i.source_id,
      ${sourceSelect}
      i.created_on AS submitted_on,
      c.candidate_id,
      c.candidate_code,
      c.first_name,
      c.last_name,
      c.email_id,
      c.mobile_number,
      c.profile_completion,
      c.resume_path,
      c.candidate_status,
      c.candidate_source_code
    FROM rm_candidate_intake i
    JOIN cand_mstr c
      ON c.candidate_id = COALESCE(
        i.created_draft_id,
        CASE
          WHEN i.source_reference LIKE $1
          THEN NULLIF(
            substring(i.source_reference from 'portal-candidate:([0-9]+)'),
            ''
          )::integer
          ELSE NULL
        END
      )
    ${sourceJoin}
    WHERE (
      (
        i.source_reference LIKE $1
        AND i.review_status = 'SUBMITTED'
      )
      OR (
        i.parsing_status = 'COMPLETED'
        AND i.created_draft_id IS NOT NULL
        AND i.review_status = 'PENDING'
      )
    )
      AND UPPER(c.candidate_status) = 'DRAFT'
    ORDER BY i.created_on DESC
    `,
    [`${PORTAL_SOURCE_REFERENCE_PREFIX}%`]
  );

  return result.rows;
}

function calculateProfileCompletion(candidate = {}) {
  const fields = [
    candidate.first_name,
    candidate.last_name,
    candidate.email_id,
    candidate.mobile_number,
    candidate.resume_path,
    candidate.primary_skill,
    candidate.total_experience,
    candidate.current_company
  ];

  const filledCount = fields.filter((value) => {
    if (value === null || value === undefined) {
      return false;
    }

    return String(value).trim() !== "";
  }).length;

  return Math.round((filledCount / fields.length) * 100);
}

function mapParsedCandidateToProfile(parsedCandidate = {}) {
  const candidateName = String(
    parsedCandidate.candidate_name || parsedCandidate.name || ""
  ).trim();

  const nameParts = candidateName ? candidateName.split(/\s+/) : [];
  const fallbackFirstName = nameParts[0] || "";
  const fallbackLastName =
    nameParts.length > 1 ? nameParts.slice(1).join(" ") : "";

  const rawSkills = parsedCandidate.skills;
  const skills = Array.isArray(rawSkills)
    ? rawSkills.join(", ")
    : String(rawSkills || "");

  return {
    first_name: String(parsedCandidate.first_name || fallbackFirstName || ""),
    last_name: String(parsedCandidate.last_name || fallbackLastName || ""),
    email: String(parsedCandidate.email || parsedCandidate.email_id || ""),
    mobile: String(
      parsedCandidate.mobile || parsedCandidate.mobile_number || ""
    ),
    current_company: String(
      parsedCandidate.current_company || parsedCandidate.company || ""
    ),
    designation: String(parsedCandidate.designation || parsedCandidate.role || ""),
    experience: String(parsedCandidate.experience || ""),
    skills: String(skills || ""),
    education: String(parsedCandidate.education || "")
  };
}

function createCandidatePortalProfileService(pool, parserDeps) {
  const {
    uploadResumeToStorage,
    downloadResumeFromStorage,
    extractPdfText,
    parseBasicCandidateInfo,
    splitCandidateName,
    normalizeExperience,
    markIntakeParsingFailed
  } = parserDeps;

  async function resolvePortalSourceId() {
    try {
      const rmResult = await pool.query(
        `
        SELECT source_id
        FROM rm_candidate_sources
        WHERE source_code = $1
        LIMIT 1
        `,
        [PORTAL_SOURCE_CODE]
      );

      if (rmResult.rows.length > 0) {
        return String(rmResult.rows[0].source_id);
      }
    } catch (error) {
      if (!error.message?.includes("rm_candidate_sources")) {
        throw error;
      }
    }

    return PORTAL_SOURCE_CODE;
  }

  async function getOwnedCandidate(candidateId) {
    const result = await pool.query(
      `
      SELECT *
      FROM cand_mstr
      WHERE candidate_id = $1
      LIMIT 1
      `,
      [candidateId]
    );

    return result.rows[0] || null;
  }

  async function getOwnedIntake(intakeId, candidateId) {
    const result = await pool.query(
      `
      SELECT *
      FROM rm_candidate_intake
      WHERE intake_id = $1
        AND source_reference = $2
      LIMIT 1
      `,
      [intakeId, buildPortalSourceReference(candidateId)]
    );

    return result.rows[0] || null;
  }

  async function createProfileIntake(candidateId) {
    const candidate = await getOwnedCandidate(candidateId);

    if (!candidate) {
      return { ok: false, status: 404, message: "Candidate profile not found" };
    }

    if (String(candidate.candidate_status || "").toUpperCase() === "REGISTERED") {
      return {
        ok: false,
        status: 409,
        message: "Your profile is already registered with a recruiter."
      };
    }

    const sourceId = await resolvePortalSourceId();

    const result = await pool.query(
      `
      INSERT INTO rm_candidate_intake (
        source_id,
        source_reference,
        intake_status,
        parsing_status,
        review_status
      )
      VALUES ($1, $2, 'NEW', 'PENDING', 'PENDING')
      RETURNING *
      `,
      [sourceId, buildPortalSourceReference(candidateId)]
    );

    return {
      ok: true,
      data: result.rows[0]
    };
  }

  async function processProfileIntake(candidateId, intakeId, file) {
    if (!file) {
      return {
        ok: false,
        status: 400,
        message: "Resume file is required."
      };
    }

    const intake = await getOwnedIntake(intakeId, candidateId);

    if (!intake) {
      return {
        ok: false,
        status: 404,
        message: "Candidate intake record not found."
      };
    }

    const resumePath = await uploadResumeToStorage(file);

    const result = await pool.query(
      `
      UPDATE rm_candidate_intake
      SET
        resume_path = $1,
        original_file_name = $2,
        intake_status = 'RESUME_UPLOADED'
      WHERE intake_id = $3
      RETURNING intake_id, intake_status, original_file_name, resume_path
      `,
      [resumePath, file.originalname, intakeId]
    );

    return {
      ok: true,
      data: result.rows[0]
    };
  }

  async function applyParsedDataToCandidate(client, candidateId, parsedCandidate, resumePath) {
    const { first_name, last_name } = splitCandidateName(
      parsedCandidate.candidate_name
    );

    const skillsList = Array.isArray(parsedCandidate.skills)
      ? parsedCandidate.skills
      : [];

    const primarySkill =
      skillsList.length > 0 ? skillsList.join(", ") : null;

    const result = await client.query(
      `
      UPDATE cand_mstr
      SET
        first_name = COALESCE(NULLIF($1, ''), first_name),
        last_name = COALESCE(NULLIF($2, ''), last_name),
        mobile_number = COALESCE(NULLIF($3, ''), mobile_number),
        total_experience = COALESCE($4, total_experience),
        primary_skill = COALESCE(NULLIF($5, ''), primary_skill),
        resume_path = COALESCE($6, resume_path),
        resume_uploaded_on = CASE
          WHEN $6 IS NOT NULL THEN NOW()
          ELSE resume_uploaded_on
        END,
        updated_on = NOW()
      WHERE candidate_id = $7
        AND UPPER(candidate_status) = 'DRAFT'
      RETURNING *
      `,
      [
        first_name,
        last_name,
        parsedCandidate.mobile || null,
        normalizeExperience(parsedCandidate.experience),
        primarySkill,
        resumePath || null,
        candidateId
      ]
    );

    if (result.rows.length === 0) {
      throw new Error("Candidate profile cannot be updated in the current status.");
    }

    const profileCompletion = calculateProfileCompletion(result.rows[0]);

    const updated = await client.query(
      `
      UPDATE cand_mstr
      SET profile_completion = $1
      WHERE candidate_id = $2
      RETURNING *
      `,
      [profileCompletion, candidateId]
    );

    return updated.rows[0];
  }

  async function parseProfileIntake(candidateId, intakeId) {
    const intake = await getOwnedIntake(intakeId, candidateId);

    if (!intake) {
      return {
        ok: false,
        status: 404,
        message: "Candidate intake record not found."
      };
    }

    if (!intake.resume_path) {
      const errorMessage = "Resume path is not set for this intake record.";

      await markIntakeParsingFailed(intakeId, errorMessage);

      return {
        ok: false,
        status: 400,
        message: errorMessage
      };
    }

    const originalFileName = String(intake.original_file_name || "").toLowerCase();

    if (originalFileName && !originalFileName.endsWith(".pdf")) {
      const errorMessage = "Only PDF resume parsing is currently supported.";

      await markIntakeParsingFailed(intakeId, errorMessage);

      return {
        ok: false,
        status: 400,
        message: errorMessage
      };
    }

    let resumeBuffer;

    try {
      resumeBuffer = await downloadResumeFromStorage(intake.resume_path);
    } catch (downloadError) {
      const errorMessage =
        downloadError.message || "Failed to download resume from storage.";

      await markIntakeParsingFailed(intakeId, errorMessage);

      return {
        ok: false,
        status: 500,
        message: errorMessage
      };
    }

    let extractedText;

    try {
      extractedText = await extractPdfText(resumeBuffer);
    } catch (parseError) {
      const errorMessage =
        parseError.message || "Failed to extract text from resume PDF.";

      await markIntakeParsingFailed(intakeId, errorMessage);

      return {
        ok: false,
        status: 500,
        message: errorMessage
      };
    }

    const parsedCandidate = parseBasicCandidateInfo(extractedText);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const updatedCandidate = await applyParsedDataToCandidate(
        client,
        candidateId,
        parsedCandidate,
        intake.resume_path
      );

      const intakeUpdate = await client.query(
        `
        UPDATE rm_candidate_intake
        SET
          parsing_status = 'COMPLETED',
          error_message = NULL,
          created_draft_id = $1
        WHERE intake_id = $2
        RETURNING intake_id, parsing_status, created_draft_id, review_status
        `,
        [candidateId, intakeId]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        data: {
          intake_id: intakeUpdate.rows[0].intake_id,
          parsing_status: intakeUpdate.rows[0].parsing_status,
          draft_candidate_id: candidateId,
          parsed_candidate: parsedCandidate,
          profile: mapParsedCandidateToProfile({
            ...parsedCandidate,
            first_name: updatedCandidate.first_name,
            last_name: updatedCandidate.last_name,
            email: updatedCandidate.email_id,
            mobile: updatedCandidate.mobile_number,
            skills: updatedCandidate.primary_skill
          }),
          extracted_text: extractedText,
          profile_completion: Number(updatedCandidate.profile_completion || 0)
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function validateProfilePayload(profile = {}) {
    const errors = {};

    if (!String(profile.first_name || "").trim()) {
      errors.first_name = "First name is required.";
    }

    if (!String(profile.last_name || "").trim()) {
      errors.last_name = "Last name is required.";
    }

    const email = String(profile.email || profile.email_id || "").trim();
    const mobile = String(profile.mobile || profile.mobile_number || "").trim();

    if (!email && !mobile) {
      const contactMessage = "Enter email or mobile.";
      errors.email = contactMessage;
      errors.mobile = contactMessage;
    }

    return errors;
  }

  async function saveCandidateProfile(candidateId, profileInput = {}) {
    const candidate = await getOwnedCandidate(candidateId);

    if (!candidate) {
      return { ok: false, status: 404, message: "Candidate profile not found" };
    }

    if (String(candidate.candidate_status || "").toUpperCase() !== "DRAFT") {
      return {
        ok: false,
        status: 409,
        message: "Only draft candidate profiles can be updated."
      };
    }

    const validationErrors = validateProfilePayload(profileInput);

    if (Object.keys(validationErrors).length > 0) {
      return {
        ok: false,
        status: 400,
        message: "Profile validation failed",
        errors: validationErrors
      };
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const updateResult = await client.query(
        `
        UPDATE cand_mstr
        SET
          first_name = $1,
          last_name = $2,
          email_id = COALESCE(NULLIF($3, ''), email_id),
          mobile_number = COALESCE(NULLIF($4, ''), mobile_number),
          current_company = COALESCE(NULLIF($5, ''), current_company),
          current_designation = COALESCE(NULLIF($6, ''), current_designation),
          total_experience = COALESCE($7, total_experience),
          primary_skill = COALESCE(NULLIF($8, ''), primary_skill),
          updated_on = NOW()
        WHERE candidate_id = $9
          AND UPPER(candidate_status) = 'DRAFT'
        RETURNING *
        `,
        [
          String(profileInput.first_name || "").trim(),
          String(profileInput.last_name || "").trim(),
          String(profileInput.email || profileInput.email_id || "").trim(),
          String(profileInput.mobile || profileInput.mobile_number || "").trim(),
          String(profileInput.current_company || "").trim() || null,
          String(profileInput.designation || profileInput.current_designation || "").trim() || null,
          normalizeExperience(profileInput.experience ?? profileInput.total_experience),
          String(profileInput.skills || profileInput.primary_skill || "").trim() || null,
          candidateId
        ]
      );

      if (updateResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return {
          ok: false,
          status: 409,
          message: "Candidate profile cannot be saved in the current status."
        };
      }

      const profileCompletion = calculateProfileCompletion(updateResult.rows[0]);

      const finalCandidateResult = await client.query(
        `
        UPDATE cand_mstr
        SET profile_completion = $1
        WHERE candidate_id = $2
        RETURNING *
        `,
        [profileCompletion, candidateId]
      );

      await client.query(
        `
        UPDATE rm_candidate_intake
        SET review_status = 'SUBMITTED'
        WHERE source_reference = $1
        `,
        [buildPortalSourceReference(candidateId)]
      );

      await client.query(
        `
        UPDATE candidate_portal_account
        SET
          full_name = $1,
          mobile_number = COALESCE(NULLIF($2, ''), mobile_number),
          updated_on = NOW()
        WHERE candidate_id = $3
        `,
        [
          `${String(profileInput.first_name || "").trim()} ${String(profileInput.last_name || "").trim()}`.trim(),
          String(profileInput.mobile || profileInput.mobile_number || "").trim(),
          candidateId
        ]
      );

      await client.query("COMMIT");

      return {
        ok: true,
        data: {
          candidate: finalCandidateResult.rows[0],
          profile_completion: profileCompletion,
          profile_status: "Under Recruiter Review"
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function getCandidateProfile(candidateId) {
    const candidate = await getOwnedCandidate(candidateId);

    if (!candidate) {
      return { ok: false, status: 404, message: "Candidate profile not found" };
    }

    const intakeResult = await pool.query(
      `
      SELECT
        intake_id,
        review_status,
        parsing_status,
        intake_status,
        created_on
      FROM rm_candidate_intake
      WHERE source_reference = $1
      ORDER BY created_on DESC
      LIMIT 1
      `,
      [buildPortalSourceReference(candidateId)]
    );

    const latestIntake = intakeResult.rows[0] || null;

    return {
      ok: true,
      data: {
        candidate,
        profile: mapParsedCandidateToProfile({
          candidate_name: `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim(),
          first_name: candidate.first_name,
          last_name: candidate.last_name,
          email: candidate.email_id,
          mobile: candidate.mobile_number,
          current_company: candidate.current_company,
          designation: candidate.current_designation,
          experience: candidate.total_experience,
          skills: candidate.primary_skill
        }),
        intake: latestIntake,
        profile_completion: Number(candidate.profile_completion || 0)
      }
    };
  }

  async function listPortalReviewQueue() {
    return listIntakeReviewQueue(pool);
  }

  return {
    buildPortalSourceReference,
    parsePortalSourceReference,
    calculateProfileCompletion,
    mapParsedCandidateToProfile,
    createProfileIntake,
    processProfileIntake,
    parseProfileIntake,
    saveCandidateProfile,
    getCandidateProfile,
    listPortalReviewQueue,
    getOwnedIntake
  };
}

module.exports = {
  PORTAL_SOURCE_REFERENCE_PREFIX,
  listIntakeReviewQueue,
  createCandidatePortalProfileService,
  calculateProfileCompletion,
  mapParsedCandidateToProfile
};
