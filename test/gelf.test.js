'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { toGelf, encode, parseTimestamp, SYSLOG_LEVEL } = require('../src/gelf');

const service = { name: 'sonarr', baseUrl: 'http://sonarr:8989' };

test('toGelf maps an *arr record to a GELF 1.1 message', () => {
  const gelf = toGelf(
    {
      id: 42,
      time: '2026-11-17T10:00:00Z',
      level: 'Error',
      logger: 'NzbDrone.Core.Download',
      message: 'Download failed',
      exception: 'System.IO.IOException: boom',
      exceptionType: 'System.IO.IOException',
    },
    service,
    'box',
  );

  assert.equal(gelf.version, '1.1');
  assert.equal(gelf.host, 'box');
  assert.equal(gelf.short_message, 'Download failed');
  assert.equal(gelf.full_message, 'System.IO.IOException: boom');
  assert.equal(gelf.level, SYSLOG_LEVEL.error);
  assert.equal(gelf._service, 'sonarr');
  assert.equal(gelf._source_url, 'http://sonarr:8989');
  assert.equal(gelf._level_name, 'error');
  assert.equal(gelf._logger, 'NzbDrone.Core.Download');
  assert.equal(gelf._exception_type, 'System.IO.IOException');
  assert.equal(gelf._record_id, 42);
  assert.equal(gelf.timestamp, Date.parse('2026-11-17T10:00:00Z') / 1000);
  assert.equal('_id' in gelf, false, 'Graylog reserves _id');
});

test('toGelf falls back when message is empty and omits absent optional fields', () => {
  const gelf = toGelf({ id: 1, time: '2026-01-01T00:00:00Z', level: 'info', message: '' }, service, 'h');
  assert.equal(gelf.short_message, 'sonarr log entry');
  assert.equal('full_message' in gelf, false);
  assert.equal('_logger' in gelf, false);
});

test('syslog levels follow the GELF mapping', () => {
  assert.equal(SYSLOG_LEVEL.fatal, 2);
  assert.equal(SYSLOG_LEVEL.warn, 4);
  assert.equal(SYSLOG_LEVEL.info, 6);
  assert.equal(SYSLOG_LEVEL.debug, 7);
});

test('parseTimestamp treats zone-less values as UTC', () => {
  const noZone = parseTimestamp('2026-11-17T10:00:00.123');
  const withZ = parseTimestamp('2026-11-17T10:00:00.123Z');
  assert.equal(noZone, withZ);
});

test('encode for TCP appends a NUL delimiter', () => {
  const buf = encode({ version: '1.1', short_message: 'x' }, 'tcp');
  assert.equal(buf[buf.length - 1], 0);
  assert.deepEqual(JSON.parse(buf.subarray(0, -1).toString('utf8')).short_message, 'x');
});

test('encode for UDP produces gzip-compressed JSON', () => {
  const buf = encode({ version: '1.1', short_message: 'hello' }, 'udp');
  assert.equal(buf[0], 0x1f);
  assert.equal(buf[1], 0x8b);
  assert.equal(JSON.parse(zlib.gunzipSync(buf).toString('utf8')).short_message, 'hello');
});
