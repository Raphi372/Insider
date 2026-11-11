'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { PriceClient, parseChart, splitFactorAfter, yahooSymbol } = require('../src/prices');
const { SecApiClient, monthWindows } = require('../src/sec-api');
const { createJournal, createServer } = require('../src/journal');
const { runBacktest } = require('../src/backtest');
const { runReport, decisionsByMessage } = require('../src/report');
const { parseArgs, buildParams } = require('../src/cli');
const { makeBars, signal, jsonResponse } = require('./helpers');

const noSleep = () => Promise.resolve();
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insider-research-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------ Kursdaten

/** Antwort im Format der Yahoo-Chart-API. */
function chart(bars, { splits, gmtoffset = -18000 } = {}) {
  const timestamp = (date) => Date.parse(`${date}T14:30:00Z`) / 1000; // 9:30 Uhr New York (Winterzeit)
  return { chart: { error: null, result: [{
    meta: { symbol: 'X', gmtoffset, exchangeTimezoneName: 'America/New_York' },
    timestamp: bars.map((b) => timestamp(b.date)),
    events: splits ? { splits: Object.fromEntries(splits.map((s) => [String(timestamp(s.date)), { date: timestamp(s.date), numerator: s.numerator, denominator: s.denominator }])) } : undefined,
    indicators: { quote: [{
      open: bars.map((b) => b.open), high: bars.map((b) => b.high), low: bars.map((b) => b.low),
      close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
    }] },
  }] } };
}

test('parseChart liest Kerzen und Splits, überspringt Lücken und rechnet Zeitstempel in Börsentage um', () => {
  const bars = makeBars('2024-03-04', 3);
  const json = chart(bars, { splits: [{ date: '2024-03-05', numerator: 4, denominator: 1 }] });
  json.chart.result[0].indicators.quote[0].close[1] = null; // Yahoo liefert Lücken als null

  const parsed = parseChart(json);
  assert.deepEqual(parsed.bars.map((b) => b.date), ['2024-03-04', '2024-03-06']);
  assert.deepEqual(parsed.splits, [{ date: '2024-03-05', numerator: 4, denominator: 1 }]);
  assert.deepEqual(parseChart({ chart: { result: null } }), { bars: [], splits: [] });
});

test('splitFactorAfter berücksichtigt nur Splits nach dem Kauf', () => {
  const splits = [{ date: '2023-06-01', numerator: 2, denominator: 1 }, { date: '2024-06-01', numerator: 4, denominator: 1 }, { date: '2025-01-10', numerator: 1, denominator: 10 }];
  assert.equal(splitFactorAfter(splits, '2024-01-01'), (1 / 4) * 10);
  assert.equal(splitFactorAfter(splits, '2025-06-01'), 1);
  assert.equal(yahooSymbol('brk.b'), 'BRK-B');
});

test('PriceClient: Cache, unbekannte Titel, Anmeldung bei 401 und Wiederholung bei 429', async (t) => {
  const cacheDir = tempDir(t);
  const bars = makeBars('2024-03-04', 5);
  const calls = [];
  const responses = {
    ACME: [jsonResponse(429, {}), jsonResponse(200, chart(bars))],
    GONE: [jsonResponse(404, { chart: { result: null, error: { code: 'Not Found' } } })],
    AUTH: [jsonResponse(401, {}), jsonResponse(200, chart(bars))],
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, cookie: init.headers.cookie });
    if (url === 'https://cookie.test') return jsonResponse(404, 'x', { 'set-cookie': ['A3=abc; Path=/', 'B=1; Path=/'] });
    if (url.endsWith('/v1/test/getcrumb')) return jsonResponse(200, 'CRUMB');
    return responses[url.match(/chart\/([^?]+)/)[1]].shift();
  };
  const client = new PriceClient({ baseUrl: 'https://yahoo.test/', cookieUrl: 'https://cookie.test', cacheDir, fetchImpl, sleep: noSleep });

  const acme = await client.getBars('ACME', '2024-03-01', '2024-03-08');
  assert.equal(acme.bars.length, 5);
  const firstUrl = new URL(calls[0].url);
  assert.equal(firstUrl.pathname, '/v8/finance/chart/ACME');
  assert.equal(firstUrl.searchParams.get('period1'), String(Date.parse('2024-03-01T00:00:00Z') / 1000));
  assert.equal(firstUrl.searchParams.get('interval'), '1d');

  const before = calls.length;
  assert.equal((await client.getBars('ACME', '2024-03-01', '2024-03-08')).bars.length, 5);
  assert.equal(calls.length, before, 'zweiter Abruf kommt aus dem Cache');

  assert.equal(await client.getBars('GONE', '2024-03-01', '2024-03-08'), null);
  assert.equal(await client.getBars('GONE', '2024-03-01', '2024-03-08'), null);
  assert.equal(calls.filter((c) => c.url.includes('/GONE')).length, 1, 'auch der Fehlschlag wird gemerkt');

  await client.getBars('AUTH', '2024-03-01', '2024-03-08');
  const authCalls = calls.filter((c) => c.url.includes('/AUTH'));
  assert.equal(authCalls[0].cookie, undefined);
  assert.equal(authCalls[1].cookie, 'A3=abc; B=1');
  assert.equal(new URL(authCalls[1].url).searchParams.get('crumb'), 'CRUMB');
});

