const compensationService = require("./compensationService");
const compensationEngineService = require("./compensationEngineService");
const offerLetterRepository = require("../repositories/offerLetterRepository");
const offerLetterValidation = require("./offerLetterValidation");
const { userContext } = require("./enterpriseAuditService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function resolveStructureForOffer(pool, offerId) {
  const letter = await offerLetterRepository.findLetterByOfferId(pool, offerId);

  if (letter?.compensation_structure_id) {
    return compensationService.getStructureComponents(
      pool,
      letter.compensation_structure_id
    );
  }

  return compensationService.getDefaultStructureComponents(pool);
}

async function calculateOfferCompensation(pool, payload, req) {
  const offerId = String(payload?.offerId || payload?.offer_id || "").trim();
  const annualCtc = Number(payload?.annualCtc ?? payload?.annual_ctc ?? 0);

  if (!offerId) {
    throw httpError("offerId is required.", 400);
  }

  if (!annualCtc || annualCtc <= 0) {
    throw httpError("annualCtc must be greater than zero.", 400);
  }

  const offerRow = await offerLetterRepository.findOfferLetterDetail(pool, offerId);

  if (!offerRow) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  offerLetterValidation.assertOfferLetterWorkspaceEligible(offerRow);

  const { structure, components } = await resolveStructureForOffer(pool, offerId);
  const evaluation = compensationEngineService.evaluateStructure(
    annualCtc,
    structure,
    components
  );

  const letter = await offerLetterRepository.ensureAwaitingLetter(
    pool,
    offerId,
    offerRow.template_name || "Standard Offer Letter"
  );

  const actor = userContext(req);
  const calculatedBy = actor.name || actor.email_id || "system";

  const calculationMeta = await offerLetterRepository.replaceCtcComponents(
    pool,
    letter.letter_id,
    evaluation.rows.map((row, index) => ({
      component_name: row.componentName,
      amount: row.amount,
      display_order: row.displayOrder || index + 1
    })),
    calculatedBy
  );

  return {
    offerId,
    letterId: letter.letter_id,
    structureId: structure.structureId,
    structureName: structure.structureName,
    gross: evaluation.gross,
    totalCtc: evaluation.totalCtc,
    calculatedOn:
      calculationMeta?.compensation_calculated_on?.toISOString?.() ||
      calculationMeta?.compensation_calculated_on ||
      null,
    calculatedBy: calculationMeta?.compensation_calculated_by || calculatedBy,
    calculationTrace: evaluation.calculationTrace || [],
    components: evaluation.components.map((component) => ({
      componentName: component.componentName,
      componentCode: component.componentCode,
      componentCategory: component.componentCategory,
      formulaType: component.formulaType,
      formula: component.formula,
      amount: component.amount,
      displayOrder: component.displayOrder,
      includeInCtc: component.includeInCtc,
      includeInGross: component.includeInGross
    }))
  };
}

module.exports = {
  calculateOfferCompensation,
  resolveStructureForOffer
};
