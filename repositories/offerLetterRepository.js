const PENDING_LETTER_STATUSES = ["Awaiting Letter"];

const GENERATED_LETTER_STATUS = "Letter Generated";

const BASE_OFFER_SELECT = `
  o.offer_id,
  o.requisition_code,
  o.candidate_name,
  o.position_title,
  o.department,
  o.business_unit,
  o.location,
  o.offered_ctc,
  o.currency,
  o.offer_status,
  o.hiring_manager,
  o.recruiter_id,
  o.valid_until,
  o.expected_joining_date,
  o.variable_pay,
  o.variable_pay_frequency,
  o.joining_bonus,
  o.joining_bonus_frequency,
  ol.letter_id,
  ol.template_name,
  ol.status AS letter_status,
  ol.pdf_path,
  ol.generated_by,
  ol.generated_on,
  ol.compensation_calculated_on,
  ol.compensation_calculated_by,
  (
    SELECT MAX(a.approved_on)
    FROM om_offer_approvals a
    WHERE a.offer_id = o.offer_id
      AND LOWER(a.approval_status) = 'approved'
  ) AS approved_date,
  (
    SELECT u.full_name
    FROM user_mstr u
    WHERE u.employee_code = o.recruiter_id
    LIMIT 1
  ) AS recruiter_name
`;

const BASE_FROM = `
  FROM om_offers o
  LEFT JOIN om_offer_letters ol ON ol.offer_id = o.offer_id
`;

async function findPendingLetters(pool) {
  const result = await pool.query(
    `SELECT ${BASE_OFFER_SELECT}
     ${BASE_FROM}
     WHERE ol.status = ANY($1::text[])
     ORDER BY approved_date DESC NULLS LAST, o.offer_id ASC`,
    [PENDING_LETTER_STATUSES]
  );

  return result.rows;
}

async function findGeneratedLetters(pool) {
  const result = await pool.query(
    `SELECT ${BASE_OFFER_SELECT}
     ${BASE_FROM}
     WHERE ol.status = $1
     ORDER BY ol.generated_on DESC NULLS LAST, o.offer_id ASC`,
    [GENERATED_LETTER_STATUS]
  );

  return result.rows;
}

async function findOfferLetterDetail(pool, offerId) {
  const result = await pool.query(
    `SELECT ${BASE_OFFER_SELECT}
     ${BASE_FROM}
     WHERE o.offer_id = $1`,
    [offerId]
  );

  return result.rows[0] || null;
}

async function findCtcComponents(pool, letterId) {
  const result = await pool.query(
    `SELECT component_name, amount, display_order
     FROM om_offer_letter_ctc
     WHERE letter_id = $1
     ORDER BY display_order ASC, ctc_id ASC`,
    [letterId]
  );

  return result.rows;
}

async function findLetterByOfferId(pool, offerId) {
  const result = await pool.query(
    `SELECT *
     FROM om_offer_letters
     WHERE offer_id = $1`,
    [offerId]
  );

  return result.rows[0] || null;
}

async function insertLetter(pool, letterRow) {
  const result = await pool.query(
    `INSERT INTO om_offer_letters (
       letter_id,
       offer_id,
       template_name,
       status,
       created_on,
       modified_on
     ) VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING *`,
    [
      letterRow.letter_id,
      letterRow.offer_id,
      letterRow.template_name,
      letterRow.status
    ]
  );

  return result.rows[0];
}

async function replaceCtcComponents(pool, letterId, components, calculatedBy = null) {
  await pool.query(
    `DELETE FROM om_offer_letter_ctc WHERE letter_id = $1`,
    [letterId]
  );

  for (const component of components) {
    await pool.query(
      `INSERT INTO om_offer_letter_ctc (
         letter_id,
         component_name,
         amount,
         display_order
       ) VALUES ($1, $2, $3, $4)`,
      [
        letterId,
        component.component_name,
        component.amount,
        component.display_order
      ]
    );
  }

  if (!components.length) {
    await pool.query(
      `UPDATE om_offer_letters
       SET compensation_calculated_on = NULL,
           compensation_calculated_by = NULL,
           modified_on = NOW()
       WHERE letter_id = $1`,
      [letterId]
    );
    return null;
  }

  const result = await pool.query(
    `UPDATE om_offer_letters
     SET compensation_calculated_on = NOW(),
         compensation_calculated_by = $2,
         modified_on = NOW()
     WHERE letter_id = $1
     RETURNING compensation_calculated_on, compensation_calculated_by`,
    [letterId, calculatedBy || null]
  );

  return result.rows[0] || null;
}

async function hasCalculatedBreakup(pool, offerId) {
  const letter = await findLetterByOfferId(pool, offerId);

  if (!letter?.letter_id) {
    return false;
  }

  const components = await findCtcComponents(pool, letter.letter_id);
  return components.length > 0;
}

async function ensureAwaitingLetter(pool, offerId, templateName = "Standard Offer Letter") {
  const existing = await findLetterByOfferId(pool, offerId);

  if (existing) {
    return existing;
  }

  return insertLetter(pool, {
    letter_id: `OL-${offerId}`,
    offer_id: offerId,
    template_name: templateName,
    status: "Awaiting Letter"
  });
}

async function markLetterGenerated(pool, letterId, generatedBy) {
  const result = await pool.query(
    `UPDATE om_offer_letters
     SET status = $2,
         generated_by = $3,
         generated_on = NOW(),
         generation_in_progress = FALSE,
         modified_on = NOW()
     WHERE letter_id = $1
     RETURNING *`,
    [letterId, GENERATED_LETTER_STATUS, generatedBy]
  );

  return result.rows[0];
}

async function acquireGenerationLock(pool, offerId) {
  const result = await pool.query(
    `UPDATE om_offer_letters
     SET generation_in_progress = TRUE,
         generation_started_on = NOW(),
         modified_on = NOW()
     WHERE offer_id = $1
       AND status = $2
       AND generation_in_progress = FALSE
     RETURNING *`,
    [offerId, "Awaiting Letter"]
  );

  if (result.rows[0]) {
    return result.rows[0];
  }

  const existing = await findLetterByOfferId(pool, offerId);

  if (existing?.generation_in_progress) {
    const error = new Error("Offer Letter generation already in progress.");
    error.status = 409;
    throw error;
  }

  return null;
}

async function releaseGenerationLock(pool, offerId) {
  await pool.query(
    `UPDATE om_offer_letters
     SET generation_in_progress = FALSE,
         modified_on = NOW()
     WHERE offer_id = $1
       AND status = $2`,
    [offerId, "Awaiting Letter"]
  );
}

module.exports = {
  PENDING_LETTER_STATUSES,
  GENERATED_LETTER_STATUS,
  findPendingLetters,
  findGeneratedLetters,
  findOfferLetterDetail,
  findCtcComponents,
  findLetterByOfferId,
  insertLetter,
  replaceCtcComponents,
  hasCalculatedBreakup,
  ensureAwaitingLetter,
  markLetterGenerated,
  acquireGenerationLock,
  releaseGenerationLock
};
