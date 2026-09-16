const { listActiveAtsStageCatalog } = require("./atsStageCatalogService");
const { listActiveAtsStageAliases } = require("./atsStageAliasService");

const CANDIDATE_PORTAL_INTERVIEW_MICRO_STATE_PATTERN =
  /\b(interview scheduled|technical cleared|feedback pending|cleared|rejected)\b/i;

function inferCatalogStageCodeFromOperationalStage(stageName) {
  const value = String(stageName || "").trim().toLowerCase();

  if (!value) {
    return null;
  }

  if (value.includes("joined")) {
    return "JOINED";
  }

  if (value.includes("offer")) {
    return "OFFER";
  }

  if (value.includes("client")) {
    return "CLIENT_INTERVIEW";
  }

  if (value.includes("l2") || value.includes("hr interview")) {
    return "L2_INTERVIEW";
  }

  if (value.includes("l1")) {
    return "L1_INTERVIEW";
  }

  if (value.includes("screening")) {
    return "SCREENING";
  }

  if (value.includes("applied")) {
    return "APPLIED";
  }

  if (value.includes("interview")) {
    return "L1_INTERVIEW";
  }

  return null;
}

async function buildCandidateFacingStageResolver(pool) {
  const catalog = await listActiveAtsStageCatalog(pool);
  const catalogByDisplay = new Map(
    catalog.map((row) => [row.display_name, row])
  );
  const catalogByCode = new Map(catalog.map((row) => [row.stage_code, row]));
  const aliases = await listActiveAtsStageAliases(pool);
  const aliasByLegacy = new Map(
    aliases.map((row) => [row.legacy_value, row.catalog])
  );

  return function resolveCandidateFacingStage(rawStageName) {
    const normalized = String(rawStageName || "").trim();

    if (!normalized) {
      return null;
    }

    const direct = catalogByDisplay.get(normalized);

    if (direct) {
      return {
        stage_name: direct.display_name,
        stage_code: direct.stage_code
      };
    }

    const alias = aliasByLegacy.get(normalized);

    if (alias?.display_name) {
      return {
        stage_name: alias.display_name,
        stage_code: alias.stage_code
      };
    }

    const inferredCode = inferCatalogStageCodeFromOperationalStage(normalized);
    const inferred = inferredCode ? catalogByCode.get(inferredCode) : null;

    if (inferred) {
      return {
        stage_name: inferred.display_name,
        stage_code: inferred.stage_code
      };
    }

    return null;
  };
}

module.exports = {
  CANDIDATE_PORTAL_INTERVIEW_MICRO_STATE_PATTERN,
  inferCatalogStageCodeFromOperationalStage,
  buildCandidateFacingStageResolver
};
