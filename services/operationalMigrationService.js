const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { REQUISITION_STATUS } = require("../constants/requisitionStatus");

const MIGRATION_MARKER = "operational-consolidation-v1";
const STATE_PATH = path.join(__dirname, "..", "migration", "operational-migration-state.json");

function requisitionCodeFromLegacy(row) {
  const code = String(row.req_code || "").trim();
  if (code) {
    return code;
  }

  return `REQ-LEG-${row.req_id}`;
}

function interviewIdFromLegacy(row) {
  return `INT-LEG-${row.schedule_id}`;
}

function checksumFromRows(rows, key) {
  const payload = rows
    .map((row) => String(row[key]))
    .sort()
    .join("|");

  return crypto.createHash("md5").update(payload).digest("hex");
}

const RATING_LABEL_TO_VALUE = {
  poor: 2,
  average: 3,
  good: 4,
  excellent: 5
};

const RATING_VALUE_TO_LABEL = {
  2: "Poor",
  3: "Average",
  4: "Good",
  5: "Excellent"
};

function normalizeRating(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  return RATING_LABEL_TO_VALUE[String(value).trim().toLowerCase()] ?? null;
}

/**
 * Map enterprise numeric overall_rating back to the UI business label.
 * Inverse of normalizeRating — same rating contract, read path only.
 */
function formatRatingLabel(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && RATING_VALUE_TO_LABEL[numeric]) {
    return RATING_VALUE_TO_LABEL[numeric];
  }

  const asLabel = String(value).trim();
  if (RATING_LABEL_TO_VALUE[asLabel.toLowerCase()] != null) {
    return asLabel.charAt(0).toUpperCase() + asLabel.slice(1).toLowerCase();
  }

  return asLabel;
}

async function tableExists(pool, tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function migrateRequisitions(client) {
  const legacy = await client.query(
    `SELECT * FROM req_mstr ORDER BY req_id ASC`
  );

  let inserted = 0;
  let updated = 0;

  for (const row of legacy.rows) {
    const requisitionCode = requisitionCodeFromLegacy(row);

    const existing = await client.query(
      `SELECT requisition_code FROM rm_requisitions
       WHERE requisition_code = $1 OR req_id = $2`,
      [requisitionCode, row.req_id]
    );

    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE rm_requisitions SET
          req_id = COALESCE(req_id, $2),
          position_title = $3,
          department = COALESCE(NULLIF(department, ''), $4),
          business_unit = $5,
          location = $6,
          headcount = $7,
          primary_skill = $8,
          req_status = $9,
          hiring_manager = $10,
          employment_type = $11,
          created_by = COALESCE(created_by, $12),
          created_on = LEAST(created_on, $13),
          modified_on = GREATEST(modified_on, $14),
          modified_by = COALESCE(modified_by, $12)
         WHERE requisition_code = $1`,
        [
          existing.rows[0].requisition_code,
          row.req_id,
          row.job_title,
          row.project_name || row.client_name || "General",
          row.client_name,
          row.work_location,
          row.openings_count || 1,
          row.primary_skill,
          row.req_status || REQUISITION_STATUS.OPEN,
          row.hiring_manager,
          row.employment_type,
          row.created_by,
          row.created_on,
          row.updated_on || row.created_on
        ]
      );
      updated += 1;
      continue;
    }

    await client.query(
      `INSERT INTO rm_requisitions (
        requisition_code, req_id, position_title, grade, department, business_unit,
        location, budget_approved, hiring_manager, employment_type, headcount,
        primary_skill, req_status, version, version_status, effective_from,
        created_by, modified_by, created_on, modified_on
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        requisitionCode,
        row.req_id,
        row.job_title,
        null,
        row.project_name || row.client_name || "General",
        row.client_name,
        row.work_location,
        0,
        row.hiring_manager,
        row.employment_type || "Full-time",
        row.openings_count || 1,
        row.primary_skill,
        row.req_status || REQUISITION_STATUS.OPEN,
        1.0,
        "Published",
        row.created_on,
        row.created_by,
        row.created_by,
        row.created_on,
        row.updated_on || row.created_on
      ]
    );
    inserted += 1;
  }

  return { legacyCount: legacy.rows.length, inserted, updated };
}

