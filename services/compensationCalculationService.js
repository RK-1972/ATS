const compensationService = require("./compensationService");
const compensationEngineService = require("./compensationEngineService");
const compensationLetterBridgeService = require("./compensationLetterBridgeService");
const offerLetterRepository = require("../repositories/offerLetterRepository");
const offerLetterValidation = require("./offerLetterValidation");
const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");

function getAssertOfferReadAccess() {
  return require("./offerManagementService").assertOfferReadAccess;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function amountsMatch(left, right, tolerance = 0.01) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
}

function resolveAuthoritativeAnnualCtc(offerRow, requestedAnnualCtc) {
  const offeredCtc = Number(offerRow?.offered_ctc || 0);
  const requested = Number(requestedAnnualCtc || 0);

  if (!offeredCtc || offeredCtc <= 0) {
    throw httpError("Approved offer CTC is required before calculating compensation.", 400);
  }

  if (!requested || requested <= 0) {
    return offeredCtc;
  }

  if (!amountsMatch(offeredCtc, requested)) {
    throw httpError(
      "Requested annual CTC must match the approved offer CTC on the server.",
      400
    );
  }

  return offeredCtc;
}

function hasCompleteCompensationMetadata(letter) {
  return Boolean(
    letter?.compensation_snapshot &&
      letter?.compensation_annual_ctc != null &&
      letter?.compensation_structure_id
  );
}

