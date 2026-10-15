/**
 * Phase 1 verification: unit tests + offline dry-run (no database connection).
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const backendRoot = path.join(__dirname, "..");

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendRoot,
    encoding: "utf8",
    env: process.env
  });

  return result;
}

function main() {
  const testRun = runNode(["--test", "scripts/migrationManager.test.js"]);

  if (testRun.stdout) {
    process.stdout.write(testRun.stdout);
  }
  if (testRun.stderr) {
    process.stderr.write(testRun.stderr);
  }

  if (testRun.status !== 0) {
    process.exit(testRun.status || 1);
  }

  const dryRun = runNode([
    "scripts/migrateCli.js",
    "dry-run",
    "--offline",
    "--json"
  ]);

  if (dryRun.stdout) {
    process.stdout.write(dryRun.stdout);
  }
  if (dryRun.stderr) {
    process.stderr.write(dryRun.stderr);
  }

  if (dryRun.status !== 0) {
    process.exit(dryRun.status || 1);
  }

  console.log("\n✅ verifyMigrationCli: tests and offline dry-run passed.");
}

main();
