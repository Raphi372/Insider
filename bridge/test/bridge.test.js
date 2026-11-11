'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const { loadConfig } = require('../src/config');
const { postJson } = require('../src/forwarder');
const { SecStream } = require('../src/sec-stream');
const { TelegramPoller } = require('../src/telegram-poller');

const silentLog = { info() {}, warn() {}, error() {} };
const noSleep = () => Promise.resolve();

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: Zeitüberschreitung');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

// ---------------------------------------------------------------- config

test('loadConfig nennt alle fehlenden Pflichtvariablen', () => {
  assert.throws(() => loadConfig({ SEC_API_KEY: 'k' }), /BRIDGE_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/);
});

test('loadConfig setzt Standardwerte und entfernt abschließende Schrägstriche', () => {
  const config = loadConfig({
    SEC_API_KEY: 'k',
    BRIDGE_SECRET: 's',
    TELEGRAM_BOT_TOKEN: 't',
    TELEGRAM_CHAT_ID: '42',
    N8N_WEBHOOK_BASE_URL: 'http://n8n:5678/webhook/',
  });
  assert.equal(config.secStreamUrl, 'wss://stream.sec-api.io');
  assert.deepEqual(config.formTypes, ['4']);
  assert.equal(config.n8nWebhookBaseUrl, 'http://n8n:5678/webhook');
});

// ------------------------------------------------------------- forwarder

test('postJson wiederholt bei 5xx und sendet Header und Body', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(calls.length < 3 ? 503 : 200, {});
  };

  const result = await postJson('http://n8n/webhook/x', { a: 1 }, {
    headers: { 'x-bridge-token': 'secret' },
    fetchImpl,
    sleep: noSleep,
  });

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers['x-bridge-token'], 'secret');
  assert.equal(calls[0].init.body, '{"a":1}');
});

test('postJson wiederholt nicht bei 403 (falsches Secret)', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return jsonResponse(403, {});
  };
  const result = await postJson('http://n8n/webhook/x', {}, { fetchImpl, sleep: noSleep });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(count, 1);
});

test('postJson gibt nach erschöpften Versuchen den letzten Netzwerkfehler zurück', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    throw new Error('ECONNREFUSED');
  };
  const result = await postJson('http://n8n/webhook/x', {}, { fetchImpl, sleep: noSleep, attempts: 3 });
  assert.deepEqual(result, { ok: false, status: 0, error: 'ECONNREFUSED' });
  assert.equal(count, 3);
});

// ------------------------------------------------------------ sec stream

test('SecStream filtert auf Form 4, dedupliziert und verbindet sich neu', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  const requestUrls = [];
  server.on('connection', (_socket, request) => requestUrls.push(request.url));

  const received = [];
  const stream = new SecStream({
    url: `ws://127.0.0.1:${port}`,
    apiKey: 'my key',
    formTypes: ['4'],
    onFiling: (filing) => received.push(filing.accessionNo),
    log: silentLog,
    minBackoffMs: 10,
  });
  t.after(() => {
    stream.stop();
    server.close();
  });

  stream.start();
  await waitFor(() => server.clients.size === 1);
  assert.equal(requestUrls[0], '/?apiKey=my%20key');

  const [client] = server.clients;
  client.send(JSON.stringify([
    { accessionNo: 'A-1', formType: '4' },
    { accessionNo: 'B-1', formType: '8-K' },
    { accessionNo: 'A-1', formType: '4' },
    { accessionNo: 'C-1', formType: '4/A' },
  ]));
  client.send('kein json');
  client.send(JSON.stringify({ accessionNo: 'A-2', formType: '4' }));
  await waitFor(() => received.length === 2);
  assert.deepEqual(received, ['A-1', 'A-2']);

  // Server trennt die Verbindung – der Client muss von selbst zurückkommen.
  client.close();
  await waitFor(() => requestUrls.length === 2 && server.clients.size === 1);
  const [reconnected] = server.clients;
  reconnected.send(JSON.stringify([{ accessionNo: 'A-1', formType: '4' }, { accessionNo: 'A-3', formType: '4' }]));
  await waitFor(() => received.length === 3);
  assert.deepEqual(received, ['A-1', 'A-2', 'A-3']);
});

test('SecStream baut eine Verbindung ohne Pong neu auf', async (t) => {
  // autoPong: false simuliert eine hängende Gegenstelle.
  const server = new WebSocketServer({ port: 0, autoPong: false });
  await once(server, 'listening');
  let connections = 0;
  server.on('connection', () => { connections += 1; });

  const stream = new SecStream({
    url: `ws://127.0.0.1:${server.address().port}`,
    apiKey: 'k',
    onFiling: () => {},
    log: silentLog,
    pingIntervalMs: 20,
    pongTimeoutMs: 20,
    minBackoffMs: 10,
  });
  t.after(() => {
    stream.stop();
    server.close();
  });

  stream.start();
  await waitFor(() => connections >= 2);
});

// ------------------------------------------------------- telegram poller

function startTelegramMock(t, updatesQueue) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: req.url, method, body });
      res.setHeader('content-type', 'application/json');
      if (method === 'getUpdates') {
        const pending = updatesQueue.filter((u) => u.update_id >= (body.offset || 0));
        res.end(JSON.stringify({ ok: true, result: pending }));
      } else {
        res.end(JSON.stringify({ ok: true, result: true }));
      }
    });
  });
  server.listen(0);
  t.after(() => server.close());
  return { server, calls };
}

