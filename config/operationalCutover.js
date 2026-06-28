/**
 * Operational System of Record cutover configuration.
 *
 * OPERATIONAL_SOR=enterprise  (default after consolidation)
 * OPERATIONAL_SOR=legacy      (rollback — services may dual-read legacy)
 *
 * LEGACY_DUAL_WRITE=true      (optional — re-enable legacy table writes during transition)
 */

function getOperationalSor() {
  const value = (process.env.OPERATIONAL_SOR || "enterprise").toLowerCase();
  return value === "legacy" ? "legacy" : "enterprise";
}

function isEnterpriseOperationalSor() {
  return getOperationalSor() === "enterprise";
}

function isLegacyOperationalSor() {
  return getOperationalSor() === "legacy";
}

function isLegacyDualWriteEnabled() {
  if (isLegacyOperationalSor()) {
    return true;
  }

  return String(process.env.LEGACY_DUAL_WRITE || "false").toLowerCase() === "true";
}

module.exports = {
  getOperationalSor,
  isEnterpriseOperationalSor,
  isLegacyOperationalSor,
  isLegacyDualWriteEnabled
};