async function migrateRecruiterAssignments(client) {
  const legacy = await client.query(
    `SELECT * FROM req_recruiter_map ORDER BY map_id ASC`
  );

  let inserted = 0;
  let skipped = 0;

  for (const row of legacy.rows) {
    const req = await client.query(
      `SELECT requisition_code FROM rm_requisitions WHERE req_id = $1 LIMIT 1`,
      [row.req_id]
    );

    if (!req.rows.length) {
      skipped += 1;
      continue;
    }

    const requisitionCode = req.rows[0].requisition_code;

    const duplicate = await client.query(
      `SELECT assignment_id FROM rm_recruiter_assignments
       WHERE requisition_code = $1 AND recruiter_code = $2
         AND is_active = $3 AND assigned_on = $4`,
      [requisitionCode, row.recruiter_code, row.is_active !== false, row.assigned_on]
    );

    if (duplicate.rows.length) {
      skipped += 1;
      continue;
    }

    await client.query(
      `INSERT INTO rm_recruiter_assignments (
        requisition_code, req_id, recruiter_code, assigned_by, is_active,
        version, version_status, effective_from, assigned_on, modified_on
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        requisitionCode,
        row.req_id,
        row.recruiter_code,
        row.assigned_by,
        row.is_active !== false,
        1.0,
        "Published",
        row.assigned_on,
        row.assigned_on,
        row.assigned_on
      ]
    );
    inserted += 1;
  }

  return { legacyCount: legacy.rows.length, inserted, skipped };
}

async function migrateCandidateMappings(client) {
  const legacy = await client.query(
    `SELECT * FROM candidate_req_map ORDER BY map_id ASC`
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of legacy.rows) {
    const req = await client.query(
      `SELECT requisition_code FROM rm_requisitions WHERE req_id = $1 LIMIT 1`,
      [row.req_id]
    );

    if (!req.rows.length) {
      skipped += 1;
      continue;
    }

    const requisitionCode = req.rows[0].requisition_code;

    const existing = await client.query(
      `SELECT mapping_id FROM rm_candidate_mappings WHERE map_id = $1`,
      [row.map_id]
    );

    if (existing.rows.length) {
      await client.query(
        `UPDATE rm_candidate_mappings SET
          candidate_id = $2,
          requisition_code = $3,
          req_id = $4,
          recruiter_id = $5,
          stage_name = $6,
          source_type = $7,
          remarks = $8,
          is_active = $9,
          applied_on = LEAST(applied_on, $10),
          modified_on = GREATEST(modified_on, $11)
         WHERE map_id = $1`,
        [
          row.map_id,
          row.candidate_id,
          requisitionCode,
          row.req_id,
          row.recruiter_id,
          row.stage_name || "Applied",
          row.source_type,
          row.remarks,
          row.is_active !== false,
          row.applied_date || row.updated_on,
          row.updated_on || row.applied_date
        ]
      );
      updated += 1;
      continue;
    }

    await client.query(
      `INSERT INTO rm_candidate_mappings (
        candidate_id, requisition_code, req_id, map_id, recruiter_id,
        stage_name, source_type, remarks, is_active, version, version_status,
        effective_from, applied_on, modified_on
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        row.candidate_id,
        requisitionCode,
        row.req_id,
        row.map_id,
        row.recruiter_id,
        row.stage_name || "Applied",
        row.source_type,
        row.remarks,
        row.is_active !== false,
        1.0,
        "Published",
        row.applied_date || row.updated_on,
        row.applied_date || row.updated_on,
        row.updated_on || row.applied_date
      ]
    );
    inserted += 1;
  }

  return { legacyCount: legacy.rows.length, inserted, updated, skipped };
}

