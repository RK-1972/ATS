const { readMigrationSql } = require("./migrationFiles");

function meta(tier, proves, cannotProve) {
  return { tier, proves, cannotProve };
}

function deriveObjectChecksFromSql(sql, filename) {
  const checks = [];
  const tableMatches = [
    ...String(sql).matchAll(
      /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)/gi
    )
  ];

  for (const match of tableMatches) {
    const table = match[1];
    checks.push({
      type: "regclass",
      object: `public.${table}`,
      expect: "present",
      ...meta(
        "object",
        `Table ${table} exists (derived from CREATE TABLE in ${filename}).`,
        "Column types, constraints, indexes, and seed data."
      )
    });
  }

  const columnMatches = [
    ...String(sql).matchAll(
      /ADD COLUMN IF NOT EXISTS\s+([a-zA-Z0-9_]+)/gi
    )
  ];

  const alterTableMatches = [
    ...String(sql).matchAll(/ALTER TABLE\s+([a-zA-Z0-9_]+)/gi)
  ];
  const alterTable = alterTableMatches[0]?.[1];

  for (const match of columnMatches) {
    if (!alterTable) {
      continue;
    }

    checks.push({
      type: "column",
      table: alterTable,
      column: match[1],
      expect: "present",
      ...meta(
        "shape",
        `Column ${alterTable}.${match[1]} exists (derived from ALTER in ${filename}).`,
        "Column type, defaults, and dependent data."
      )
    });
  }

  const indexMatches = [
    ...String(sql).matchAll(
      /CREATE(?:\s+UNIQUE)?\s+INDEX(?:\s+IF NOT EXISTS)?\s+([a-zA-Z0-9_]+)/gi
    )
  ];

  const constraintMatches = [
    ...String(sql).matchAll(
      /ADD CONSTRAINT\s+([a-zA-Z0-9_]+)\s+UNIQUE/gi
    )
  ];

  for (const match of constraintMatches) {
    const table = alterTable || "approval_route_mstr";
    checks.push({
      type: "constraint",
      table,
      constraint: match[1],
      expect: "present",
      ...meta(
        "shape",
        `Constraint ${match[1]} on ${table} exists (derived from ADD CONSTRAINT in ${filename}).`,
        "Constraint definition equivalence and dedupe history."
      )
    });
  }

  for (const match of indexMatches) {
    checks.push({
      type: "index",
      index: match[1],
      expect: "present",
      ...meta(
        "shape",
        `Index ${match[1]} exists (derived from ${filename}).`,
        "Index definition equivalence and underlying data uniqueness."
      )
    });
  }

  return dedupeChecks(checks);
}

function dedupeChecks(checks) {
  const seen = new Set();

  return checks.filter((check) => {
    const key = JSON.stringify({
      type: check.type,
      object: check.object,
      table: check.table,
      column: check.column,
      index: check.index,
      query: check.query
    });

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function buildEffectiveFingerprintEntry(migrationsDir, filename, explicitEntry) {
  const sql = readMigrationSql(migrationsDir, filename);
  const derived = deriveObjectChecksFromSql(sql, filename);
  const explicitChecks = explicitEntry?.checks || [];
  const merged = dedupeChecks([...explicitChecks, ...derived]);

  return {
    checks: merged,
    source: explicitChecks.length ? "explicit+derived" : "derived"
  };
}

function buildEffectiveManifest(migrationsDir, baseManifest, filenames) {
  const fingerprints = {};

  for (const filename of filenames) {
    const explicitEntry = baseManifest.fingerprints?.[filename];
    fingerprints[filename] = buildEffectiveFingerprintEntry(
      migrationsDir,
      filename,
      explicitEntry
    );
  }

  return {
    version: baseManifest.version || 2,
    description: baseManifest.description,
    fingerprints
  };
}

module.exports = {
  deriveObjectChecksFromSql,
  buildEffectiveManifest,
  dedupeChecks
};
