'use strict';

// Mock aller externen Dienste für den End-to-End-Test:
//   /stream          sec-api.io Stream (WebSocket)
//   /sec/...         sec-api.io REST (Insider-Trading, 13F-Holdings)
//   /yahoo...        Yahoo Finance (Cookie, Crumb, quoteSummary)
//   /anthropic/...   Anthropic Messages API
//   /telegram/...    Telegram Bot API
//   /ibkr/...        IBKR Client Portal API
//   /__control/...   Steuerung und Auswertung durch die Testszenarien

const http = require('node:http');
const { WebSocketServer } = require('ws');
const fixtures = require('./fixtures');

const PORT = Number(process.env.PORT || 8080);

const state = {
  requests: [],
  behavior: {},
  lookups: {},
  updates: [],
  nextUpdateId: 1000,
  nextMessageId: 500,
};

function reset() {
  state.requests = [];
  state.behavior = {};
  state.lookups = {};
  state.updates = [];
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'content-type': isText ? 'text/plain' : 'application/json', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ sec-api REST
function handleSec(req, res, url, body) {
  if (url.searchParams.get('token') !== 'e2e-sec-key') return send(res, 401, { error: 'invalid token' });
  const query = String((body || {}).query || '');

  if (url.pathname === '/sec/insider-trading') {
    const byAccession = query.match(/accessionNo:"([^"]+)"/);
    if (byAccession) {
      const accessionNo = byAccession[1];
      state.lookups[accessionNo] = (state.lookups[accessionNo] || 0) + 1;
      if (accessionNo === fixtures.BROKEN_ACCESSION) return send(res, 500, { error: 'internal error' });
      // Verzögerte Indexierung: der erste Abruf findet nichts.
      if (accessionNo === '0001000000-26-000005' && state.lookups[accessionNo] === 1) {
        return send(res, 200, { total: { value: 0, relation: 'eq' }, transactions: [] });
      }
      const doc = fixtures.FILINGS[accessionNo];
      return send(res, 200, { total: { value: doc ? 1 : 0, relation: 'eq' }, transactions: doc ? [doc] : [] });
    }
    const byOwner = query.match(/^issuer\.cik:(\d+) AND reportingOwner\.cik:(\d+)$/);
    if (byOwner) {
      const transactions = fixtures.history(byOwner[1]);
      return send(res, 200, { total: { value: transactions.length, relation: 'eq' }, transactions });
    }
    // Suche des Testlauf-Skripts (bridge/src/replay.js) nach dem jüngsten Kauf.
    if (query.startsWith('documentType:4 AND nonDerivativeTable.transactions.coding.code:P')) {
      const transactions = Object.values(fixtures.FILINGS);
      return send(res, 200, { total: { value: transactions.length, relation: 'eq' }, transactions });
    }
    return send(res, 400, { error: `unexpected query: ${query}` });
  }

  if (url.pathname === '/sec/form-13f/holdings') {
    const byTicker = query.match(/^holdings\.ticker:(\S+)$/);
    if (!byTicker) return send(res, 400, { error: `unexpected query: ${query}` });
    const data = fixtures.institutionalHoldings(byTicker[1]);
    return send(res, 200, { total: { value: data.length, relation: 'eq' }, data });
  }

  return send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------- Yahoo Finance
function handleYahoo(req, res, url) {
  if (state.behavior.yahooDown) return send(res, 503, 'Service Unavailable');
  const cookie = String(req.headers.cookie || '');

  // Wie fc.yahoo.com: antwortet mit 404, setzt aber das Cookie.
  if (url.pathname === '/yahoo-cookie' || url.pathname === '/yahoo-cookie/') {
    return send(res, 404, 'Not Found', { 'set-cookie': ['A3=e2e-cookie; Max-Age=31557600; Path=/; HttpOnly', 'B=other; Path=/'] });
  }
  if (!cookie.includes('A3=e2e-cookie')) return send(res, 401, { finance: { error: { code: 'Unauthorized', description: 'Invalid Cookie' } } });

  if (url.pathname === '/yahoo/v1/test/getcrumb') return send(res, 200, 'CRUMB-123');

  const summary = url.pathname.match(/^\/yahoo\/v10\/finance\/quoteSummary\/([^/]+)$/);
  if (summary) {
    if (url.searchParams.get('crumb') !== 'CRUMB-123') return send(res, 401, { finance: { error: { code: 'Unauthorized', description: 'Invalid Crumb' } } });
    return send(res, 200, fixtures.quoteSummary(summary[1]));
  }
  return send(res, 404, 'not found');
}

// -------------------------------------------------------------- Anthropic
function handleAnthropic(req, res, url, body) {
  if (url.pathname !== '/anthropic/v1/messages') return send(res, 404, { error: 'not found' });
  if (state.behavior.anthropicStatus) {
    return send(res, state.behavior.anthropicStatus, { type: 'error', error: { type: 'api_error', message: 'Internal server error' } });
  }
  if (req.headers['x-api-key'] !== 'sk-ant-e2e') {
    return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  }
  // Wie die echte API: Sampling-Parameter und Prefill führen zu einem 400.
  const invalid = ['temperature', 'top_p', 'top_k'].find((key) => key in (body || {}));
  const lastMessage = ((body || {}).messages || []).slice(-1)[0] || {};
  if (invalid || lastMessage.role !== 'user') {
    return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: `unsupported: ${invalid || 'prefill'}` } });
  }
  return send(res, 200, {
    id: 'msg_e2e',
    type: 'message',
    role: 'assistant',
    model: body.model,
    // Vor dem Text steht ein thinking-Block – der Workflow muss nach Typ suchen.
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: JSON.stringify(fixtures.LLM_VERDICT) },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 900, output_tokens: 180 },
  });
}

