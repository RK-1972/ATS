/**
 * Release generated offers to the candidate portal — reuses enterprise releaseOffer lifecycle.
 */

const offerManagementService = require("./offerManagementService");
const { GENERATED_LETTER_STATUS } = require("../repositories/offerLetterRepository");

const MAX_SEARCH_RESULTS = 50;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeSearchTerm(value) {
  return String(value || "").trim();
}

function mapEligibleOfferRow(row) {
  return {
    offer_id: row.offer_id,
    requisition_code: row.requisition_code,
    candidate_id: row.candidate_id,
    candidate_name: row.candidate_name,
    candidate_code: row.candidate_code,
    position_title: row.position_title,
    offer_status: row.offer_status,
    offered_ctc: row.offered_ctc,
    currency: row.currency,
    letter_status: row.letter_status,
    letter_generated_on: row.generated_on,
    portal_released: String(row.offer_status) === "Released"
  };
}

async function searchPortalReleaseEligibleOffers(pool, req, { search = "" } = {}) {
  const term = normalizeSearchTerm(search);
  const params = [];
  let filterSql = "";

  if (term) {
    params.push(`%${term.toLowerCase()}%`);
    const idx = params.length;
    filterSql = `
      AND (
        LOWER(COALESCE(o.candidate_name, '')) LIKE $${idx}
        OR LOWER(COALESCE(c.candidate_code, '')) LIKE $${idx}
        OR LOWER(COALESCE(o.requisition_code, '')) LIKE $${idx}
        OR LOWER(COALESCE(o.offer_id, '')) LIKE $${idx}
        OR LOWER(COALESCE(o.position_title, '')) LIKE $${idx}
      )`;
  }

  params.push(GENERATED_LETTER_STATUS);
  const letterStatusParam = params.length;

  params.push(MAX_SEARCH_RESULTS);
  const limitParam = params.length;

  const result = await pool.query(
    `SELECT
       o.offer_id,
       o.requisition_code,
       o.candidate_id,
       o.candidate_name,
       o.position_title,
       o.offer_status,
       o.offered_ctc,
       o.currency,
       c.candidate_code,
       ol.status AS letter_status,
       ol.generated_on
     FROM om_offers o
     INNER JOIN om_offer_letters ol
       ON ol.offer_id = o.offer_id
      AND ol.status = $${letterStatusParam}
     LEFT JOIN cand_mstr c ON c.candidate_id = o.candidate_id
     WHERE o.offer_status IN ('Approved', 'Released')
       ${filterSql}
     ORDER BY ol.generated_on DESC NULLS LAST, o.offer_id ASC
     LIMIT $${limitParam}`,
    params
  );

  return (result.rows || []).map(mapEligibleOfferRow);
}

async function assertOfferLetterGenerated(client, offerId) {
  const letterResult = await client.query(
    `SELECT status
     FROM om_offer_letters
     WHERE offer_id = $1
     LIMIT 1`,
    [offerId]
  );

  const status = letterResult.rows[0]?.status;

  if (status !== GENERATED_LETTER_STATUS) {
    throw httpError(
      "Offer letter must be generated before release to the candidate portal.",
      400
    );
  }
}

async function releaseOfferToCandidatePortal(pool, offerId, req) {
  const normalizedOfferId = String(offerId || "").trim();

  if (!normalizedOfferId) {
    throw httpError("offer_id is required.", 400);
  }

  const client = await pool.connect();
  let offerStatus = null;

  try {
    await client.query("BEGIN");

    const preview = await client.query(
      `SELECT o.offer_id, o.offer_status, o.candidate_id
       FROM om_offers o
       WHERE o.offer_id = $1
       FOR UPDATE`,
      [normalizedOfferId]
    );

    if (!preview.rows[0]) {
      throw httpError(`Offer not found: ${normalizedOfferId}`, 404);
    }

    offerStatus = preview.rows[0].offer_status;

    await assertOfferLetterGenerated(client, normalizedOfferId);

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // preserve original
    }
    throw error;
  } finally {
    client.release();
  }

  if (String(offerStatus) === "Released") {
    const offer = await offerManagementService.getOfferRowForApprovalResponse(
      pool,
      normalizedOfferId
    );
    return {
      offer,
      toastMessage: "Offer is already released to the candidate portal.",
      alreadyReleased: true
    };
  }

  if (String(offerStatus) !== "Approved") {
    throw httpError(
      "Only fully approved offers with a generated letter can be released to the candidate portal.",
      400
    );
  }

  return offerManagementService.releaseOffer(
    pool,
    normalizedOfferId,
    {
      comment: String(req.body?.comment || "").trim() || "Released to candidate portal"
    },
    req,
    { skipReadAccessCheck: true }
  );
}

module.exports = {
  searchPortalReleaseEligibleOffers,
  releaseOfferToCandidatePortal,
  GENERATED_LETTER_STATUS
};