// --------------------------------------------------------------- sec-api

const filing = (accessionNo, filedAt, { code = 'P', shares = 5000, price = 10, ticker = 'ACME' } = {}) => ({
  accessionNo,
  filedAt,
  issuer: { cik: '1', name: 'ACME Corp', tradingSymbol: ticker },
  reportingOwner: { cik: '100', name: 'Doe Jane', relationship: { isOfficer: true, officerTitle: 'CEO' } },
  nonDerivativeTable: { transactions: [{
    transactionDate: filedAt.slice(0, 10), coding: { code },
    amounts: { shares, pricePerShare: price, acquiredDisposedCode: code === 'S' ? 'D' : 'A' },
    postTransactionAmounts: { sharesOwnedFollowingTransaction: 20000 },
    ownershipNature: { directOrIndirectOwnership: 'D' },
  }] },
});

/** Attrappe der Insider-Trading-API: filtert nach filedAt und blättert seitenweise. */
function fakeSecApi(filings) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const [, from, to] = body.query.match(/filedAt:\[(\S+) TO (\S+)\]/);
    const hits = filings.filter((f) => f.filedAt.slice(0, 10) >= from && f.filedAt.slice(0, 10) <= to)
      .sort((a, b) => a.filedAt.localeCompare(b.filedAt));
    return jsonResponse(200, { total: { value: hits.length, relation: 'eq' }, transactions: hits.slice(body.from, body.from + body.size) });
  };
  return { fetchImpl, requests };
}

test('monthWindows überlappt die Fenster um einen Tag', () => {
  assert.deepEqual(monthWindows('2024-01-15', '2024-03-10'), [['2024-01-15', '2024-02-01'], ['2024-02-01', '2024-03-01'], ['2024-03-01', '2024-03-10']]);
  assert.deepEqual(monthWindows('2024-12-01', '2024-12-31'), [['2024-12-01', '2024-12-31']]);
});

test('SecApiClient: blättert, entfernt Dubletten an Fenstergrenzen, verwirft Nicht-Käufe und nutzt den Cache', async (t) => {
  const cacheDir = tempDir(t);
  const filings = [];
  for (let i = 0; i < 120; i += 1) filings.push(filing(`jan-${i}`, `2024-01-${String(2 + (i % 28)).padStart(2, '0')}T17:00:00-05:00`));
  filings.push(filing('grenze', '2024-02-01T08:00:00-05:00')); // liegt in zwei Fenstern
  filings.push(filing('verkauf', '2024-02-10T17:00:00-05:00', { code: 'S' }));
  filings.push(filing('ohne-preis', '2024-02-11T17:00:00-05:00', { price: 0 }));
  filings.push(filing('ohne-ticker', '2024-02-12T17:00:00-05:00', { ticker: 'NONE' }));
  filings.push(filing('klein', '2024-02-13T17:00:00-05:00', { shares: 10 }));
  const api = fakeSecApi(filings);
  const client = new SecApiClient({ baseUrl: 'https://sec.test', apiKey: 'k y', cacheDir, fetchImpl: api.fetchImpl, sleep: noSleep });

  const signals = await client.fetchPurchases('2024-01-01', '2024-02-29');
  assert.equal(signals.length, 122, '120 + Grenzfall + Kleinkauf; Verkauf, Preis 0 und fehlender Ticker fallen weg');
  assert.equal(signals.filter((s) => s.accessionNo === 'grenze').length, 1);
  assert.ok(signals.every((s, i) => i === 0 || signals[i - 1].filedAt <= s.filedAt), 'nach Meldezeit sortiert');
  assert.equal(signals[0].footnotes, undefined, 'der Cache enthält nur, was die Auswertung braucht');

  assert.equal(api.requests[0].url, 'https://sec.test/insider-trading?token=k%20y');
  assert.equal(api.requests[0].body.query, 'documentType:4 AND nonDerivativeTable.transactions.coding.code:P AND filedAt:[2024-01-01 TO 2024-02-01]');
  assert.deepEqual(api.requests.slice(0, 3).map((r) => r.body.from), [0, 50, 100]);

  const before = api.requests.length;
  await client.fetchPurchases('2024-01-01', '2024-02-29');
  assert.equal(api.requests.length, before, 'abgeschlossene Monate kommen aus dem Cache');
});

