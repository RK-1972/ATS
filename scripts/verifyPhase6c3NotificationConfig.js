/**
 * Phase 6C-3 — notification configuration read-path verification.
 * Run: node scripts/verifyPhase6c3NotificationConfig.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const notificationConfigResolver = require("../services/notificationConfigResolver");
const notificationService = require("../services/notificationService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function pass(label) {
  console.log(`PASS: ${label}`);
}

function fail(label, detail) {
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

function info(label, detail) {
  console.log(`INFO: ${label}${detail ? ` — ${detail}` : ""}`);
}

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName]
  );

  return Boolean(result.rows[0]?.exists);
}

async function readNormalizedEmailChannel() {
  const result = await pool.query(
    `SELECT channel_key, enabled, provider
     FROM pc_notification_channels
     WHERE channel_key = 'email'
     LIMIT 1`
  );

  return result.rows[0] || null;
}

async function readNormalizedSettings() {
  const result = await pool.query(
    `SELECT default_sender, retry_attempts, digest_enabled, quiet_hours_enabled
     FROM pc_notification_settings
     WHERE id = 1
     LIMIT 1`
  );

  return result.rows[0] || null;
}

function verifySafeDefaults() {
  const defaultsConfig = {
    channels: [],
    settings: notificationConfigResolver.DEFAULT_SETTINGS,
    source: "defaults",
    isConfigured: false
  };

  if (notificationConfigResolver.isChannelEnabled(defaultsConfig, "email")) {
    fail("missing configuration treats email channel as disabled");
    return;
  }

  if (notificationConfigResolver.getDefaultSender(defaultsConfig) !== null) {
    fail("missing configuration default_sender is null");
    return;
  }

  if (notificationConfigResolver.isDeliverableChannel(defaultsConfig, "sms")) {
    fail("sms is not deliverable in current architecture");
    return;
  }

  pass("missing configuration has deterministic safe defaults");
}

async function verifyLiveConfigRead() {
  if (
    !(await tableExists("pc_notification_channels"))
    || !(await tableExists("pc_notification_settings"))
  ) {
    fail("notification configuration tables exist");
    return;
  }

  pass("notification configuration tables exist");

  const config = await notificationConfigResolver.loadNotificationConfig(pool);
  const normalizedEmail = await readNormalizedEmailChannel();
  const normalizedSettings = await readNormalizedSettings();

  info("config source", config.source);
  info("configured", String(config.isConfigured));
  info("channel count", String(config.channels.length));

  if (!["normalized", "published_payload", "defaults"].includes(config.source)) {
    fail("config source is recognized", config.source);
    return;
  }

  pass("resolver returns recognized config source");

  const emailChannel = notificationConfigResolver.findChannel(config, "email");

  if (normalizedEmail) {
    const expectedEnabled = normalizedEmail.enabled === true;

    if (emailChannel?.enabled !== expectedEnabled) {
      fail(
        "email enabled state matches pc_notification_channels",
        `expected=${expectedEnabled}, got=${emailChannel?.enabled}`
      );
      return;
    }

    pass("email enabled state matches pc_notification_channels");
  } else {
    info(
      "email channel row",
      "not present in pc_notification_channels — resolver fallback verified separately"
    );
  }

  if (normalizedSettings) {
    const settings = notificationConfigResolver.getNotificationSettings(config);

    if (settings.retry_attempts !== Number(normalizedSettings.retry_attempts)) {
      fail(
        "retry_attempts matches pc_notification_settings",
        `${settings.retry_attempts} vs ${normalizedSettings.retry_attempts}`
      );
      return;
    }

    if (settings.digest_enabled !== (normalizedSettings.digest_enabled === true)) {
      fail("digest_enabled matches pc_notification_settings");
      return;
    }

    if (
      settings.quiet_hours_enabled
      !== (normalizedSettings.quiet_hours_enabled === true)
    ) {
      fail("quiet_hours_enabled matches pc_notification_settings");
      return;
    }

    const expectedSender = normalizedSettings.default_sender
      ? String(normalizedSettings.default_sender).trim()
      : null;

    if (notificationConfigResolver.getDefaultSender(config) !== expectedSender) {
      fail(
        "default_sender matches pc_notification_settings",
        `${notificationConfigResolver.getDefaultSender(config)} vs ${expectedSender}`
      );
      return;
    }

    pass("notification settings read from pc_notification_settings");
  } else {
    info(
      "settings row",
      "not present in pc_notification_settings — defaults/fallback apply"
    );
  }

  const smsEnabled = notificationConfigResolver.isChannelEnabled(config, "sms");
  const smsDeliverable = notificationConfigResolver.isDeliverableChannel(
    config,
    "sms"
  );

  if (smsDeliverable) {
    fail("sms channel is not deliverable even when enabled in config");
    return;
  }

  pass("non-email channels are readable but not deliverable yet");

  info("sms enabled in config", String(smsEnabled));
  info(
    "email deliverable",
    String(notificationConfigResolver.isDeliverableChannel(config, "email"))
  );
}

function verifyNotificationServiceExport() {
  if (!notificationService.config?.loadNotificationConfig) {
    fail("notificationService exports config resolver");
    return;
  }

  pass("notificationService exports read-only config resolver");
}

async function main() {
  try {
    verifySafeDefaults();
    await verifyLiveConfigRead();
    verifyNotificationServiceExport();
  } finally {
    await pool.end();
  }

  if (process.exitCode) {
    console.error("\nPhase 6C-3 notification config verification failed.");
    process.exit(process.exitCode);
  }

  console.log("\nPhase 6C-3 notification config verification passed.");
}

main().catch((error) => {
  console.error("Verification crashed:", error.message);
  process.exit(1);
});
