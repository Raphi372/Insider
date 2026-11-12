'use strict';

// Gemeinsame Helfer der End-to-End-Tests: Steuerung des Mock-Servers,
// Zugriff auf den Protokoll-Dienst und auf die n8n-Webhooks.

const MOCK = process.env.MOCK_URL || 'http://mock:8080';
const JOURNAL = process.env.JOURNAL_URL || 'http://journal:8090';
const N8N = process.env.N8N_URL || 'http://n8n:5678';
const CHAT_ID = 4242;
const BRIDGE_SECRET = 'e2e-bridge-secret'; // wie in e2e.env

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function control(path, body) {
  const response = await fetch(`${MOCK}/__control/${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

const requests = (service) => control(`requests?service=${service}`);
const telegram = async (method) => (await requests('telegram')).filter((r) => r.path.endsWith(`/${method}`));
const emit = (...filings) => control('emit', filings);
const click = (data, messageId, extra = {}) => control('click', { data, messageId, fromId: CHAT_ID, ...extra });

async function waitFor(description, probe, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Zeitüberschreitung: ${description}`);
    await sleep(250);
  }
}

const waitForMessages = (count, timeoutMs) => waitFor(`${count} Telegram-Nachricht(en)`, async () => {
  const sent = await telegram('sendMessage');
  return sent.length >= count ? sent : null;
}, timeoutMs);

const buttons = (message) => ((message.body.reply_markup || {}).inline_keyboard || []).flat();

// Datenbank und Signal-Protokoll laufen als echter Dienst mit; sie werden zwischen den Szenarien nicht geleert.
const journal = (path) => fetch(`${JOURNAL}/${path}`).then((r) => r.json());
const loggedSignal = (accessionNo) => waitFor(`Protokolleintrag ${accessionNo}`, async () =>
  (await journal('signals')).find((entry) => entry.accessionNo === accessionNo));
const loggedEvent = (messageId, action) => waitFor(`Ereignis ${action} zu Nachricht ${messageId}`, async () =>
  (await journal('events')).find((event) => event.telegramMessageId === messageId && event.action === action));

/** Sendet an einen n8n-Webhook – mit dem Bridge-Secret, sofern keine anderen Header angegeben sind. */
const webhook = (path, body, headers = { 'x-bridge-token': BRIDGE_SECRET }) => fetch(`${N8N}/webhook/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** Wartet, bis die Bridge mit dem Stream verbunden ist – erst dann läuft n8n und der Workflow ist veröffentlicht. */
const bridgeConnected = () => waitFor('Bridge mit dem Stream verbunden', async () => {
  try { return (await control('status')).streamClients >= 1; } catch (err) { return false; }
}, 180000);

module.exports = {
  CHAT_ID, JOURNAL, sleep, control, requests, telegram, emit, click, waitFor, waitForMessages, buttons,
  journal, loggedSignal, loggedEvent, webhook, bridgeConnected,
};