test('SecApiClient teilt ein Fenster, das die Treffergrenze der Suche erreicht', async () => {
  const filings = [];
  for (let i = 0; i < 130; i += 1) filings.push(filing(`f-${i}`, `2024-01-${String(1 + (i % 31)).padStart(2, '0')}T17:00:00-05:00`));
  const api = fakeSecApi(filings);
  const client = new SecApiClient({ apiKey: 'k', fetchImpl: api.fetchImpl, sleep: noSleep, maxOffset: 100 });

  const signals = await client.fetchPurchases('2024-01-01', '2024-01-31');
  assert.equal(signals.length, 130);
  assert.ok(api.requests.some((r) => r.body.query.includes('filedAt:[2024-01-01 TO 2024-01-16]')), 'Fenster wurde halbiert');
});

test('SecApiClient bricht bei abgelehntem API-Key sofort ab', async () => {
  let calls = 0;
  const client = new SecApiClient({ apiKey: 'falsch', sleep: noSleep, fetchImpl: async () => { calls += 1; return jsonResponse(401, {}); } });
  await assert.rejects(client.fetchPurchases('2024-01-01', '2024-01-31'), /SEC_API_KEY/);
  assert.equal(calls, 1);
});

// --------------------------------------------------------------- Journal

test('Journal: hängt an, behält bei Wiederholungen den letzten Eintrag und übersteht beschädigte Zeilen', (t) => {
  const dir = tempDir(t);
  const journal = createJournal(dir);
  journal.assertWritable();
  journal.appendSignal({ accessionNo: 'a', rating: 'SCHWACH', form4: {} });
  journal.appendSignal({ accessionNo: 'b', rating: 'STARK', form4: {} });
  fs.appendFileSync(path.join(dir, 'signals.jsonl'), '{"halb\n');
  journal.appendSignal({ accessionNo: 'a', rating: 'MITTEL', form4: {} });
  journal.appendEvent({ action: 'discard', telegramMessageId: 7 });

  const signals = journal.readSignals();
  assert.deepEqual(signals.map((s) => [s.accessionNo, s.rating]), [['a', 'MITTEL'], ['b', 'STARK']]);
  assert.match(signals[0].loggedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(journal.readEvents().length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'signals.jsonl'), 'utf8').trim().split('\n').length, 4, 'es wird nur angehängt');
});

test('Journal-Dienst nimmt Signale und Ereignisse per HTTP an und prüft Pflichtfelder', async (t) => {
  const journal = createJournal(tempDir(t));
  const server = createServer(journal);
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await post('/signals', { accessionNo: 'a', rating: 'STARK', form4: { ticker: 'ACME' } })).status, 201);
  assert.equal((await post('/signals', { rating: 'STARK' })).status, 400);
  assert.equal((await post('/signals', 'kein json')).status, 400);
  assert.equal((await post('/events', { action: 'order', placed: true, telegramMessageId: 5 })).status, 201);
  assert.equal((await post('/events', {})).status, 400);
  assert.equal((await fetch(`${base}/unbekannt`)).status, 404);

  assert.equal((await (await fetch(`${base}/signals`)).json())[0].accessionNo, 'a');
  assert.equal((await (await fetch(`${base}/events`)).json())[0].placed, true);
});