// --------------------------------------------------------------- Telegram
async function handleTelegram(req, res, url, body) {
  const match = url.pathname.match(/^\/telegram\/bot([^/]+)\/(\w+)$/);
  if (!match) return send(res, 404, { ok: false, description: 'Not Found' });
  if (match[1] !== '111:E2E') return send(res, 401, { ok: false, description: 'Unauthorized' });
  const method = match[2];

  if (method === 'getUpdates') {
    // Long Polling: bis zu 2 s auf ein Update warten.
    const deadline = Date.now() + 2000;
    const pending = () => state.updates.filter((u) => u.update_id >= ((body || {}).offset || 0));
    while (pending().length === 0 && Date.now() < deadline) await sleep(100);
    return send(res, 200, { ok: true, result: pending() });
  }
  if (method === 'sendMessage') {
    state.nextMessageId += 1;
    return send(res, 200, {
      ok: true,
      result: { message_id: state.nextMessageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id), type: 'private' }, text: body.text },
    });
  }
  return send(res, 200, { ok: true, result: true });
}

// ------------------------------------------------------------------- IBKR
function handleIbkr(req, res, url, body) {
  const path = url.pathname.replace(/^\/ibkr/, '');

  if (path === '/v1/api/trsrv/stocks') {
    const symbol = url.searchParams.get('symbols');
    const known = { ACME: 111, LATE: 222, DOWN: 333, REJ: 444 };
    const listings = known[symbol]
      ? [{ name: `${symbol} CORP`, chineseName: null, assetClass: 'STK', contracts: [
        { conid: 9000 + known[symbol], exchange: 'MEXI', isUS: false },
        { conid: known[symbol], exchange: 'NYSE', isUS: true },
      ] }]
      : [];
    return send(res, 200, { [symbol]: listings });
  }

  if (/^\/v1\/api\/iserver\/account\/[^/]+\/orders$/.test(path) && req.method === 'POST') {
    const parent = ((body || {}).orders || [])[0] || {};
    if (parent.conid === 444) return send(res, 401, { error: 'not authenticated' });
    // Erst eine Rückfrage, wie sie IBKR bei Vorsichtsmeldungen stellt.
    return send(res, 200, [{
      id: 'reply-1',
      message: ['This order will most likely trigger and fill immediately.\nAre you sure you want to submit this order?'],
      isSuppressed: false,
      messageIds: ['o163'],
    }]);
  }

  if (path === '/v1/api/iserver/reply/reply-1' && req.method === 'POST') {
    if (!(body && body.confirmed === true)) return send(res, 400, { error: 'confirmed missing' });
    return send(res, 200, [
      { order_id: '1001', order_status: 'PreSubmitted', encrypt_message: '1' },
      { order_id: '1002', order_status: 'PreSubmitted', encrypt_message: '1' },
      { order_id: '1003', order_status: 'PreSubmitted', encrypt_message: '1' },
    ]);
  }

  return send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- Control
function handleControl(req, res, url, body, wss) {
  switch (url.pathname) {
    case '/__control/status':
      return send(res, 200, { streamClients: wss.clients.size, requests: state.requests.length });
    case '/__control/reset':
      reset();
      return send(res, 200, { ok: true });
    case '/__control/behavior':
      Object.assign(state.behavior, body || {});
      return send(res, 200, state.behavior);
    case '/__control/emit': {
      const message = JSON.stringify(body);
      for (const client of wss.clients) client.send(message);
      return send(res, 200, { clients: wss.clients.size });
    }
    case '/__control/click': {
      state.nextUpdateId += 1;
      state.updates.push({
        update_id: state.nextUpdateId,
        callback_query: {
          id: `cq-${state.nextUpdateId}`,
          from: { id: body.fromId, is_bot: false, first_name: 'Test' },
          data: body.data,
          message: {
            message_id: body.messageId,
            date: body.date || Math.floor(Date.now() / 1000),
            chat: { id: 4242, type: 'private' },
          },
        },
      });
      return send(res, 200, { update_id: state.nextUpdateId });
    }
    case '/__control/requests': {
      const service = url.searchParams.get('service');
      return send(res, 200, state.requests.filter((r) => !service || r.service === service));
    }
    default:
      return send(res, 404, { error: 'not found' });
  }
}

// ----------------------------------------------------------------- Server
const wss = new WebSocketServer({ noServer: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (err) { body = raw; }

    const service = url.pathname.split('/')[1].replace(/^yahoo-cookie$/, 'yahoo');
    if (service !== '__control') {
      state.requests.push({
        service,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      });
    }

    try {
      if (service === '__control') return handleControl(req, res, url, body, wss);
      if (service === 'sec') return handleSec(req, res, url, body);
      if (service === 'yahoo') return handleYahoo(req, res, url);
      if (service === 'anthropic') return handleAnthropic(req, res, url, body);
      if (service === 'telegram') return await handleTelegram(req, res, url, body);
      if (service === 'ibkr') return handleIbkr(req, res, url, body);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://mock');
  if (url.pathname !== '/stream' || url.searchParams.get('apiKey') !== 'e2e-sec-key') {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.listen(PORT, () => console.log(`Mock-Server lauscht auf Port ${PORT}`));
process.on('SIGTERM', () => process.exit(0));
