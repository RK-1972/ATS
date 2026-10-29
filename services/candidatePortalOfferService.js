/**
 * Candidate portal — released offer summaries (read-only, Enhancement #3).
 */

const { GENERATED_LETTER_STATUS } = require("../repositories/offerLetterRepository");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function formatOfferDate(value) {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function mapPortalOfferSummary(row) {
  return {
    offer_id: row.offer_id,
    requisition_code: row.requisition_code,
    position_title: row.position_title,
    offered_ctc: row.offered_ctc != null ? Number(row.offered_ctc) : null,
    currency: row.currency || "INR",
    offer_date: formatOfferDate(row.offer_date)
  };
}

async function listReleasedOffersForCandidate(pool, candidateId) {
  const normalizedCandidateId = Number(candidateId);

  if (!Number.isFinite(normalizedCandidateId)) {
    throw httpError("candidate_id is required.", 400);
  }

  const result = await pool.query(
    `SELECT
       o.offer_id,
       o.requisition_code,
       o.position_title,
       o.offered_ctc,
       o.currency,
       ol.generated_on AS offer_date
     FROM om_offers o
     INNER JOIN om_offer_letters ol
       ON ol.offer_id = o.offer_id
      AND ol.status = $2
     WHERE o.candidate_id = $1
       AND o.offer_status = 'Released'
     ORDER BY ol.generated_on DESC NULLS LAST, o.offer_id ASC`,
    [normalizedCandidateId, GENERATED_LETTER_STATUS]
  );

  return (result.rows || []).map(mapPortalOfferSummary);
}

async function getReleasedOfferForCandidate(pool, candidateId, offerId) {
  const normalizedCandidateId = Number(candidateId);
  const normalizedOfferId = String(offerId || "").trim();

  if (!Number.isFinite(normalizedCandidateId) || !normalizedOfferId) {
    throw httpError("Offer not found.", 404);
  }

  const result = await pool.query(
    `SELECT
       o.offer_id,
       o.requisition_code,
       o.position_title,
       o.offered_ctc,
       o.currency,
       ol.generated_on AS offer_date
     FROM om_offers o
     INNER JOIN om_offer_letters ol
       ON ol.offer_id = o.offer_id
      AND ol.status = $3
     WHERE o.candidate_id = $1
       AND o.offer_id = $2
       AND o.offer_status = 'Released'
     LIMIT 1`,
    [normalizedCandidateId, normalizedOfferId, GENERATED_LETTER_STATUS]
  );

  if (!result.rows[0]) {
    throw httpError("Offer not found.", 404);
  }

  return mapPortalOfferSummary(result.rows[0]);
}

module.exports = {
  listReleasedOffersForCandidate,
  getReleasedOfferForCandidate
};
