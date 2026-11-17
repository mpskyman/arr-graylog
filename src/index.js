#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { createSender } = require('./gelf');
const { ServicePoller } = require('./poller');

const logger = {
  info: (msg) => console.log(`${new Date().toISOString()} INFO  ${msg}`),
  warn: (msg) => console.warn(`${new Date().toISOString()} WARN  ${msg}`),
  error: (msg) => console.error(`${new Date().toISOString()} ERROR ${msg}`),
};

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  const sender = createSender(config.graylog);
  const pollers = config.services.map(
    (service) => new ServicePoller({ service, config, sender, logger }),
  );

  logger.info(
    `Forwarding ${config.services.map((s) => s.name).join(', ')} logs (min level ${config.minLevel}) ` +
      `to Graylog ${config.graylog.protocol}://${config.graylog.host}:${config.graylog.port} every ${config.pollIntervalMs / 1000}s`,
  );

  let running = true;
  let timer = null;

  async function pollAll() {
    for (const poller of pollers) {
      try {
        const sent = await poller.poll();
        if (sent > 0) logger.info(`${poller.service.name}: forwarded ${sent} log entries`);
      } catch (err) {
        logger.error(`${poller.service.name}: poll failed: ${err.message}`);
      }
    }
    if (running) timer = setTimeout(pollAll, config.pollIntervalMs);
  }

  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down`);
    running = false;
    if (timer) clearTimeout(timer);
    sender.close();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  pollAll();
}

main();
