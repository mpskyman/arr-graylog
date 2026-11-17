'use strict';

const { fetchLogPage } = require('./arr-client');
const { toGelf } = require('./gelf');

/**
 * Tracks one service's log position and forwards new records.
 *
 * Records are identified by the monotonically increasing `id` the *arr API
 * returns. Each poll pages newest-first until it reaches an id it has already
 * seen, then forwards the new records oldest-first so Graylog receives them in
 * order.
 */
class ServicePoller {
  constructor({ service, config, sender, logger, fetchImpl }) {
    this.service = service;
    this.config = config;
    this.sender = sender;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.lastId = null; // null = not initialised yet
  }

  async fetchPage(page) {
    return fetchLogPage(
      this.service,
      { page, pageSize: this.config.pageSize, level: this.config.minLevel },
      { timeoutMs: this.config.requestTimeoutMs, fetchImpl: this.fetchImpl },
    );
  }

  /** Runs one poll. Returns the number of records forwarded. */
  async poll() {
    if (this.lastId === null) {
      return this.initialise();
    }

    const fresh = [];
    let resetDetected = false;

    for (let page = 1; page <= this.config.maxPagesPerPoll; page++) {
      const { records, totalRecords } = await this.fetchPage(page);
      if (records.length === 0) break;

      if (page === 1) {
        const newestId = maxId(records);
        // The newest id went backwards, so the *arr log database was probably
        // cleared or recreated. Start over from the current top of the log.
        if (newestId < this.lastId) {
          this.logger.warn(`${this.service.name}: log ids went backwards (${newestId} < ${this.lastId}); resyncing`);
          resetDetected = true;
          this.lastId = 0;
        }
      }

      let reachedKnown = false;
      for (const record of records) {
        if (record.id > this.lastId) {
          fresh.push(record);
        } else {
          reachedKnown = true;
        }
      }

      if (reachedKnown || records.length < this.config.pageSize) break;
      if (page === this.config.maxPagesPerPoll && totalRecords > page * this.config.pageSize) {
        this.logger.warn(
          `${this.service.name}: more than ${page * this.config.pageSize} new entries since last poll; older ones were skipped`,
        );
      }
    }

    if (resetDetected && fresh.length === 0) return 0;
    return this.forward(fresh);
  }

  async initialise() {
    const { records } = await this.fetchPage(1);
    if (!this.config.backfillOnStart) {
      this.lastId = maxId(records, 0);
      this.logger.info(`${this.service.name}: starting at log id ${this.lastId}`);
      return 0;
    }

    // Backfill: fetch the most recent entries, capped by backfillLimit.
    const wanted = this.config.backfillLimit;
    const collected = [];
    for (let page = 1; collected.length < wanted; page++) {
      const { records } = await this.fetchPage(page);
      if (records.length === 0) break;
      collected.push(...records);
      if (records.length < this.config.pageSize) break;
    }
    const slice = collected.slice(0, wanted);
    this.lastId = maxId(slice, 0);
    return this.forward(slice);
  }

  /** Sends records oldest-first and advances lastId only after each send succeeds. */
  async forward(records) {
    const ordered = [...records].sort((a, b) => a.id - b.id);
    let sent = 0;
    for (const record of ordered) {
      const gelf = toGelf(record, this.service, this.config.hostName);
      try {
        await this.sender.send(gelf);
        sent++;
        if (record.id > this.lastId) this.lastId = record.id;
      } catch (err) {
        this.logger.error(`${this.service.name}: failed to send record ${record.id} to Graylog: ${err.message}`);
        break; // retry the rest on the next poll
      }
    }
    return sent;
  }
}

function maxId(records, fallback = 0) {
  let max = null;
  for (const r of records) {
    if (typeof r.id === 'number' && (max === null || r.id > max)) max = r.id;
  }
  return max === null ? fallback : max;
}

module.exports = { ServicePoller, maxId };
