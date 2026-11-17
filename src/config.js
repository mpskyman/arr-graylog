'use strict';

const SERVICE_DEFAULTS = {
  sonarr: { apiBase: '/api/v3' },
  radarr: { apiBase: '/api/v3' },
  prowlarr: { apiBase: '/api/v1' },
};

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function parseServices(env) {
  const services = [];
  for (const name of Object.keys(SERVICE_DEFAULTS)) {
    const prefix = name.toUpperCase();
    const url = env[`${prefix}_URL`];
    const apiKey = env[`${prefix}_API_KEY`];
    if (!url && !apiKey) continue;
    if (!url || !apiKey) {
      throw new Error(`${prefix}_URL and ${prefix}_API_KEY must both be set to enable ${name}`);
    }
    services.push({
      name,
      baseUrl: url.replace(/\/+$/, ''),
      apiKey,
      apiBase: env[`${prefix}_API_BASE`] || SERVICE_DEFAULTS[name].apiBase,
    });
  }
  if (services.length === 0) {
    throw new Error('No services configured. Set SONARR_URL/SONARR_API_KEY, RADARR_URL/RADARR_API_KEY, and/or PROWLARR_URL/PROWLARR_API_KEY.');
  }
  return services;
}

function parseIntEnv(env, key, fallback, min) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const protocol = (env.GRAYLOG_PROTOCOL || 'udp').toLowerCase();
  if (protocol !== 'udp' && protocol !== 'tcp') {
    throw new Error('GRAYLOG_PROTOCOL must be "udp" or "tcp"');
  }

  const minLevel = (env.MIN_LOG_LEVEL || 'info').toLowerCase();
  if (!LEVELS.includes(minLevel)) {
    throw new Error(`MIN_LOG_LEVEL must be one of: ${LEVELS.join(', ')}`);
  }

  return {
    services: parseServices(env),
    graylog: {
      host: env.GRAYLOG_HOST || '127.0.0.1',
      port: parseIntEnv(env, 'GRAYLOG_PORT', 12201, 1),
      protocol,
    },
    pollIntervalMs: parseIntEnv(env, 'POLL_INTERVAL_SECONDS', 30, 1) * 1000,
    pageSize: parseIntEnv(env, 'PAGE_SIZE', 100, 1),
    maxPagesPerPoll: parseIntEnv(env, 'MAX_PAGES_PER_POLL', 10, 1),
    minLevel,
    // When true, the first poll forwards the most recent entries already in the
    // log. When false (default), only entries written after startup are sent.
    backfillOnStart: /^(1|true|yes)$/i.test(env.BACKFILL_ON_START || ''),
    backfillLimit: parseIntEnv(env, 'BACKFILL_LIMIT', 200, 0),
    requestTimeoutMs: parseIntEnv(env, 'REQUEST_TIMEOUT_SECONDS', 10, 1) * 1000,
    hostName: env.GELF_HOST_NAME || require('os').hostname(),
  };
}

module.exports = { loadConfig, parseServices, LEVELS };
