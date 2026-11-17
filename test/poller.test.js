'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ServicePoller } = require('../src/poller');

const service = { name: 'radarr', baseUrl: 'http://radarr:7878', apiBase: '/api/v3', apiKey: 'k' };
const quietLogger = { info() {}, warn() {}, error() {} };

function baseConfig(overrides = {}) {
  return {
    pageSize: 2,
    maxPagesPerPoll: 5,
    minLevel: 'info',
    backfillOnStart: false,
    backfillLimit: 10,
    requestTimeoutMs: 1000,
    hostName: 'test-host',
    ...overrides,
  };
}

// Fake *arr log store: `ids` is the set of record ids present, newest-first pagination.
function fakeFetch(store) {
  return async (url) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    const pageSize = Number(u.searchParams.get('pageSize'));
    assert.equal(u.searchParams.get('sortKey'), 'id');
    assert.equal(u.searchParams.get('sortDirection'), 'descending');
    const desc = [...store.records].sort((a, b) => b.id - a.id);
    const slice = desc.slice((page - 1) * pageSize, page * pageSize);
    return {
      ok: true,
      status: 200,
      json: async () => ({ totalRecords: desc.length, records: slice }),
    };
  };
}

function recordsFrom(ids) {
  return ids.map((id) => ({
    id,
    time: '2026-11-17T10:00:00Z',
    level: 'info',
    logger: 'L',
    message: `msg ${id}`,
  }));
}

function collectingSender() {
  const sent = [];
  return { sent, send: async (gelf) => { sent.push(gelf); return true; }, close() {} };
}

test('first poll without backfill sets the cursor and sends nothing', async () => {
  const store = { records: recordsFrom([1, 2, 3]) };
  const sender = collectingSender();
  const p = new ServicePoller({ service, config: baseConfig(), sender, logger: quietLogger, fetchImpl: fakeFetch(store) });

  assert.equal(await p.poll(), 0);
  assert.equal(p.lastId, 3);
  assert.equal(sender.sent.length, 0);
});

test('subsequent polls forward only new records, oldest first, across pages', async () => {
  const store = { records: recordsFrom([1, 2, 3]) };
  const sender = collectingSender();
  const p = new ServicePoller({ service, config: baseConfig(), sender, logger: quietLogger, fetchImpl: fakeFetch(store) });
  await p.poll(); // cursor at 3

  store.records.push(...recordsFrom([4, 5, 6, 7]));
  const n = await p.poll();

  assert.equal(n, 4);
  assert.deepEqual(sender.sent.map((g) => g._record_id), [4, 5, 6, 7]);
  assert.equal(p.lastId, 7);

  assert.equal(await p.poll(), 0, 'nothing new means nothing sent');
});

test('backfill sends the most recent entries in chronological order', async () => {
  const store = { records: recordsFrom([1, 2, 3, 4, 5]) };
  const sender = collectingSender();
  const p = new ServicePoller({
    service,
    config: baseConfig({ backfillOnStart: true, backfillLimit: 3 }),
    sender,
    logger: quietLogger,
    fetchImpl: fakeFetch(store),
  });

  assert.equal(await p.poll(), 3);
  assert.deepEqual(sender.sent.map((g) => g._record_id), [3, 4, 5]);
  assert.equal(p.lastId, 5);
});

test('a failed send keeps the cursor so the record is retried on the next poll', async () => {
  const store = { records: recordsFrom([1]) };
  let fail = true;
  const sender = {
    sent: [],
    send: async (gelf) => {
      if (fail) throw new Error('graylog down');
      sender.sent.push(gelf);
      return true;
    },
    close() {},
  };
  const p = new ServicePoller({ service, config: baseConfig(), sender, logger: quietLogger, fetchImpl: fakeFetch(store) });
  await p.poll(); // cursor at 1
  store.records.push(...recordsFrom([2]));

  assert.equal(await p.poll(), 0);
  assert.equal(p.lastId, 1);

  fail = false;
  assert.equal(await p.poll(), 1);
  assert.deepEqual(sender.sent.map((g) => g._record_id), [2]);
});

test('a reset log (ids going backwards) resyncs without flooding old entries', async () => {
  const store = { records: recordsFrom([10, 11, 12]) };
  const sender = collectingSender();
  const p = new ServicePoller({ service, config: baseConfig(), sender, logger: quietLogger, fetchImpl: fakeFetch(store) });
  await p.poll(); // cursor at 12

  store.records = recordsFrom([1]); // log was cleared and restarted
  assert.equal(await p.poll(), 1);
  assert.deepEqual(sender.sent.map((g) => g._record_id), [1]);
});