async function migrateInterviews(client) {
  const legacy = await client.query(
    `SELECT * FROM interview_schedule_trn ORDER BY schedule_id ASC`
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of legacy.rows) {
    const mapping = await client.query(
      `SELECT candidate_id, requisition_code, req_id
       FROM rm_candidate_mappings WHERE map_id = $1 LIMIT 1`,
      [row.map_id]
    );

    const interviewId = interviewIdFromLegacy(row);
    const candidateId = mapping.rows[0]?.candidate_id || null;
    const requisitionCode = mapping.rows[0]?.requisition_code || null;
    const reqId = mapping.rows[0]?.req_id || row.req_id || null;

    const existing = await client.query(
      `SELECT interview_id FROM im_interviews WHERE schedule_id = $1 OR interview_id = $2`,
      [row.schedule_id, interviewId]
    );

    if (existing.rows.length) {
      await client.query(
        `UPDATE im_interviews SET
          map_id = $2,
          req_id = $3,
          requisition_code = $4,
          candidate_id = COALESCE(candidate_id, $5),
          round_no = $6,
          round_type = $7,
          interview_date = $8,
          interview_time = $9,
          interview_status = $10,
          meeting_link = $11,
          teams_event_id = $12,
          remarks = $13,
          feedback_submitted = $14,
          created_by = COALESCE(created_by, $15),
          created_on = LEAST(created_on, $16),
          modified_on = GREATEST(modified_on, $17)
         WHERE interview_id = $1`,
        [
          existing.rows[0].interview_id,
          row.map_id,
          reqId,
          requisitionCode,
          candidateId,
          row.round_no || 1,
          row.round_type,
          row.interview_date,
          row.interview_time,
          row.interview_status || "Scheduled",
          row.meeting_link,
          row.teams_event_id,
          row.remarks,
          row.feedback_submitted === true,
          row.created_by,
          row.created_on,
          row.updated_on || row.created_on
        ]
      );
      updated += 1;
      continue;
    }

    if (!mapping.rows.length) {
      skipped += 1;
      continue;
    }

    await client.query(
      `INSERT INTO im_interviews (
        interview_id, schedule_id, map_id, req_id, requisition_code, candidate_id,
        round_no, round_type, interview_date, interview_time, interview_status,
        meeting_link, teams_event_id, remarks, feedback_submitted,
        version, version_status, effective_from, created_by, modified_by,
        created_on, modified_on
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        interviewId,
        row.schedule_id,
        row.map_id,
        reqId,
        requisitionCode,
        candidateId,
        row.round_no || 1,
        row.round_type,
        row.interview_date,
        row.interview_time,
        row.interview_status || "Scheduled",
        row.meeting_link,
        row.teams_event_id,
        row.remarks,
        row.feedback_submitted === true,
        1.0,
        "Published",
        row.created_on,
        row.created_by,
        row.created_by,
        row.created_on,
        row.updated_on || row.created_on
      ]
    );
    inserted += 1;
  }

  return { legacyCount: legacy.rows.length, inserted, updated, skipped };
}

async function migrateInterviewFeedback(client) {
  const legacy = await client.query(
    `SELECT h.*, i.interview_id
     FROM interview_feedback_hdr h
     LEFT JOIN im_interviews i ON i.schedule_id = h.schedule_id
     ORDER BY h.feedback_id ASC`
  );

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of legacy.rows) {
    if (!row.interview_id) {
      skipped += 1;
      continue;
    }

    const details = await client.query(
      `SELECT skill_name, rating, comments FROM interview_feedback_dtl WHERE feedback_id = $1`,
      [row.feedback_id]
    );

    const skills = details.rows.map((item) => ({
      skill_name: item.skill_name,
      rating: normalizeRating(item.rating),
      comments: item.comments
    }));

    const overallRating = normalizeRating(row.overall_rating);

    const existing = await client.query(
      `SELECT feedback_id FROM im_feedback WHERE schedule_id = $1`,
      [row.schedule_id]
    );

    if (existing.rows.length) {
      await client.query(
        `UPDATE im_feedback SET
          interview_id = $2,
          interview_level = $3,
          area_of_interview = $4,
          overall_rating = $5,
          strengths = $6,
          improvement_areas = $7,
          overall_comments = $8,
          final_outcome = $9,
          skills = $10::jsonb,
          feedback_status = $11,
          submitted_by = $12,
          submitted_on = $13
         WHERE feedback_id = $1`,
        [
          existing.rows[0].feedback_id,
          row.interview_id,
          row.interview_level,
          row.area_of_interview,
          overallRating,
          row.strengths,
          row.improvement_areas,
          row.overall_comments,
          row.final_outcome,
          JSON.stringify(skills),
          row.feedback_status || "Submitted",
          row.submitted_by,
          row.submitted_on
        ]
      );
      updated += 1;
      continue;
    }

    await client.query(
      `INSERT INTO im_feedback (
        interview_id, schedule_id, interview_level, area_of_interview, overall_rating,
        strengths, improvement_areas, overall_comments, final_outcome, skills,
        feedback_status, submitted_by, submitted_on, version, version_status, effective_from
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)`,
      [
        row.interview_id,
        row.schedule_id,
        row.interview_level,
        row.area_of_interview,
        overallRating,
        row.strengths,
        row.improvement_areas,
        row.overall_comments,
        row.final_outcome,
        JSON.stringify(skills),
        row.feedback_status || "Submitted",
        row.submitted_by,
        row.submitted_on,
        1.0,
        "Published",
        row.submitted_on
      ]
    );
    inserted += 1;
  }

  return { legacyCount: legacy.rows.length, inserted, updated, skipped };
}

async function runOperationalMigration(pool) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const results = {
      marker: MIGRATION_MARKER,
      migratedAt: new Date().toISOString(),
      requisitions: await migrateRequisitions(client),
      recruiterAssignments: await migrateRecruiterAssignments(client),
      candidateMappings: await migrateCandidateMappings(client),
      interviews: await migrateInterviews(client),
      interviewFeedback: await migrateInterviewFeedback(client)
    };

    await client.query("COMMIT");

    const stateDir = path.dirname(STATE_PATH);
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    fs.writeFileSync(STATE_PATH, JSON.stringify(results, null, 2));

    return results;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function validateOperationalMigration(pool) {
  const validations = [];

  async function pushResult(entity, legacySql, enterpriseSql, legacyKey, enterpriseKey) {
    const legacy = await pool.query(legacySql);
    const enterprise = await pool.query(enterpriseSql);

    const legacyCount = Number(legacy.rows[0]?.count || 0);
    const enterpriseCount = Number(enterprise.rows[0]?.count || 0);
    const legacyChecksum = legacy.rows[0]?.checksum || null;
    const enterpriseChecksum = enterprise.rows[0]?.checksum || null;

    const countPass = legacyCount === enterpriseCount;
    const checksumPass = !legacyChecksum || !enterpriseChecksum || legacyChecksum === enterpriseChecksum;

    validations.push({
      entity,
      legacyCount,
      enterpriseCount,
      legacyChecksum,
      enterpriseChecksum,
      integrity: countPass && checksumPass ? "PASS" : "FAIL",
      status: countPass && checksumPass ? "PASS" : "FAIL"
    });
  }

  await pushResult(
    "Requisitions",
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(req_id::text, '|' ORDER BY req_id)) AS checksum
     FROM req_mstr`,
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(COALESCE(req_id::text, requisition_code), '|' ORDER BY req_id, requisition_code)) AS checksum
     FROM rm_requisitions
     WHERE req_id IS NOT NULL`,
    "req_id",
    "req_id"
  );

  await pushResult(
    "Recruiter Assignments",
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(req_id::text || ':' || recruiter_code, '|' ORDER BY req_id, recruiter_code)) AS checksum
     FROM req_recruiter_map WHERE is_active = true`,
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(req_id::text || ':' || recruiter_code, '|' ORDER BY req_id, recruiter_code)) AS checksum
     FROM rm_recruiter_assignments WHERE is_active = true AND req_id IS NOT NULL`,
    "req_id",
    "req_id"
  );

  await pushResult(
    "Candidate Mapping",
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(map_id::text, '|' ORDER BY map_id)) AS checksum
     FROM candidate_req_map WHERE is_active = true`,
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(map_id::text, '|' ORDER BY map_id)) AS checksum
     FROM rm_candidate_mappings WHERE is_active = true`,
    "map_id",
    "map_id"
  );

  await pushResult(
    "Interview Scheduling",
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(schedule_id::text, '|' ORDER BY schedule_id)) AS checksum
     FROM interview_schedule_trn`,
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(schedule_id::text, '|' ORDER BY schedule_id)) AS checksum
     FROM im_interviews
     WHERE schedule_id IN (SELECT schedule_id FROM interview_schedule_trn)`,
    "schedule_id",
    "schedule_id"
  );

  await pushResult(
    "Interview Feedback",
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(schedule_id::text, '|' ORDER BY schedule_id)) AS checksum
     FROM interview_feedback_hdr WHERE schedule_id IS NOT NULL`,
    `SELECT COUNT(*)::int AS count,
            MD5(string_agg(schedule_id::text, '|' ORDER BY schedule_id)) AS checksum
     FROM im_feedback WHERE schedule_id IS NOT NULL`,
    "schedule_id",
    "schedule_id"
  );

  const allPass = validations.every((item) => item.status === "PASS");

  return {
    validatedAt: new Date().toISOString(),
    allPass,
    validations
  };
}

async function rollbackOperationalMigration(pool) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`DELETE FROM im_feedback WHERE schedule_id IS NOT NULL`);
    await client.query(`DELETE FROM im_interviews WHERE schedule_id IS NOT NULL`);
    await client.query(
      `DELETE FROM rm_candidate_mappings
       WHERE map_id IN (SELECT map_id FROM candidate_req_map)`
    );
    await client.query(
      `DELETE FROM rm_recruiter_assignments
       WHERE req_id IN (SELECT req_id FROM req_mstr)`
    );
    await client.query(
      `DELETE FROM rm_requisitions
       WHERE req_id IN (SELECT req_id FROM req_mstr)`
    );

    await client.query("COMMIT");

    if (fs.existsSync(STATE_PATH)) {
      fs.unlinkSync(STATE_PATH);
    }

    return { rolledBackAt: new Date().toISOString(), marker: MIGRATION_MARKER };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MIGRATION_MARKER,
  STATE_PATH,
  requisitionCodeFromLegacy,
  interviewIdFromLegacy,
  normalizeRating,
  formatRatingLabel,
  runOperationalMigration,
  validateOperationalMigration,
  rollbackOperationalMigration,
  tableExists
};