function callbackUpdate(updateId, fromId, data = 'o|AAPL|265598|10|187.5|172.5|215.63') {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: fromId },
      data,
      message: { message_id: 77, date: 1700000000, chat: { id: 42 } },
    },
  };
}

test('TelegramPoller leitet eigene Klicks weiter, bestätigt sie und entfernt die Buttons', async (t) => {
  const updates = [callbackUpdate(100, 42)];
  const { server, calls } = startTelegramMock(t, updates);
  await once(server, 'listening');

  const forwarded = [];
  const poller = new TelegramPoller({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'TOKEN',
    chatId: '42',
    onCallback: async (update) => {
      forwarded.push(update);
      return { ok: true, status: 200 };
    },
    log: silentLog,
    longPollSeconds: 0,
  });
  t.after(() => poller.stop());

  poller.start();
  await waitFor(() => calls.some((c) => c.method === 'editMessageReplyMarkup'));

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].callback_query.data, 'o|AAPL|265598|10|187.5|172.5|215.63');
  assert.ok(calls[0].url.startsWith('/botTOKEN/'));
  assert.deepEqual(calls[0].body.allowed_updates, ['callback_query']);

  const answer = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.equal(answer.body.callback_query_id, 'cq-100');

  const edit = calls.find((c) => c.method === 'editMessageReplyMarkup');
  assert.deepEqual(edit.body, { chat_id: 42, message_id: 77, reply_markup: { inline_keyboard: [] } });

  // Das Update gilt als bestätigt: Der nächste Abruf fragt ab update_id + 1.
  await waitFor(() => calls.filter((c) => c.method === 'getUpdates').some((c) => c.body.offset === 101));
  assert.equal(forwarded.length, 1);
});

test('TelegramPoller lehnt Klicks fremder Nutzer ab', async (t) => {
  const { server, calls } = startTelegramMock(t, [callbackUpdate(5, 999)]);
  await once(server, 'listening');

  let forwarded = 0;
  const poller = new TelegramPoller({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'TOKEN',
    chatId: '42',
    onCallback: async () => {
      forwarded += 1;
      return { ok: true, status: 200 };
    },
    log: silentLog,
    longPollSeconds: 0,
  });
  t.after(() => poller.stop());

  poller.start();
  await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'));

  assert.equal(forwarded, 0);
  assert.equal(calls.find((c) => c.method === 'answerCallbackQuery').body.show_alert, true);
  assert.equal(calls.some((c) => c.method === 'editMessageReplyMarkup'), false);
});

test('TelegramPoller lässt die Buttons stehen, wenn n8n nicht erreichbar ist', async (t) => {
  const { server, calls } = startTelegramMock(t, [callbackUpdate(7, 42)]);
  await once(server, 'listening');

  const poller = new TelegramPoller({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'TOKEN',
    chatId: '42',
    onCallback: async () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }),
    log: silentLog,
    longPollSeconds: 0,
  });
  t.after(() => poller.stop());

  poller.start();
  await waitFor(() => calls.some((c) => c.method === 'answerCallbackQuery'));
  await waitFor(() => calls.filter((c) => c.method === 'getUpdates').length >= 2);

  assert.match(calls.find((c) => c.method === 'answerCallbackQuery').body.text, /nicht erreichbar/);
  assert.equal(calls.some((c) => c.method === 'editMessageReplyMarkup'), false);
});

// ----------------------------------------------------------------- replay

const { pickReplayCandidate, findLatestPurchase } = require('../src/replay');

function replayFiling(accessionNo, ticker, transactions) {
  return { accessionNo, issuer: { tradingSymbol: ticker }, nonDerivativeTable: { transactions } };
}
const tx = (code, shares, price, acquired = 'A') => ({
  coding: { code }, amounts: { shares, pricePerShare: price, acquiredDisposedCode: acquired },
});

test('pickReplayCandidate wählt das erste Filing, das den Kauf-Filter passieren würde', () => {
  const filings = [
    replayFiling('A', 'SELL', [tx('S', 5000, 10, 'D')]),
    replayFiling('B', 'TINY', [tx('P', 500, 10)]),
    replayFiling('C', 'ZERO', [tx('P', 5000, 0)]),
    replayFiling('D', 'NONE', [tx('P', 5000, 10)]),
    replayFiling('E', 'GOOD', [tx('P', 600, 10), tx('P', 600, 11)]),
    replayFiling('F', 'ALSO', [tx('P', 9000, 10)]),
  ];
  assert.equal(pickReplayCandidate(filings, 1000).accessionNo, 'E');
  assert.equal(pickReplayCandidate(filings.slice(0, 4), 1000), null);
  assert.equal(pickReplayCandidate(undefined, 1000), null);
});

test('findLatestPurchase fragt die Insider-Trading-API nach Käufen und meldet HTTP-Fehler', async () => {
  const calls = [];
  const config = { secApiBaseUrl: 'https://sec.test', secApiKey: 'k y', minShares: 1000 };
  const ok = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ transactions: [replayFiling('E', 'GOOD', [tx('P', 2000, 5)])] }) };
  };

  assert.equal((await findLatestPurchase(config, ok)).accessionNo, 'E');
  assert.equal(calls[0].url, 'https://sec.test/insider-trading?token=k%20y');
  assert.match(calls[0].body.query, /coding\.code:P/);

  await assert.rejects(
    findLatestPurchase(config, async () => ({ ok: false, status: 401, json: async () => ({}) })),
    /HTTP 401/,
  );
});
