'use strict';

const log = require('./log');
const { loadConfig } = require('./config');
const { postJson } = require('./forwarder');
const { SecStream } = require('./sec-stream');
const { TelegramPoller } = require('./telegram-poller');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  const headers = { 'x-bridge-token': config.bridgeSecret };
  const forward = (path, payload, options = {}) =>
    postJson(`${config.n8nWebhookBaseUrl}/${path}`, payload, { headers, log, ...options });

  const stream = new SecStream({
    url: config.secStreamUrl,
    apiKey: config.secApiKey,
    formTypes: config.formTypes,
    log,
    onFiling: async (filing) => {
      const result = await forward('sec-filing', filing);
      const label = `Form ${filing.formType} ${filing.accessionNo || filing.id} (${filing.ticker || filing.companyName || 'unbekannt'})`;
      if (result.ok) {
        log.info(`${label} an n8n übergeben`);
      } else {
        const hint = result.status === 404 ? ' – ist der Workflow in n8n veröffentlicht (aktiv)?' : '';
        log.error(`${label} konnte nicht an n8n übergeben werden: ${result.error}${hint}`);
      }
    },
  });

  const poller = new TelegramPoller({
    baseUrl: config.telegramBaseUrl,
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
    log,
    // Der Nutzer wartet auf Rückmeldung – deshalb nur kurz wiederholen.
    onCallback: (update) => forward('order-confirm', update, { attempts: 2, baseDelayMs: 500 }),
  });

  const shutdown = (signal) => {
    log.info(`${signal} empfangen – Bridge wird beendet`);
    stream.stop();
    poller.stop();
    // Laufende Weiterleitungen kurz ausliefern lassen.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info(`Bridge gestartet, Ziel: ${config.n8nWebhookBaseUrl}`);
  stream.start();
  poller.start();
}

main();
