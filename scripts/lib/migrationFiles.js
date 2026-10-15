const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function listMigrationSqlFiles(migrationsDir) {
  const dir = migrationsDir;
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function migrationFilePath(migrationsDir, filename) {
  return path.join(migrationsDir, filename);
}

function readMigrationSql(migrationsDir, filename) {
  const filePath = migrationFilePath(migrationsDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Migration file not found: ${filename}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function checksumSha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function fileChecksum(migrationsDir, filename) {
  const sql = readMigrationSql(migrationsDir, filename);
  return checksumSha256(sql);
}

/**
 * Files that contain their own transaction boundaries should be executed as-is.
 */
function sqlManagesOwnTransaction(sql) {
  const normalized = String(sql || "").trim();
  if (!normalized) {
    return false;
  }

  const hasBegin = /^\s*BEGIN\s*;?/im.test(normalized);
  const hasCommit = /\bCOMMIT\s*;?\s*$/im.test(normalized);
  return hasBegin && hasCommit;
}

function buildExecutionSql(sql) {
  if (sqlManagesOwnTransaction(sql)) {
    return { sql: String(sql).trim(), wrapped: false };
  }

  return {
    sql: `BEGIN;\n${String(sql).trim()}\nCOMMIT;`,
    wrapped: true
  };
}

module.exports = {
  listMigrationSqlFiles,
  migrationFilePath,
  readMigrationSql,
  checksumSha256,
  fileChecksum,
  sqlManagesOwnTransaction,
  buildExecutionSql
};
