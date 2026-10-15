const {
  CONFIRM_PRODUCTION_VALUE,
  TARGET_ENV,
  CONFIRM_ENV,
  ALLOW_RETRY_CONFIRM_VALUE,
  ALLOW_RETRY_CONFIRM_ENV
} = require("./migrationConstants");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function parseCsvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) {
    return fallback;
  }

  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getLocalDatabaseAllowlist() {
  return parseCsvEnv("OPTALYNX_LOCAL_DB_NAMES", ["ats_dev"]);
}

function getNeonDatabaseAllowlist() {
  return parseCsvEnv("OPTALYNX_NEON_DB_NAMES", ["neondb"]);
}

function getNeonHostAllowlist() {
  const custom = parseCsvEnv("OPTALYNX_NEON_HOST_ALLOWLIST", []);
  return custom;
}

function classifyHost(host) {
  const normalized = String(host || "").trim().toLowerCase();

  if (LOCAL_HOSTS.has(normalized)) {
    return "local";
  }

  if (normalized.includes("neon.tech")) {
    return "neon";
  }

  const allowlist = getNeonHostAllowlist();
  if (allowlist.some((entry) => normalized === entry.toLowerCase())) {
    return "neon";
  }

  return "unknown";
}

function requireDbTarget() {
  const target = String(process.env[TARGET_ENV] || "").trim().toLowerCase();

  if (target !== "local" && target !== "neon") {
    throw new Error(
      `${TARGET_ENV} must be set to "local" or "neon" for this command.`
    );
  }

  return target;
}

function describeConnection(config, target) {
  return {
    target,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    hostClass: classifyHost(config.host)
  };
}

function assertReadOnlyTargetAllowed(target, config) {
  const hostClass = classifyHost(config.host);

  if (target === "local") {
    if (hostClass !== "local") {
      throw new Error(
        `Refusing read-only access: ${TARGET_ENV}=local but DB_HOST is not a local host.`
      );
    }

    if (!getLocalDatabaseAllowlist().includes(config.database)) {
      throw new Error(
        `Refusing read-only access: database "${config.database}" is not in OPTALYNX_LOCAL_DB_NAMES.`
      );
    }

    return;
  }

  if (target === "neon") {
    if (hostClass !== "neon") {
      throw new Error(
        `Refusing read-only access: ${TARGET_ENV}=neon but DB_HOST does not match Neon allowlist.`
      );
    }

    if (!getNeonDatabaseAllowlist().includes(config.database)) {
      throw new Error(
        `Refusing read-only access: database "${config.database}" is not in OPTALYNX_NEON_DB_NAMES.`
      );
    }
  }
}

function assertMutatingTargetAllowed(target, config) {
  assertReadOnlyTargetAllowed(target, config);

  if (target === "neon") {
    const confirm = String(process.env[CONFIRM_ENV] || "").trim();

    if (confirm !== CONFIRM_PRODUCTION_VALUE) {
      throw new Error(
        `Refusing mutating migration on Neon: set ${CONFIRM_ENV}=${CONFIRM_PRODUCTION_VALUE}.`
      );
    }
  }
}

function assertMigrationRetryOverrideAllowed(allowRetryFilename) {
  const filename = String(allowRetryFilename || "").trim();

  if (!filename) {
    throw new Error(
      "Migration retry override requires --allow-retry-filename <single-file.sql>."
    );
  }

  const confirm = String(process.env[ALLOW_RETRY_CONFIRM_ENV] || "").trim();

  if (confirm !== ALLOW_RETRY_CONFIRM_VALUE) {
    throw new Error(
      `Refusing migration retry override: set ${ALLOW_RETRY_CONFIRM_ENV}=${ALLOW_RETRY_CONFIRM_VALUE}.`
    );
  }

  return filename;
}

module.exports = {
  classifyHost,
  requireDbTarget,
  describeConnection,
  assertReadOnlyTargetAllowed,
  assertMutatingTargetAllowed,
  assertMigrationRetryOverrideAllowed,
  getLocalDatabaseAllowlist,
  getNeonDatabaseAllowlist,
  CONFIRM_PRODUCTION_VALUE,
  TARGET_ENV,
  CONFIRM_ENV,
  ALLOW_RETRY_CONFIRM_VALUE,
  ALLOW_RETRY_CONFIRM_ENV
};