// -------------------------------------------------------------- Backtest

/** Kursdaten-Attrappe: liefert vorbereitete Kerzen je Ticker. */
const fakePrices = (byTicker) => ({ getBars: async (ticker) => (byTicker[ticker] ? { bars: byTicker[ticker], splits: [] } : null) });

const BACKTEST = {
  from: '2024-03-01', to: '2024-03-31', minShares: 1000, stopLossPct: 8, takeProfitPct: 15, maxHoldDays: 20,
  limitValidDays: 10, costBps: 10, lookbackYears: 0, clusterDays: 14, benchmark: 'SPY', horizons: [5, 20],
};

test('Backtest: Filter, Renditen, Order-Regeln, Merkmale und Dateien', async (t) => {
  const outDir = tempDir(t);
  // UP steigt nach dem Filing täglich um 1 $, DOWN fällt um 1 $, der Index bleibt flach.
  const start = 110;
  const up = makeBars('2023-10-02', 200, (i) => (i < start ? 100 : 100 + (i - start)));
  const down = makeBars('2023-10-02', 200, (i) => (i < start ? 100 : 100 - (i - start)));
  const flat = makeBars('2023-10-02', 200, () => 400);
  const filedAt = `${up[start - 1].date}T17:00:00-05:00`;
  assert.ok(filedAt >= '2024-03-01' && filedAt <= '2024-03-31');

  const base = { filedAt, purchase: { avgPrice: 100, lastDate: up[start - 2].date } };
  const universe = [
    signal({ ...base, accessionNo: 'up', ticker: 'UP', issuerCik: '1', insiderCik: '100' }),
    signal({ ...base, accessionNo: 'down', ticker: 'DOWN', issuerCik: '2', insiderCik: '200', role: 'Director', isOfficer: false, isDirector: true }),
    signal({ ...base, accessionNo: 'klein', ticker: 'UP', issuerCik: '1', insiderCik: '300', purchase: { ...base.purchase, shares: 500 } }),
    signal({ ...base, accessionNo: 'weg', ticker: 'GONE', issuerCik: '3', insiderCik: '400' }),
  ];
  const fetched = [];
  const secApi = { fetchPurchases: async (from, to) => { fetched.push([from, to]); return universe; } };

  const { report, trades, excluded } = await runBacktest({ ...BACKTEST, outDir }, { secApi, prices: fakePrices({ UP: up, DOWN: down, SPY: flat }) });

  assert.deepEqual(fetched, [['2024-03-01', '2024-03-31']]);
  assert.deepEqual(excluded, { 'keine Kursdaten': 1 });
  assert.match(report, /Insiderkäufe im Zeitraum \(alle Größen\): 4/);
  assert.match(report, /davon über dem Filter: 3/);
  assert.match(report, /auswertbar: 2/);
  assert.match(report, /Achtung: Zu 1 von 3 Signalen liefert Yahoo keine Kurse/);

  // Signalwert: UP +5 % und DOWN −5 % nach 5 Tagen -> im Mittel 0, einer von zwei besser als der Index.
  assert.match(report, /\| 5 Handelstage\s+\|\s+2 \|\s+0,0 % \|\s+0,0 % \|\s+0,0 % \|\s+0,0 % \|\s+50 % \|/);

  const byId = Object.fromEntries(trades.map((trade) => [trade.accessionNo, trade]));
  assert.equal(byId.up.ret5, 0.05);
  assert.equal(byId.up.excess20, 0.2);
  assert.equal(byId.down.ret20, -0.2);

  // Order-Regeln: Marktorder trifft bei UP das Ziel (+15 %), bei DOWN den Stop (−8 %), je minus 0,2 % Kosten.
  assert.deepEqual([byId.up.marketBracketExit, byId.up.marketBracketRet], ['target', 0.148]);
  assert.deepEqual([byId.down.marketBracketExit, byId.down.marketBracketRet], ['stop', -0.082]);
  // Limit zum Insiderpreis (100 $): Beide eröffnen genau dort und werden ausgeführt.
  assert.equal(byId.up.limitBracketFilled, 'ja');
  assert.equal(byId.up.holdRet, 0.198);

  // Merkmale: Der Kleinkauf eines zweiten Insiders macht "up" zum Cluster-Kauf.
  assert.equal(byId.up.cluster, 'Cluster (mehrere Insider)');
  assert.equal(byId.down.cluster, 'Einzelkauf');
  assert.equal(byId.up.role, 'CEO/CFO/President');
  assert.equal(byId.down.role, 'Director');
  assert.equal(byId.up.routine, 'unbekannt (Historie zu kurz)');
  assert.match(report, /\| Director\s+\|\s+1 \|\s+−20,0 % \|/, 'Merkmalstabellen zeigen die 20-Tage-Überrendite');

  assert.equal(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'), `${report}\n`);
  const csv = fs.readFileSync(path.join(outDir, 'trades.csv'), 'utf8');
  assert.ok(csv.startsWith('﻿accessionNo;filedAt;ticker;'));
  assert.match(csv, /\r\nup;[^\r]*;0,05;/);
});

test('Backtest lädt für die Routine-Erkennung die Vorjahre, wertet sie aber nicht als Signale', async () => {
  const bars = makeBars('2023-10-02', 200);
  const filedAt = `${bars[109].date}T17:00:00-05:00`;
  const month = filedAt.slice(5, 10);
  const buy = (year) => signal({ accessionNo: `y${year}`, ticker: 'UP', filedAt: `${year}-${month}T17:00:00-05:00` });
  const fetched = [];
  const secApi = { fetchPurchases: async (from, to) => { fetched.push([from, to]); return [buy(2021), buy(2022), buy(2023), signal({ accessionNo: 'jetzt', ticker: 'UP', filedAt })]; } };

  const { trades, report } = await runBacktest({ ...BACKTEST, lookbackYears: 3 }, { secApi, prices: fakePrices({ UP: bars, SPY: bars }) });

  assert.equal(fetched[0][0], '2021-03-01');
  assert.equal(trades.length, 1);
  assert.equal(trades[0].routine, 'Routinekäufer');
  assert.match(report, /Insiderkäufe im Zeitraum \(alle Größen\): 1/);
});

test('Backtest ohne Treffer endet mit einem Hinweis statt mit einem Fehler', async () => {
  const { report, trades } = await runBacktest(BACKTEST, { secApi: { fetchPurchases: async () => [] }, prices: fakePrices({ SPY: makeBars('2023-10-02', 200) }) });
  assert.match(report, /Keine auswertbaren Signale/);
  assert.deepEqual(trades, []);
});

// ------------------------------------------------- Auswertung des Protokolls

test('decisionsByMessage: gesendete Order schlägt Ablehnung schlägt Verwerfen', () => {
  const decisions = decisionsByMessage([
    { action: 'discard', telegramMessageId: 1 },
    { action: 'order', placed: false, telegramMessageId: 2 },
    { action: 'order', placed: true, telegramMessageId: 2 },
    { action: 'discard', telegramMessageId: 2 },
    { action: 'invalid', telegramMessageId: 3 },
    { action: 'order', placed: true, telegramMessageId: null },
  ]);
  assert.deepEqual([...decisions], [['1', 'verworfen'], ['2', 'Order gesendet']]);
});

test('Auswertung des Protokolls: je Einstufung und Entscheidung, noch offene Haltedauern bleiben leer', async (t) => {
  const dir = tempDir(t);
  const journal = createJournal(dir);
  // Kerzen bis heute: 40 Handelstage zurück gemeldet -> 5 und 20 Tage abgelaufen, 60 noch nicht.
  const all = makeBars('2020-01-01', 2500).filter((b) => b.date <= today());
  const bars = all.slice(-170).map((b, i, list) => ({ ...b, ...(i >= list.length - 40 ? { open: 100 + (i - (list.length - 40)), close: 100 + (i - (list.length - 40)) } : {}) }));
  const flat = bars.map((b) => ({ ...b, open: 400, close: 400 }));
  const filedAt = `${bars[bars.length - 41].date}T17:00:00-05:00`;
  const recent = `${bars[bars.length - 1].date}T17:00:00-05:00`;

  const entry = (accessionNo, ticker, rating, messageId, overrides = {}) => ({
    accessionNo, telegramMessageId: messageId, rating, order: { ticker }, form4: signal({ accessionNo, ticker, filedAt, ...overrides }),
  });
  journal.appendSignal(entry('a', 'UP', 'STARK', 11));
  journal.appendSignal(entry('b', 'UP', 'SCHWACH', 12));
  journal.appendSignal({ ...entry('c', 'UP', null, 13), order: null });
  journal.appendSignal(entry('d', 'UP', 'MITTEL', 14, { filedAt: recent }));
  journal.appendEvent({ action: 'order', placed: true, telegramMessageId: 11 });
  journal.appendEvent({ action: 'discard', telegramMessageId: 12 });

  const params = { benchmark: 'SPY', horizons: [5, 20, 60], stopLossPct: 8, takeProfitPct: 15, maxHoldDays: 60, limitValidDays: 20, costBps: 10, outDir: dir };
  const { report, records } = await runReport(params, { journal, prices: fakePrices({ UP: bars, SPY: flat }) });

  assert.match(report, /4 Signale protokolliert, 3 mit Kursdaten/);
  assert.match(report, /\| 5 Handelstage\s+\|\s+3 \|\s+\+5,0 % \|/);
  assert.match(report, /\| 60 Handelstage\s+\|\s+0 \|\s+– \|/);
  assert.match(report, /\| STARK\s+\|\s+1 \|\s+\+5,0 % \|\s+1 \|\s+\+20,0 % \|\s+0 \|\s+– \|/);
  assert.match(report, /\| Order gesendet\s+\|\s+1 \|/);
  assert.match(report, /\| verworfen\s+\|\s+1 \|/);
  assert.match(report, /\| kein Order-Vorschlag\s+\|\s+1 \|/);
  assert.match(report, /\| MITTEL\s+\| keine Reaktion\s+\| kein Handelstag nach dem Filing/);

  const byId = Object.fromEntries(records.map((r) => [r.accessionNo, r]));
  assert.deepEqual([byId.a.decision, byId.a.excess5, byId.a.excess20, byId.a.excess60], ['Order gesendet', 0.05, 0.2, null]);
  assert.equal(byId.d.status, 'kein Handelstag nach dem Filing');
  assert.ok(fs.existsSync(path.join(dir, 'signals-report.csv')));
});

test('Auswertung ohne Einträge erklärt, dass das Protokoll noch leer ist', async (t) => {
  const { report } = await runReport({ horizons: [5] }, { journal: createJournal(tempDir(t)), prices: fakePrices({}) });
  assert.match(report, /Noch keine Signale protokolliert/);
});

// ------------------------------------------------------------ Kommandozeile

test('Kommandozeile: Optionen, Standardwerte aus der .env und klare Fehlermeldungen', () => {
  assert.deepEqual(parseArgs(['--from', '2024-01-01', '--max-hold=40']), { from: '2024-01-01', 'max-hold': '40' });
  assert.throws(() => parseArgs(['backtest']), /Unbekanntes Argument/);
  assert.throws(() => parseArgs(['--from']), /Wert für --from fehlt/);

  const params = buildParams({ from: '2024-01-01', to: '2024-12-31', 'max-hold': '40' }, { STOP_LOSS_PCT: '5', DATA_DIR: '/data' }, 'backtest');
  assert.deepEqual(
    [params.from, params.to, params.maxHoldDays, params.stopLossPct, params.takeProfitPct, params.minShares, params.outDir],
    ['2024-01-01', '2024-12-31', 40, 5, 15, 1000, '/data/backtest'],
  );
  assert.deepEqual(params.horizons, [5, 20, 60, 120]);
  assert.deepEqual(buildParams({}, { DATA_DIR: '/data' }, 'report').horizons, [5, 20, 60]);
  assert.equal(buildParams({}, { ORDER_QUANTITY: '' }, 'backtest').to, today());

  assert.throws(() => buildParams({ nope: '1' }, {}, 'backtest'), /Unbekannte Option --nope/);
  assert.throws(() => buildParams({ from: '01.02.2024' }, {}, 'backtest'), /Ungültiges Datum/);
  assert.throws(() => buildParams({ from: '2024-06-01', to: '2024-01-01' }, {}, 'backtest'), /--from liegt nach --to/);
  assert.throws(() => buildParams({ 'stop-loss': 'acht' }, {}, 'backtest'), /Ungültiger Wert für --stop-loss/);
  assert.throws(() => buildParams({ horizons: '5,x' }, {}, 'backtest'), /--horizons/);
});
