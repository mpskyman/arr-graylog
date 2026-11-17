'use strict';

const dgram = require('dgram');
const net = require('net');
const zlib = require('zlib');

// Syslog severity numbers used by GELF.
const SYSLOG_LEVEL = {
  fatal: 2, // critical
  error: 3,
  warn: 4,
  info: 6,
  debug: 7,
  trace: 7,
};

// Plain GELF over UDP is limited to 8192 bytes per datagram (chunking is not implemented here).
const UDP_MAX_BYTES = 8192;

/**
 * Convert one *arr log record into a GELF 1.1 message object.
 * @param {object} record  Record from the /log endpoint.
 * @param {{name: string, baseUrl: string}} service
 * @param {string} hostName  Host field reported to Graylog.
 */
function toGelf(record, service, hostName) {
  const level = String(record.level || 'info').toLowerCase();
  const timestamp = parseTimestamp(record.time);
  const message = record.message || '';

  const gelf = {
    version: '1.1',
    host: hostName,
    short_message: message.length > 0 ? message : `${service.name} log entry`,
    timestamp,
    level: SYSLOG_LEVEL[level] ?? 6,
    _service: service.name,
    _source_url: service.baseUrl,
    _level_name: level,
    _record_id: record.id,
  };

  if (record.logger) gelf._logger = record.logger;
  if (record.exception) gelf.full_message = record.exception;
  if (record.exceptionType) gelf._exception_type = record.exceptionType;
  // Graylog reserves "_id", so the *arr record id is stored as "_record_id".

  return gelf;
}

/**
 * *arr timestamps are ISO-8601 DateTimes. Values without an explicit zone are
 * treated as UTC. Returns epoch seconds with millisecond precision.
 */
function parseTimestamp(value) {
  if (!value) return Date.now() / 1000;
  let text = String(value);
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? Date.now() / 1000 : ms / 1000;
}

/**
 * Serialize a GELF message for a given transport.
 * UDP: gzip-compressed JSON datagram (Graylog auto-detects gzip).
 * TCP: JSON followed by a NUL byte delimiter.
 */
function encode(gelf, protocol) {
  const json = Buffer.from(JSON.stringify(gelf), 'utf8');
  if (protocol === 'tcp') {
    return Buffer.concat([json, Buffer.from([0])]);
  }
  return zlib.gzipSync(json);
}

/**
 * Create a sender that ships GELF messages to Graylog.
 * Returns { send(gelfObject) -> Promise<void>, close() }.
 */
function createSender({ host, port, protocol }) {
  if (protocol === 'udp') {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    return {
      send(gelf) {
        // Oversized UDP payloads cannot be sent without chunking. Trim the long
        // fields and retry once; drop the message if it is still too large.
        let payload = encode(gelf, 'udp');
        if (payload.length > UDP_MAX_BYTES) {
          const trimmed = { ...gelf };
          if (trimmed.full_message) trimmed.full_message = trimmed.full_message.slice(0, 2000);
          trimmed.short_message = trimmed.short_message.slice(0, 1000);
          payload = encode(trimmed, 'udp');
        }
        if (payload.length > UDP_MAX_BYTES) {
          return Promise.resolve(false);
        }
        return new Promise((resolve, reject) => {
          socket.send(payload, port, host, (err) => (err ? reject(err) : resolve(true)));
        });
      },
      close() {
        socket.close();
      },
    };
  }

  // TCP: one persistent connection, reconnected on demand.
  let conn = null;
  let connecting = null;

  function connect() {
    if (conn && !conn.destroyed) return Promise.resolve(conn);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        connecting = null;
        conn = socket;
        resolve(socket);
      });
      socket.once('error', (err) => {
        connecting = null;
        conn = null;
        reject(err);
      });
      socket.on('close', () => {
        if (conn === socket) conn = null;
      });
    });
    return connecting;
  }

  return {
    async send(gelf) {
      const socket = await connect();
      const payload = encode(gelf, 'tcp');
      await new Promise((resolve, reject) => {
        socket.write(payload, (err) => (err ? reject(err) : resolve()));
      });
      return true;
    },
    close() {
      if (conn) conn.destroy();
      conn = null;
    },
  };
}

module.exports = { toGelf, encode, parseTimestamp, createSender, SYSLOG_LEVEL, UDP_MAX_BYTES };