async function assertOfferCompensationAccess(pool, req, offerId) {
  await getAssertOfferReadAccess()(pool, req, offerId);
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

async function evaluateAndPersistOfferCompensation(pool, offerId, annualCtc, req, options = {}) {
  const skipPersistedReuse = Boolean(options.skipPersistedReuse);

  if (!offerId) {
    throw httpError("offerId is required.", 400);
  }

  await assertOfferCompensationAccess(pool, req, offerId);

  const offerRow = await offerLetterRepository.findOfferLetterDetail(pool, offerId);

  if (!offerRow) {
    throw httpError(`Offer not found: ${offerId}`, 404);
  }

  offerLetterValidation.assertOfferLetterWorkspaceEligible(offerRow);

  const authoritativeAnnualCtc = resolveAuthoritativeAnnualCtc(offerRow, annualCtc);

  const letter = await offerLetterRepository.findLetterByOfferId(pool, offerId);

  if (letter?.compensation_locked) {
    throw httpError(
      "Compensation is locked for this issued offer letter. Submit an approved offer amendment before changing the CTC breakup.",
      409
    );
  }

  const existingRows =
    letter?.letter_id
      ? await offerLetterRepository.findCtcComponents(pool, letter.letter_id)
      : [];

  const canReusePersisted =
    !skipPersistedReuse &&
    existingRows.length > 0 &&
    hasCompleteCompensationMetadata(letter) &&
    amountsMatch(letter.compensation_annual_ctc, authoritativeAnnualCtc);

  if (canReusePersisted) {
    const aggregated = compensationLetterBridgeService.aggregatePersistedLetterRows(
      existingRows,
      "Compensation Engine (persisted)"
    );

    return {
      offerId,
      letterId: letter.letter_id,
      structureId: letter.compensation_structure_id,
      reusedPersisted: true,
      gross: aggregated.gross,
      totalCtc: aggregated.totalCtc,
      calculatedOn: letter.compensation_calculated_on,
      calculatedBy: letter.compensation_calculated_by,
      components: aggregated.ctcBreakup,
      salaryBreakup: aggregated.salaryBreakup
    };
  }

  const { structure, components } = await resolveStructureForOffer(pool, offerId);
  const evaluation = compensationEngineService.evaluateStructure(
    authoritativeAnnualCtc,
    structure,
    components
  );

  const awaitingLetter = await offerLetterRepository.ensureAwaitingLetter(
    pool,
    offerId,
    offerRow.template_name || "Standard Offer Letter"
  );

  const actor = userContext(req);
  const calculatedBy = actor.name || actor.email_id || "system";
  const persistedRows = compensationLetterBridgeService.mapEvaluationToPersistedRows(
    evaluation
  );
  const snapshot = compensationLetterBridgeService.buildSnapshotPayload(
    structure,
    components,
    evaluation,
    authoritativeAnnualCtc
  );

  await offerLetterRepository.replaceCtcComponents(
    pool,
    awaitingLetter.letter_id,
    persistedRows,
    calculatedBy,
    {
      structureId: structure.structureId,
      annualCtc: authoritativeAnnualCtc,
      snapshot,
      compensationLocked: false
    }
  );

  const salaryBreakup =
    compensationLetterBridgeService.buildSalaryBreakupFromEvaluation(evaluation);

  await writeEnterpriseAudit(pool, {
    eventType: "OFFER_COMPENSATION_CALCULATED",
    module: "Offer Management",
    entity: "om_offer_letters",
    entityId: awaitingLetter.letter_id,
    action: skipPersistedReuse
      ? "Recalculated offer compensation breakup"
      : "Calculated offer compensation breakup",
    previousValue: null,
    newValue: JSON.stringify({
      offer_id: offerId,
      structure_id: structure.structureId,
      annual_ctc: authoritativeAnnualCtc,
      total_ctc: evaluation.totalCtc
    }),
    userName: actor.name,
    userRole: actor.role
  });

  return {
    offerId,
    letterId: awaitingLetter.letter_id,
    structureId: structure.structureId,
    structureName: structure.structureName,
    reusedPersisted: false,
    gross: evaluation.gross,
    totalCtc: evaluation.totalCtc,
    calculatedOn: new Date().toISOString(),
    calculatedBy,
    calculationTrace: evaluation.calculationTrace || [],
    components: evaluation.components.map((component) => ({
      componentName: compensationLetterBridgeService.resolveLetterDisplayName(
        component
      ),
      componentCode: component.componentCode,
      componentCategory: component.componentCategory,
      formulaType: component.formulaType,
      formula: component.formula,
      amount: component.amount,
      displayOrder: component.displayOrder,
      includeInCtc: component.includeInCtc,
      includeInGross: component.includeInGross
    })),
    salaryBreakup
  };
}

async function calculateOfferCompensation(pool, payload, req) {
  const offerId = String(payload?.offerId || payload?.offer_id || "").trim();
  const annualCtc = Number(payload?.annualCtc ?? payload?.annual_ctc ?? 0);
  const skipPersistedReuse = Boolean(
    payload?.recalculate ?? payload?.skipPersistedReuse
  );

  return evaluateAndPersistOfferCompensation(pool, offerId, annualCtc, req, {
    skipPersistedReuse
  });
}

async function ensureOfferCompensationForGeneration(pool, offerId, req) {
  await assertOfferCompensationAccess(pool, req, offerId);

  const offerRow = await offerLetterRepository.findOfferLetterDetail(pool, offerId);
  const annualCtc = Number(offerRow?.offered_ctc || 0);

  if (!annualCtc || annualCtc <= 0) {
    throw httpError("Approved offer CTC is required before generating the offer letter.", 400);
  }

  const letter = await offerLetterRepository.findLetterByOfferId(pool, offerId);

  if (letter?.compensation_locked) {
    const existingRows = letter?.letter_id
      ? await offerLetterRepository.findCtcComponents(pool, letter.letter_id)
      : [];

    if (!existingRows.length) {
      throw httpError(
        "Locked offer letter is missing persisted compensation breakup.",
        409
      );
    }

    const aggregated = compensationLetterBridgeService.aggregatePersistedLetterRows(
      existingRows
    );

    return {
      ...aggregated,
      letterId: letter.letter_id,
      reusedPersisted: true
    };
  }

  const existingRows =
    letter?.letter_id
      ? await offerLetterRepository.findCtcComponents(pool, letter.letter_id)
      : [];

  const metadataComplete = hasCompleteCompensationMetadata(letter);
  const ctcAligned =
    metadataComplete && amountsMatch(letter.compensation_annual_ctc, annualCtc);

  if (existingRows.length > 0 && !ctcAligned) {
    throw httpError(
      "Offer compensation is out of date. Recalculate compensation before generating the offer letter.",
      409
    );
  }

  if (existingRows.length > 0 && ctcAligned) {
    const aggregated = compensationLetterBridgeService.aggregatePersistedLetterRows(
      existingRows
    );

    return {
      ...aggregated,
      letterId: letter.letter_id,
      reusedPersisted: true
    };
  }

  const calculated = await evaluateAndPersistOfferCompensation(
    pool,
    offerId,
    annualCtc,
    req,
    { skipPersistedReuse: true }
  );

  return {
    structureName: calculated.structureName,
    gross: calculated.gross,
    totalCtc: calculated.totalCtc,
    ctcBreakup: calculated.components,
    salaryBreakup: calculated.salaryBreakup,
    letterId: calculated.letterId,
    reusedPersisted: false
  };
}

module.exports = {
  calculateOfferCompensation,
  evaluateAndPersistOfferCompensation,
  ensureOfferCompensationForGeneration,
  resolveStructureForOffer,
  resolveAuthoritativeAnnualCtc,
  hasCompleteCompensationMetadata,
  amountsMatch
};
