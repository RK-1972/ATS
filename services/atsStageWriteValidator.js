/**
 * Governed ATS stage write resolver for manual recruitment paths (W1/W2).
 * Accepts active catalog display_name or exact 5G alias; persists canonical display_name.
 * Interview micro-states are never resolved here.
 */

const { listActiveAtsStageCatalog } = require("./atsStageCatalogService");
const { resolveLegacyStageAlias } = require("./atsStageAliasService");

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * @param {import("pg").Pool} pool
 * @param {string} stageValue
 * @returns {Promise<{ displayName: string, stageCode: string, resolvedVia: "catalog"|"alias", aliasValue?: string }>}
 */
async function resolveGovernedAtsStage(pool, stageValue) {
  const normalized = String(stageValue || "").trim();

  if (!normalized) {
    throw httpError("stage_name is required.", 400);
  }

  const catalog = await listActiveAtsStageCatalog(pool);
  const directMatch = catalog.find((row) => row.display_name === normalized);

  if (directMatch) {
    return {
      displayName: directMatch.display_name,
      stageCode: directMatch.stage_code,
      resolvedVia: "catalog"
    };
  }

  const alias = await resolveLegacyStageAlias(pool, normalized);

  if (alias?.catalog?.display_name) {
    return {
      displayName: alias.catalog.display_name,
      stageCode: alias.catalog.stage_code,
      resolvedVia: "alias",
      aliasValue: alias.legacy_value
    };
  }

  throw httpError(
    `Invalid ATS stage "${normalized}". Provide an active catalog stage or a supported legacy alias.`,
    400
  );
}

module.exports = {
  resolveGovernedAtsStage
};
