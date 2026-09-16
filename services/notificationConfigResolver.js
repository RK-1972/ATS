/**
 * Phase 6C-3 — read-only notification configuration resolver.
 *
 * Source of truth: normalized tables pc_notification_channels and
 * pc_notification_settings (synced from published platform config).
 * Falls back to pc_config_state.published_payload, then safe defaults.
 *
 * Read-only. Does not enforce delivery policy on existing Graph adapters.
 */

const DELIVERABLE_CHANNELS = new Set(["email"]);

const DEFAULT_SETTINGS = {
  digest_enabled: true,
  digest_frequency: "daily",
  digest_time: "08:00",
  quiet_hours_enabled: true,
  quiet_hours_start: "20:00",
  quiet_hours_end: "08:00",
  default_sender: null,
  retry_attempts: 3,
  escalation_on_failure: true
};

function normalizeChannelKey(channelKey) {
  return String(channelKey || "").trim().toLowerCase();
}

function mapChannelRow(row) {
  return {
    key: row.channel_key,
    title: row.title,
    description: row.description || null,
    enabled: row.enabled === true,
    provider: row.provider || null,
    templateCount: Number(row.template_count) || 0,
    rateLimitPerHour: Number(row.rate_limit_per_hour) || 0,
    versionStatus: row.version_status || null
  };
}

function mapChannelPayload(channel = {}) {
  return {
    key: String(channel.key || "").trim(),
    title: channel.title || null,
    description: channel.description || null,
    enabled: channel.enabled === true,
    provider: channel.provider || null,
    templateCount: Number(channel.template_count) || 0,
    rateLimitPerHour: Number(channel.rate_limit_per_hour) || 0,
    versionStatus: channel.version_status || null
  };
}

function mapSettingsRow(row) {
  return {
    digest_enabled: row.digest_enabled === true,
    digest_frequency: row.digest_frequency || DEFAULT_SETTINGS.digest_frequency,
    digest_time: row.digest_time || DEFAULT_SETTINGS.digest_time,
    quiet_hours_enabled: row.quiet_hours_enabled === true,
    quiet_hours_start: row.quiet_hours_start || DEFAULT_SETTINGS.quiet_hours_start,
    quiet_hours_end: row.quiet_hours_end || DEFAULT_SETTINGS.quiet_hours_end,
    default_sender: row.default_sender ? String(row.default_sender).trim() : null,
    retry_attempts: Number(row.retry_attempts ?? DEFAULT_SETTINGS.retry_attempts),
    escalation_on_failure: row.escalation_on_failure === true
  };
}

function mapSettingsPayload(settings = {}) {
  return {
    digest_enabled: settings.digest_enabled === true,
    digest_frequency: settings.digest_frequency || DEFAULT_SETTINGS.digest_frequency,
    digest_time: settings.digest_time || DEFAULT_SETTINGS.digest_time,
    quiet_hours_enabled: settings.quiet_hours_enabled === true,
    quiet_hours_start: settings.quiet_hours_start || DEFAULT_SETTINGS.quiet_hours_start,
    quiet_hours_end: settings.quiet_hours_end || DEFAULT_SETTINGS.quiet_hours_end,
    default_sender: settings.default_sender
      ? String(settings.default_sender).trim()
      : null,
    retry_attempts: Number(settings.retry_attempts ?? DEFAULT_SETTINGS.retry_attempts),
    escalation_on_failure: settings.escalation_on_failure === true
  };
}

function buildConfig({ channels, settings, source, isConfigured }) {
  return {
    channels,
    settings,
    source,
    isConfigured
  };
}

async function loadPublishedNotificationPayload(pool) {
  const result = await pool.query(
    "SELECT published_payload FROM pc_config_state WHERE id = 1"
  );

  const published = result.rows[0]?.published_payload;

  if (!published || typeof published !== "object") {
    return null;
  }

  return {
    channels: Array.isArray(published.notification_channels)
      ? published.notification_channels.map(mapChannelPayload)
      : [],
    settings: published.notification_settings
      ? mapSettingsPayload(published.notification_settings)
      : { ...DEFAULT_SETTINGS }
  };
}

/**
 * @param {import("pg").Pool | import("pg").PoolClient} pool
 * @returns {Promise<{
 *   channels: object[],
 *   settings: object,
 *   source: 'normalized' | 'published_payload' | 'defaults',
 *   isConfigured: boolean
 * }>}
 */
async function loadNotificationConfig(pool) {
  const [channelsResult, settingsResult] = await Promise.all([
    pool.query(
      `SELECT
         channel_key,
         title,
         description,
         enabled,
         provider,
         template_count,
         rate_limit_per_hour,
         version_status
       FROM pc_notification_channels
       ORDER BY channel_key ASC`
    ),
    pool.query(
      `SELECT
         digest_enabled,
         digest_frequency,
         digest_time,
         quiet_hours_enabled,
         quiet_hours_start,
         quiet_hours_end,
         default_sender,
         retry_attempts,
         escalation_on_failure
       FROM pc_notification_settings
       WHERE id = 1`
    )
  ]);

  const hasNormalizedChannels = channelsResult.rows.length > 0;
  const hasNormalizedSettings = settingsResult.rows.length > 0;

  if (hasNormalizedChannels || hasNormalizedSettings) {
    const channels = hasNormalizedChannels
      ? channelsResult.rows.map(mapChannelRow)
      : [];
    const settings = hasNormalizedSettings
      ? mapSettingsRow(settingsResult.rows[0])
      : { ...DEFAULT_SETTINGS };

    if (!hasNormalizedChannels) {
      const published = await loadPublishedNotificationPayload(pool);

      if (published?.channels?.length) {
        return buildConfig({
          channels: published.channels,
          settings,
          source: "published_payload",
          isConfigured: true
        });
      }
    }

    return buildConfig({
      channels,
      settings,
      source: "normalized",
      isConfigured: true
    });
  }

  const published = await loadPublishedNotificationPayload(pool);

  if (published) {
    return buildConfig({
      channels: published.channels,
      settings: published.settings,
      source: "published_payload",
      isConfigured: published.channels.length > 0
        || published.settings.default_sender !== null
    });
  }

  return buildConfig({
    channels: [],
    settings: { ...DEFAULT_SETTINGS },
    source: "defaults",
    isConfigured: false
  });
}

function findChannel(config, channelKey) {
  const normalizedKey = normalizeChannelKey(channelKey);

  if (!normalizedKey) {
    return null;
  }

  return (config?.channels || []).find(
    (channel) => normalizeChannelKey(channel.key) === normalizedKey
  ) || null;
}

function isChannelEnabled(config, channelKey) {
  const channel = findChannel(config, channelKey);
  return channel?.enabled === true;
}

function getDefaultSender(config) {
  const sender = config?.settings?.default_sender;
  return sender ? String(sender).trim() : null;
}

function getNotificationSettings(config) {
  return {
    ...DEFAULT_SETTINGS,
    ...(config?.settings || {})
  };
}

/**
 * Whether the channel is both enabled in config and supported by the current
 * delivery architecture (email only for now).
 */
function isDeliverableChannel(config, channelKey) {
  const normalizedKey = normalizeChannelKey(channelKey);

  if (!DELIVERABLE_CHANNELS.has(normalizedKey)) {
    return false;
  }

  return isChannelEnabled(config, normalizedKey);
}

module.exports = {
  DEFAULT_SETTINGS,
  DELIVERABLE_CHANNELS,
  loadNotificationConfig,
  findChannel,
  isChannelEnabled,
  getDefaultSender,
  getNotificationSettings,
  isDeliverableChannel,
  normalizeChannelKey
};
