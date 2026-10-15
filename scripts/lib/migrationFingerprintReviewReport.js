const { getEffectiveManifest } = require("./migrationBaseline");
const { DEFAULT_MIGRATIONS_DIR } = require("./migrationConstants");

const EXISTENCE_ONLY_TYPES = new Set(["regclass", "column", "index", "constraint"]);
const COUNT_ONLY_TIERS = new Set(["object", "data"]);

function buildFingerprintReviewReport(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const manifest = getEffectiveManifest(migrationsDir);
  const limitations = [];
  const byFilename = {};

  for (const [filename, entry] of Object.entries(manifest.fingerprints || {})) {
    const checks = entry.checks || [];
    const fileNotes = [];

    for (const check of checks) {
      const tier = check.tier || "unknown";
      const proves = check.proves || "";
      const cannotProve = check.cannotProve || "";

      if (check.type === "regclass") {
        fileNotes.push({
          checkType: check.type,
          tier,
          limitation:
            "Object existence only; does not prove DDL equivalence or seed completeness.",
          proves,
          cannotProve
        });
      }

      if (check.type === "data" && check.expectMin !== undefined) {
        fileNotes.push({
          checkType: check.type,
          tier,
          limitation: `Minimum row count (>= ${check.expectMin}) only; does not prove exact seed content.`,
          proves,
          cannotProve
        });
      }

      if (check.type === "exists") {
        fileNotes.push({
          checkType: check.type,
          tier,
          limitation: "Existence predicate only; does not prove full seed row equivalence.",
          proves,
          cannotProve
        });
      }

      if (EXISTENCE_ONLY_TYPES.has(check.type) && check.type !== "regclass") {
        fileNotes.push({
          checkType: check.type,
          tier,
          limitation: "Shape/existence signal only; not full schema or data equivalence.",
          proves,
          cannotProve
        });
      }
    }

    if (fileNotes.length) {
      byFilename[filename] = fileNotes;
      limitations.push({ filename, checks: fileNotes.length });
    }
  }

  return {
    disclaimer:
      "Fingerprints that rely on regclass, column/index presence, or minimum counts do NOT prove complete schema or seed equivalence.",
    fileCount: Object.keys(byFilename).length,
    byFilename,
    summary: limitations
  };
}

module.exports = {
  buildFingerprintReviewReport
};
