'use strict';

/**
 * Minimal client for the log endpoints shared by Sonarr, Radarr and Prowlarr.
 *   GET {apiBase}/log?page&pageSize&sortKey&sortDirection&level
 * Authenticated with the X-Api-Key header.
 */
async function fetchLogPage(service, options, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 100),
    sortKey: 'id',
    sortDirection: 'descending',
  });
  if (options.level) params.set('level', options.level);

  const url = `${service.baseUrl}${service.apiBase}/log?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      headers: {
        'X-Api-Key': service.apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${service.name}: authentication failed (HTTP ${res.status}). Check the API key.`);
    }
    if (!res.ok) {
      throw new Error(`${service.name}: HTTP ${res.status} from ${service.apiBase}/log`);
    }
    const body = await res.json();
    return {
      totalRecords: Number(body.totalRecords ?? 0),
      records: Array.isArray(body.records) ? body.records : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchLogPage };
