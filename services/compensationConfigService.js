const compensationRepository = require("../repositories/compensationRepository");

const {

  assertStructureIdMatchesComponent,

  validateStructureIntegrity

} = require("./compensationStructureValidation");

const { writeEnterpriseAudit, userContext } = require("./enterpriseAuditService");



function httpError(message, status = 400) {

  const error = new Error(message);

  error.status = status;

  return error;

}



function validateComponentPatch(row, patch) {

  const formulaType = row.formula_type;



  if (patch.formulaValue != null) {

    const value = Number(patch.formulaValue);



    if (!Number.isFinite(value)) {

      throw httpError("Formula value must be a number.", 400);

    }



    if (formulaType === "PERCENT_OF_CTC" || formulaType === "PERCENT_OF_BASIC") {

      if (value < 0 || value > 100) {

        throw httpError("Percentage must be between 0 and 100.", 400);

      }

    }

  }



  if (patch.fixedAmount != null && formulaType === "FIXED") {

    const fixed = Number(patch.fixedAmount);



    if (!Number.isFinite(fixed) || fixed < 0) {

      throw httpError("Fixed amount must be zero or greater.", 400);

    }

  }



  if (patch.includeInCtc === false && row.formula_type === "BALANCING") {

    throw httpError("Balancing component must remain included in CTC.", 400);

  }

}



async function updateStructureComponent(pool, structureId, structureComponentId, payload, req) {

  const existing = await compensationRepository.findStructureComponentById(

    pool,

    structureComponentId

  );



  if (!existing) {

    throw httpError(`Structure component not found: ${structureComponentId}`, 404);

  }



  assertStructureIdMatchesComponent(structureId, existing);



  if (!existing.editable) {

    throw httpError("This compensation component is not editable.", 403);

  }



  const patch = {

    formulaValue:

      payload.formulaValue != null ? Number(payload.formulaValue) : undefined,

    fixedAmount:

      payload.fixedAmount != null ? Number(payload.fixedAmount) : undefined,

    includeInCtc:

      payload.includeInCtc != null ? Boolean(payload.includeInCtc) : undefined,

    status: payload.status ? String(payload.status).trim() : undefined

  };



  validateComponentPatch(existing, patch);



  await compensationRepository.updateStructureComponent(

    pool,

    structureComponentId,

    patch

  );



  await validateStructureIntegrity(pool, structureId);



  const updated = await compensationRepository.findStructureComponentById(

    pool,

    structureComponentId

  );



  const actor = userContext(req);



  await writeEnterpriseAudit(pool, {

    eventType: "COMPENSATION_STRUCTURE_COMPONENT_UPDATED",

    module: "Platform Configuration",

    entity: "cm_compensation_structure_components",

    entityId: structureComponentId,

    action: "Updated compensation structure component rule",

    previousValue: JSON.stringify({

      formula_value: existing.formula_value,

      fixed_amount: existing.fixed_amount,

      include_in_ctc: existing.include_in_ctc,

      status: existing.status

    }),

    newValue: JSON.stringify({

      formula_value: updated.formula_value,

      fixed_amount: updated.fixed_amount,

      include_in_ctc: updated.include_in_ctc,

      status: updated.status

    }),

    userName: actor.name,

    userRole: actor.role

  });



  return compensationRepository.mapStructureComponentRow(updated);

}



module.exports = {

  updateStructureComponent

};
