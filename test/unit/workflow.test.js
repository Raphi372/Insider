'use strict';

// Prüft die Logik der Code-Nodes direkt aus der ausgelieferten Workflow-Datei –
// ohne n8n. Aufruf: node --test test/unit/workflow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n/workflows/insider-pipeline.json'), 'utf8'));
// "n8n export:workflow" schreibt ein Array mit einem Workflow – beides zulassen.
const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const node = (name) => {
  const found = workflow.nodes.find((n) => n.name === name);
  assert.ok(found, `Node "${name}" fehlt im Workflow`);
  return found;
};

/**
 * Führt den JavaScript-Code eines Code-Nodes aus. `input` sind die eingehenden
 * Items, `nodes` die Ausgaben früherer Nodes für $('Name').first()/.all().
 */
async function run(name, { input = [{}], nodes = {} } = {}) {
  const wrap = (items) => items.map((json) => ({ json }));
  const $input = { first: () => wrap(input)[0], all: () => wrap(input) };
  // Wie in n8n: Ein nicht ausgeführter Node meldet isExecuted === false, und
  // der Zugriff auf seine Daten wirft einen Fehler.
  const $ = (nodeName) => {
    const isExecuted = nodeName in nodes;
    const items = (branch, runIndex) => {
      if (!isExecuted) throw new Error(`Node "${nodeName}" wurde nicht ausgeführt`);
      const value = nodes[nodeName];
      return wrap(typeof value === 'function' ? value(branch, runIndex) : value);
    };
    return { isExecuted, first: (b, r) => items(b, r)[0], all: (b, r) => items(b, r) };
  };
  const output = await new AsyncFunction('$input', '$', node(name).parameters.jsCode)($input, $);
  return output.map((item) => item.json);
}

const CFG = {
  minPurchaseValueUsd: 25000, orderBudgetUsd: 5000, orderQuantity: 0, stopLossPct: 8, takeProfitPct: 15,
  orderMaxAgeHours: 24, telegramChatId: '4242', ibkrAccountId: 'DU1234567', model: 'claude-haiku-5-5',
  finnhubEnabled: true, timeZone: 'Europe/Berlin',
};
const config = (overrides = {}) => [{ cfg: { ...CFG, ...overrides } }];

const tx = (code, shares, price, after, ownership = 'D', nature) => ({
  transactionDate: '2026-11-09',
  coding: { code },
  amounts: { shares, pricePerShare: price, acquiredDisposedCode: code === 'S' ? 'D' : 'A' },
  postTransactionAmounts: { sharesOwnedFollowingTransaction: after },
  ownershipNature: { directOrIndirectOwnership: ownership, ...(nature ? { natureOfOwnership: nature } : {}) },
});

const form4 = (transactions, overrides = {}) => ({
  accessionNo: '0001000000-26-000001',
  filedAt: '2026-11-10T16:31:02-05:00',
  issuer: { cik: '1000001', name: 'ACME Corp', tradingSymbol: 'acme' },
  reportingOwner: { cik: '2000001', name: 'Doe Jane', relationship: { isOfficer: true, officerTitle: 'CEO', isDirector: true } },
  nonDerivativeTable: { transactions },
  ...overrides,
});

// ------------------------------------------------------------ Parse_Form4

test('Parse_Form4 summiert nur Offenmarktkäufe und berechnet den Durchschnittspreis', async () => {
  const [signal] = await run('Parse_Form4', {
    input: [{ transactions: [form4([
      tx('M', 9000, 0, 30000),
      tx('P', 3000, 10.0, 23000),
      tx('P', 2000, 10.5, 25000),
      tx('S', 4000, 12, 21000),
    ])] }],
  });

  assert.equal(signal.ticker, 'ACME');
  assert.equal(signal.tickerValid, true);
  assert.equal(signal.role, 'Officer (CEO), Director');
  assert.deepEqual(signal.transactionCodes, ['M', 'P', 'S']);
  assert.equal(signal.purchase.lots, 2);
  assert.equal(signal.purchase.shares, 5000);
  assert.equal(signal.purchase.value, 51000);
  assert.equal(signal.purchase.avgPrice, 10.2);
  assert.equal(signal.purchase.sharesOwnedBefore, 20000);
  assert.equal(signal.purchase.holdingsIncreasePct, 25);
  assert.equal(signal.link, 'https://www.sec.gov/Archives/edgar/data/1000001/000100000026000001/0001000000-26-000001-index.htm');
});

test('Parse_Form4 rechnet direkt und indirekt gehaltene Bestände getrennt', async () => {
  const [signal] = await run('Parse_Form4', {
    input: [{ transactions: [form4([
      tx('P', 1000, 5, 11000, 'D'),
      tx('P', 4000, 5, 4000, 'I', 'By Trust'),
    ])] }],
  });
  assert.equal(signal.purchase.sharesOwnedAfter, 15000);
  assert.equal(signal.purchase.sharesOwnedBefore, 10000);
  assert.equal(signal.purchase.holdingsIncreasePct, 50);
});

test('Parse_Form4 meldet Erstkauf ohne Prozentangabe und erkennt fehlende Ticker', async () => {
  const [first] = await run('Parse_Form4', { input: [{ transactions: [form4([tx('P', 2000, 3, 2000)])] }] });
  assert.equal(first.purchase.holdingsIncreasePct, null);

  for (const symbol of ['NONE', '', 'N/A']) {
    const [signal] = await run('Parse_Form4', {
      input: [{ transactions: [form4([tx('P', 2000, 3, 2000)], { issuer: { cik: '1', name: 'X', tradingSymbol: symbol } })] }],
    });
    assert.equal(signal.tickerValid, false, `Ticker "${symbol}"`);
  }
});

test('Parse_Form4 liefert für Filings ohne Kauf null Lose – der Kauf-Filter verwirft sie', async () => {
  const [sale] = await run('Parse_Form4', { input: [{ transactions: [form4([tx('S', 4000, 12, 21000)])] }] });
  assert.equal(sale.purchase.lots, 0);
  assert.equal(sale.purchase.shares, 0);
  assert.equal(sale.purchase.avgPrice, 0);

  const [empty] = await run('Parse_Form4', { input: [{ transactions: [{ accessionNo: 'x' }] }] });
  assert.equal(empty.purchase.lots, 0);
});

test('Parse_Form4 im Workflow und parseForm4 im Research-Paket liefern dasselbe', async () => {
  const { parseForm4 } = require(path.join(ROOT, 'research/src/form4.js'));
  const documents = [
    form4([tx('M', 9000, 0, 30000), tx('P', 3000, 10.0, 23000), tx('P', 2000, 10.5, 25000), tx('S', 4000, 12, 21000)]),
    form4([tx('P', 1000, 5, 11000, 'D'), tx('P', 4000, 5, 4000, 'I', 'By Trust')]),
    form4([tx('P', 2000, 3.3333, 2000)], { footnotes: [{ id: 'F1', text: 'x'.repeat(500) }] }),
    form4([tx('S', 4000, 12, 21000)]),
    form4([tx('P', 2000, 3, 2000)], { issuer: { cik: '7', name: 'X', tradingSymbol: 'none' } }),
    form4([tx('P', 2000, 3, 2000)], { reportingOwner: { cik: '9', name: 'Fund LP', relationship: { isTenPercentOwner: true, isOther: true, otherText: 'Member of group' } } }),
    { accessionNo: 'leer' },
  ];
  for (const document of documents) {
    const [fromWorkflow] = await run('Parse_Form4', { input: [{ transactions: [document] }] });
    assert.deepEqual(fromWorkflow, parseForm4(document));
  }
});

// ------------------------------------------------- Kauf-Filter (IF-Nodes)

/**
 * Wertet die Bedingungen eines IF-Nodes so aus, wie sie in der Workflow-Datei
 * stehen (nur die dort verwendeten Operatoren). `json` ist das eingehende Item.
 */
function passesIf(name, { json = {}, nodes = {} } = {}) {
  const $ = (nodeName) => {
    if (!(nodeName in nodes)) throw new Error(`Node "${nodeName}" wurde nicht ausgeführt`);
    return { first: () => ({ json: nodes[nodeName][0] }) };
  };
  const evaluate = (value) => {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const expression = /^=\{\{(.*)\}\}$/s.exec(value);
    assert.ok(expression, `Ausdruck nicht auswertbar: ${value}`);
    return new Function('$', '$json', `return (${expression[1]});`)($, json);
  };
  const { conditions, combinator } = node(name).parameters.conditions;
  assert.equal(combinator, 'and');
  return conditions.every((condition) => {
    const left = evaluate(condition.leftValue);
    const right = evaluate(condition.rightValue);
    const { type, operation } = condition.operator;
    if (type === 'number') assert.equal(typeof left, 'number', `${condition.leftValue} muss eine Zahl liefern (strikte Typprüfung)`);
    if (operation === 'gt') return left > right;
    if (operation === 'gte') return left >= right;
    if (operation === 'true') return left === true;
    throw new Error(`Operator "${operation}" kennt dieser Test nicht`);
  });
}

const passesPurchaseFilter = async (transactions, { cfg, overrides } = {}) => {
  const [signal] = await run('Parse_Form4', { input: [{ transactions: [form4(transactions, overrides)] }] });
  return passesIf('Kauf-Filter', { nodes: { Parse_Form4: [signal], Config: config(cfg) } });
};

test('Kauf-Filter entscheidet nach Kaufwert statt nach Stückzahl', async () => {
  assert.equal(await passesPurchaseFilter([tx('P', 300, 900, 300)]), true, '300 Aktien zu 900 $ sind 270.000 $');
  assert.equal(await passesPurchaseFilter([tx('P', 5000, 2, 5000)]), false, '5.000 Aktien zu 2 $ sind nur 10.000 $');
  assert.equal(await passesPurchaseFilter([tx('P', 2500, 10, 2500)]), true, 'genau die Schwelle zählt mit');
  assert.equal(await passesPurchaseFilter([tx('P', 2499, 10, 2499)]), false);
  assert.equal(await passesPurchaseFilter([tx('P', 1500, 10, 1500), tx('P', 1000, 10, 2500)]), true, 'mehrere Teilkäufe einer Meldung zählen zusammen');
  assert.equal(await passesPurchaseFilter([tx('P', 2000, 10, 2000)], { cfg: { minPurchaseValueUsd: 20000 } }), true, 'Schwelle aus MIN_PURCHASE_VALUE_USD');
});

test('Kauf-Filter lässt Verkäufe, Zuteilungen, Preis 0 und Meldungen ohne Ticker nie durch', async () => {
  const open = { cfg: { minPurchaseValueUsd: 0 } }; // selbst ohne Wertschwelle
  assert.equal(await passesPurchaseFilter([tx('S', 40000, 12, 21000)], open), false);
  assert.equal(await passesPurchaseFilter([tx('A', 40000, 12, 61000), tx('M', 9000, 5, 70000)], open), false);
  assert.equal(await passesPurchaseFilter([tx('P', 40000, 0, 40000)], open), false);
  assert.equal(await passesPurchaseFilter([tx('P', 40000, 12, 40000)], { ...open, overrides: { issuer: { cik: '7', name: 'X', tradingSymbol: 'NONE' } } }), false);
  assert.equal(await passesPurchaseFilter([tx('P', 40000, 12, 40000)], open), true);
});

test('Verkaufswarnung? folgt allein der Antwort der Datenbank', () => {
  assert.equal(passesIf('Verkaufswarnung?', { json: { stored: true, sellAlert: { ticker: 'ACME' } } }), true);
  assert.equal(passesIf('Verkaufswarnung?', { json: { stored: true, cluster: null, sellAlert: null } }), false);
  assert.equal(passesIf('Verkaufswarnung?', { json: { error: { message: 'ECONNREFUSED' } } }), false, 'Datenbank nicht erreichbar: keine Warnung, aber die Pipeline läuft weiter');
});

// ------------------------------------------------------- Build_Sell_Alert

const SELL_ALERT = {
  accessionNo: '0001000000-26-000009', filedAt: '2026-11-12T16:40:00-05:00', ticker: 'ACME', issuerName: 'ACME Corp',
  insiderName: 'Doe Jane', role: 'Officer (CEO), Director', mentions10b51: false, link: 'https://www.sec.gov/y',
  sale: { lots: 1, shares: 6000, value: 90000, avgPrice: 15, firstDate: '2026-11-11', lastDate: '2026-11-11', sharesOwnedBefore: 25000, sharesOwnedAfter: 19000, holdingsDecreasePct: 24 },
  followed: { accessionNo: '0001000000-26-000001', filedAt: '2026-11-10T16:31:02-05:00', shares: 5000, value: 51000, avgPrice: 10.2, rating: 'STARK', orderSent: true },
};
const sellAlert = (overrides = {}) => run('Build_Sell_Alert', {
  input: [{ stored: true, isNew: true, cluster: null, sellAlert: { ...SELL_ALERT, ...overrides } }],
  nodes: { Config: config() },
}).then(([json]) => json);

test('Build_Sell_Alert nennt Verkauf, Restbestand und den Kauf, dem du gefolgt bist', async () => {
  const result = await sellAlert();
  assert.deepEqual([result.chatId, result.ticker, result.accessionNo], ['4242', 'ACME', '0001000000-26-000009']);
  assert.match(result.text, /^🔻 <b>Insiderverkauf ACME<\/b> – du bist dem Kauf dieses Insiders gefolgt\nACME Corp\n/);
  assert.match(result.text, /<b>Insider:<\/b> Doe Jane – Officer \(CEO\), Director/);
  assert.match(result.text, /<b>Verkauf:<\/b> 6\.000 Aktien zu Ø 15,00 \$ = 90\.000 \$/);
  assert.match(result.text, /<b>Handelstag:<\/b> 2026-11-11\n/);
  assert.match(result.text, /<b>Bestand danach:<\/b> 19\.000 Aktien \(−24,0 %\)/);
  assert.match(result.text, /<b>Früherer Kauf:<\/b> gemeldet am 2026-11-10, 5\.000 Aktien zu Ø 10,20 \$/);
  assert.match(result.text, /Du hattest zu diesem Kauf eine Order gesendet\. Es wird nichts automatisch verkauft – prüfe in der IBKR-App, ob die Position noch besteht/);
  assert.match(result.text, /<a href="https:\/\/www\.sec\.gov\/y">Form 4 bei der SEC<\/a>$/);
  assert.ok(!result.text.includes('10b5-1'));
});

test('Build_Sell_Alert: ohne gesendete Order, mit Handelsplan, Komplettverkauf und fremden Texten', async () => {
  const result = await sellAlert({
    issuerName: 'A <b>& B', insiderName: '<script>', mentions10b51: true, link: null,
    followed: { ...SELL_ALERT.followed, orderSent: false },
    sale: { ...SELL_ALERT.sale, firstDate: '2026-11-09', sharesOwnedBefore: 0, sharesOwnedAfter: 0, holdingsDecreasePct: null },
  });
  assert.match(result.text, /– der Kauf dieses Insiders wurde dir gemeldet\nA &lt;b&gt;&amp; B\n/);
  assert.match(result.text, /<b>Insider:<\/b> &lt;script&gt; –/);
  assert.match(result.text, /<b>Handelstag:<\/b> 2026-11-09 bis 2026-11-11\n/);
  assert.match(result.text, /<b>Bestand danach:<\/b> 0 Aktien\n/);
  assert.match(result.text, /Rule 10b5-1\) – solche Verkäufe sagen wenig/);
  assert.match(result.text, /Zu diesem Kauf hattest du keine Order gesendet\.$/);
});

// ----------------------------------------------------------- Build_Prompt

const SIGNAL = {
  accessionNo: '0001000000-26-000001', ticker: 'ACME', issuerName: 'ACME Corp', issuerCik: '1000001', insiderName: 'Doe Jane', role: 'Officer (CEO)',
  filedAt: '2026-11-10', transactionCodes: ['P'], mentions10b51: false, footnotes: [], link: 'https://www.sec.gov/x',
  purchase: { lots: 1, shares: 5000, value: 51000, avgPrice: 10.2, firstDate: '2026-11-09', lastDate: '2026-11-09', sharesOwnedBefore: 20000, sharesOwnedAfter: 25000, holdingsIncreasePct: 25 },
};
const quote = (price = 12) => ({ quoteSummary: { result: [{
  price: { regularMarketPrice: { raw: price }, regularMarketTime: 1794344400, marketCap: { raw: 1.5e9 } },
  summaryDetail: { trailingPE: { raw: 18.44 } },
  defaultKeyStatistics: { shortPercentOfFloat: { raw: 0.075 } },
}] } });

// ----------------------------------------------------------- Build_Market

// Antworten der Quellen, wie n8n sie an den Workflow weitergibt.
const FINNHUB_QUOTE = { c: 5.12, d: -0.08, dp: -1.54, h: 5.3, l: 5.05, o: 5.2, pc: 5.2, t: 1794690000 };
const FINNHUB_PROFILE = { country: 'US', currency: 'USD', exchange: 'NASDAQ NMS - GLOBAL MARKET', marketCapitalization: 38.2, name: 'ACME Corp', shareOutstanding: 7.46, ticker: 'ACME' };
const FINNHUB_METRIC = { metric: { '52WeekHigh': 9.8, '52WeekLow': 3.1, peTTM: 14.237, beta: 1.2 }, metricType: 'all', series: {}, symbol: 'ACME' };
const YAHOO_COOKIE = { statusCode: 404, headers: { 'set-cookie': ['A3=abc; Path=/'] }, body: '' };
// Fehler, wie n8n 2.47 sie bei "Continue on Fail" liefert (in einem echten n8n aufgezeichnet).
const HTTP_429 = { error: { message: "Try spacing your requests out using the batching settings under 'Options'", name: 'AxiosError', code: 'ERR_BAD_REQUEST', status: 429 } };
const HTTP_500 = { error: { message: '500 - "Internal Server Error"', name: 'AxiosError', code: 'ERR_BAD_RESPONSE', status: 500 } };
const TIMEOUT = { error: { message: 'timeout of 5000ms exceeded', name: 'AxiosError', code: 'ECONNABORTED' } };
const DNS_ERROR = { error: { message: 'getaddrinfo ENOTFOUND finnhub.io', name: 'Error', code: 'ENOTFOUND' } };

const finnhubOk = { Finnhub_Quote: [FINNHUB_QUOTE], Finnhub_Profile: [FINNHUB_PROFILE], Finnhub_Metric: [FINNHUB_METRIC] };
const yahooOk = { Yahoo_Cookie: [YAHOO_COOKIE], Yahoo_Crumb: [{ data: 'crumb' }], Yahoo_Quote: [quote()] };
const yahooBlocked = { Yahoo_Cookie: [YAHOO_COOKIE], Yahoo_Crumb: [HTTP_429], Yahoo_Quote: [HTTP_429] };

const buildMarket = (sources, { cfg, signal = SIGNAL } = {}) => run('Build_Market', {
  nodes: { Config: config(cfg), Parse_Form4: [signal], ...sources },
}).then(([json]) => json);

test('Build_Market liest Kurs, Marktkapitalisierung und Kennzahlen von Finnhub', async () => {
  const built = await buildMarket(finnhubOk);
  assert.deepEqual(built.market, {
    price: 5.12, marketCap: 38200000, trailingPE: 14.24, forwardPE: null, fiftyTwoWeekLow: 3.1, fiftyTwoWeekHigh: 9.8,
    shortPercentOfFloat: null, shortRatioDays: null, heldByInstitutionsPct: null,
    source: 'Finnhub', asOf: '2026-11-14T21:00:00.000Z', marketCapBasis: null,
  }, 'Finnhub nennt die Marktkapitalisierung in Millionen; was es nicht liefert, bleibt null');
  assert.deepEqual(built.marketSources, [{ source: 'Finnhub', ok: true, reason: null }]);
  assert.deepEqual([built.needsShares, built.capNotes], [false, []]);
});

test('Build_Market: Finnhub zuerst, Yahoo nur als Ersatz', async () => {
  // Beide Quellen haben Daten: Finnhub gewinnt.
  assert.equal((await buildMarket({ ...finnhubOk, ...yahooOk })).market.source, 'Finnhub');

  // Finnhub kennt das Symbol nicht (lauter Nullen) -> Yahoo.
  const unknown = await buildMarket({ Finnhub_Quote: [{ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 }], ...yahooOk });
  assert.deepEqual(unknown.marketSources, [
    { source: 'Finnhub', ok: false, reason: 'kein Kurs für ACME' },
    { source: 'Yahoo', ok: true, reason: null },
  ]);
  assert.deepEqual(
    [unknown.market.source, unknown.market.price, unknown.market.marketCap, unknown.market.trailingPE, unknown.market.shortPercentOfFloat, unknown.market.asOf],
    ['Yahoo', 12, 1500000000, 18.44, 7.5, '2026-11-10T21:00:00.000Z'],
  );

  // Finnhub drosselt -> Yahoo, und der Grund steht dabei.
  const throttled = await buildMarket({ Finnhub_Quote: [HTTP_429], ...yahooOk });
  assert.deepEqual(throttled.marketSources[0], { source: 'Finnhub', ok: false, reason: 'HTTP 429' });
  assert.equal(throttled.market.source, 'Yahoo');
});

test('Build_Market: ohne Finnhub-Schlüssel läuft alles über Yahoo', async () => {
  const built = await buildMarket(yahooOk, { cfg: { finnhubEnabled: false } });
  assert.deepEqual(built.marketSources, [
    { source: 'Finnhub', ok: false, reason: 'kein Schlüssel' },
    { source: 'Yahoo', ok: true, reason: null },
  ]);
  assert.equal(built.market.source, 'Yahoo');

  // Auch wenn Antworten von Finnhub vorlägen: Ohne Schlüssel zählen sie nicht.
  assert.equal((await buildMarket({ ...finnhubOk, ...yahooOk }, { cfg: { finnhubEnabled: false } })).market.source, 'Yahoo');
});

test('Build_Market: Fallen alle Quellen aus, nennt jede ihren Grund', async () => {
  const reasons = async (sources, cfg) => {
    const built = await buildMarket(sources, { cfg });
    assert.equal(built.market, null);
    assert.equal(built.needsShares, false, 'ohne Kurs gibt es nichts zu berechnen');
    return built.marketSources.map((source) => `${source.source}: ${source.reason}`).join(' · ');
  };

  // Der Befund vom 14.11.2026: kein Schlüssel, Yahoo antwortet schon beim Crumb mit 429.
  assert.equal(await reasons(yahooBlocked, { finnhubEnabled: false }), 'Finnhub: kein Schlüssel · Yahoo: HTTP 429');
  assert.equal(await reasons({ Finnhub_Quote: [HTTP_500], ...yahooBlocked }), 'Finnhub: HTTP 500 · Yahoo: HTTP 429');
  assert.equal(await reasons({ Finnhub_Quote: [TIMEOUT], Yahoo_Cookie: [TIMEOUT], Yahoo_Crumb: [TIMEOUT], Yahoo_Quote: [TIMEOUT] }), 'Finnhub: Zeitüberschreitung · Yahoo: Zeitüberschreitung');
  assert.equal(await reasons({ Finnhub_Quote: [DNS_ERROR], ...yahooBlocked }), 'Finnhub: nicht erreichbar · Yahoo: HTTP 429');
  assert.equal(await reasons({ Finnhub_Quote: [{ error: 'Credentials not found' }], ...yahooBlocked }), 'Finnhub: Credentials not found · Yahoo: HTTP 429');

  // Yahoo: Einwilligungsseite statt Cookie, Ausfall mit 503, Symbol unbekannt.
  const noCookie = { Yahoo_Cookie: [{ statusCode: 200, headers: {}, body: '<html>' }], Yahoo_Crumb: [{ data: '' }], Yahoo_Quote: [{ quoteSummary: { result: null, error: { code: 'Not Found' } } }] };
  assert.equal(await reasons(noCookie, { finnhubEnabled: false }), 'Finnhub: kein Schlüssel · Yahoo: kein Cookie erhalten');
  const down = { Yahoo_Cookie: [{ statusCode: 503, headers: {}, body: '' }], Yahoo_Crumb: [{ error: { status: 503, message: '503 - "Service Unavailable"' } }], Yahoo_Quote: [{ error: { status: 503 } }] };
  assert.equal(await reasons(down, { finnhubEnabled: false }), 'Finnhub: kein Schlüssel · Yahoo: HTTP 503');
  const noSymbol = { ...yahooOk, Yahoo_Quote: [{ quoteSummary: { result: null, error: { code: 'Not Found' } } }] };
  assert.equal(await reasons(noSymbol, { finnhubEnabled: false }), 'Finnhub: kein Schlüssel · Yahoo: kein Kurs für ACME');

  // Wurde eine Quelle gar nicht gefragt, wird auch das gesagt statt geraten.
  assert.equal(await reasons({}, { finnhubEnabled: true }), 'Finnhub: nicht abgefragt · Yahoo: nicht abgefragt');
});

test('Build_Market: Fehlt bei Finnhub die Marktkapitalisierung, wird die Aktienzahl gebraucht', async () => {
  const withProfile = (profile, metric = FINNHUB_METRIC) => buildMarket({ Finnhub_Quote: [FINNHUB_QUOTE], Finnhub_Profile: [profile], Finnhub_Metric: [metric] });

  // Kein Profil (typisch für sehr kleine Titel): Kurs ja, Marktkapitalisierung über die SEC.
  const noProfile = await withProfile({});
  assert.deepEqual([noProfile.market.price, noProfile.market.marketCap, noProfile.needsShares, noProfile.capNotes], [5.12, null, true, ['Finnhub: keine Angabe']]);

  // Profil gedrosselt: der Kurs bleibt, der Grund für die Lücke wird notiert.
  const throttled = await withProfile(HTTP_429, HTTP_429);
  assert.deepEqual([throttled.market.price, throttled.market.marketCap, throttled.market.trailingPE, throttled.needsShares, throttled.capNotes], [5.12, null, null, true, ['Finnhub: HTTP 429']]);

  // Nur die Aktienzahl ist da: Marktkapitalisierung = Kurs × Aktien, als berechnet gekennzeichnet.
  const sharesOnly = await withProfile({ currency: 'USD', shareOutstanding: 7.46 });
  assert.deepEqual([sharesOnly.market.marketCap, sharesOnly.market.marketCapBasis, sharesOnly.needsShares], [38195200, { sharesOutstanding: 7460000, asOf: null, source: 'Finnhub' }, false]);

  // Berichtet das Unternehmen nicht in US-Dollar, ist die Währung der Angabe unklar: lieber keine Zahl.
  const foreign = await withProfile({ currency: 'CNY', marketCapitalization: 1800000, shareOutstanding: 2400 });
  assert.deepEqual([foreign.market.marketCap, foreign.capNotes, foreign.needsShares], [null, ['Finnhub: Angabe in CNY'], true]);

  // Ohne CIK des Emittenten lässt sich bei der SEC nichts nachschlagen.
  const { issuerCik, ...withoutCik } = SIGNAL;
  const built = await buildMarket({ Finnhub_Quote: [FINNHUB_QUOTE], Finnhub_Profile: [{}], Finnhub_Metric: [{}] }, { signal: withoutCik });
  assert.equal(built.needsShares, false);
});

test('Build_Market fragt Aktienklassen bei Finnhub mit Punkt ab (BRK-B -> BRK.B)', async () => {
  const built = await buildMarket({ Finnhub_Quote: [{ c: 0, t: 0 }], ...yahooBlocked }, { signal: { ...SIGNAL, ticker: 'BRK-B' } });
  assert.equal(built.marketSources[0].reason, 'kein Kurs für BRK.B');
  const symbol = node('Finnhub_Quote').parameters.queryParameters.parameters.find((parameter) => parameter.name === 'symbol').value;
  assert.equal(new Function('$', `return (${/^=\{\{(.*)\}\}$/s.exec(symbol)[1]});`)(() => ({ first: () => ({ json: { ticker: 'BRK-B' } }) })), 'BRK.B');
});

test('Marktdaten-Weichen: Finnhub nur mit Schlüssel, Yahoo nur ohne Kurs, SEC nur ohne Marktkapitalisierung', () => {
  assert.equal(passesIf('Finnhub aktiv?', { nodes: { Config: config({ finnhubEnabled: true }) } }), true);
  assert.equal(passesIf('Finnhub aktiv?', { nodes: { Config: config({ finnhubEnabled: false }) } }), false);

  assert.equal(passesIf('Finnhub-Kurs?', { json: FINNHUB_QUOTE }), true);
  assert.equal(passesIf('Finnhub-Kurs?', { json: { c: 0, t: 0 } }), false, 'unbekanntes Symbol');
  assert.equal(passesIf('Finnhub-Kurs?', { json: HTTP_429 }), false, 'gedrosselt');

  assert.equal(passesIf('Marktkap. fehlt?', { json: { needsShares: true } }), true);
  assert.equal(passesIf('Marktkap. fehlt?', { json: { needsShares: false } }), false);
});

const CLUSTER = {
  windowDays: 14, historyDays: 30, otherInsiders: 2, insidersWithSamePurchase: 0, totalValue: 150000,
  purchases: [
    { insiderName: 'Roe Richard', role: 'Director', filedDate: '2026-11-06', shares: 10000, value: 100000, sameAsThisPurchase: false },
    { insiderName: 'Poe <Pat>', role: 'Officer (CFO)', filedDate: '2026-11-02', shares: 5000, value: 50000, sameAsThisPurchase: false },
  ],
};
const STORED = { stored: true, isNew: true, cluster: CLUSTER, sellAlert: null };

test('Build_Prompt berechnet Erfolgsquote, filtert 13F-Positionen und baut eine gültige Anfrage', async () => {
  const built = await buildMarket(yahooOk, { cfg: { finnhubEnabled: false } });
  const [{ facts, llmRequest }] = await run('Build_Prompt', {
    input: [built],
    nodes: {
      Config: config(),
      Parse_Form4: [SIGNAL],
      Build_Market: [built],
      Store_Filing: [STORED],
      Insider_Historie: [{ transactions: [
        form4([tx('P', 5000, 10.2, 25000)]), // das aktuelle Filing zählt nicht zur Historie
        form4([tx('P', 4000, 8, 24000)], { accessionNo: 'old-1' }),
        form4([tx('P', 1000, 16, 20000)], { accessionNo: 'old-2' }),
        form4([tx('S', 4000, 9, 19000)], { accessionNo: 'old-3' }),
      ] }],
      '13F_Request': [{ data: [
        { cik: '9', companyName: 'Alpha', periodOfReport: '2025-09-30', holdings: [{ ticker: 'ACME', value: 1, shrsOrPrnAmt: { sshPrnamt: 100 } }] },
        { cik: '9', companyName: 'Alpha', periodOfReport: '2025-12-31', holdings: [
          { ticker: 'OTHER', value: 9, shrsOrPrnAmt: { sshPrnamt: 9 } },
          { ticker: 'ACME', value: 50, shrsOrPrnAmt: { sshPrnamt: 200 } },
          { ticker: 'acme', value: 25, shrsOrPrnAmt: { sshPrnamt: 100 } },
        ] },
        { cik: '8', companyName: 'Ohne Position', periodOfReport: '2025-12-31', holdings: [{ ticker: 'OTHER', value: 1, shrsOrPrnAmt: { sshPrnamt: 1 } }] },
      ] }],
    },
  });

  assert.deepEqual(facts.history.trackRecord, {
    purchases: 2, inProfit: 1, hitRatePct: 50, avgReturnPct: 12.5, note: 'Vergleich Kaufpreis zu heutigem Kurs, nicht splitbereinigt',
  });
  assert.equal(facts.history.priorSales, 1);
  assert.deepEqual(facts.institutions, [{ manager: 'Alpha', period: '2025-12-31', shares: 300, valueUsd: 75 }]);
  assert.equal(facts.market.shortPercentOfFloat, 7.5);
  assert.equal(facts.market.trailingPE, 18.44);
  assert.equal(facts.derived.purchaseValuePctOfMarketCap, 0.0034);
  assert.equal(facts.derived.currentPriceVsInsiderPricePct, 17.6);
  assert.deepEqual(facts.cluster, {
    windowDays: 14, otherInsiders: 2, insidersWithSamePurchase: 0, totalValueUsd: 150000, purchases: CLUSTER.purchases, historyDays: 30, complete: true,
  });
  assert.equal(facts.mentions10b51, false);

  // Anfrage: aktuelles Modell, keine Parameter, die die API inzwischen ablehnt.
  assert.equal(llmRequest.model, 'claude-haiku-5-5');
  assert.deepEqual(Object.keys(llmRequest).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(llmRequest.output_config.format.schema.additionalProperties, false);
  assert.equal(llmRequest.messages.at(-1).role, 'user');
  assert.ok(!llmRequest.messages[0].content.includes('sec.gov'), 'der Link gehört nicht in den Prompt');
  assert.match(llmRequest.messages[0].content, /"cluster": \{\s+"windowDays": 14,\s+"otherInsiders": 2,/, 'der Cluster steht im Faktenblock für das Modell');
  assert.match(llmRequest.system, /"cluster" nennt weitere Insider/);
  assert.match(llmRequest.system, /"sameAsThisPurchase": true.+kein unabhängiger zweiter Käufer/);

  // Quelle und Zeitpunkt des Kurses gehen ans Modell, die Abruf-Diagnose nicht.
  assert.deepEqual([facts.market.source, facts.market.asOf], ['Yahoo', '2026-11-10T21:00:00.000Z']);
  assert.deepEqual(facts.marketSources, built.marketSources);
  assert.match(llmRequest.messages[0].content, /"source": "Yahoo",\s+"asOf": "2026-11-10T21:00:00.000Z"/);
  assert.ok(!llmRequest.messages[0].content.includes('marketSources'));
  assert.match(llmRequest.system, /"market\.marketCapBasis" gesetzt.+nur eine Näherung/);
});

test('Build_Prompt berechnet eine fehlende Marktkapitalisierung aus der Aktienzahl der SEC', async () => {
  const built = await buildMarket({ Finnhub_Quote: [FINNHUB_QUOTE], Finnhub_Profile: [{}], Finnhub_Metric: [FINNHUB_METRIC] });
  assert.equal(built.needsShares, true);
  const fact = (end, val, form, filed) => ({ end, val, accn: 'x', fy: 2026, fp: 'Q3', form, filed });
  const prompt = async (secResponse, signal = SIGNAL) => {
    const [{ facts }] = await run('Build_Prompt', {
      input: [secResponse],
      nodes: { Config: config(), Parse_Form4: [signal], Build_Market: [built], Store_Filing: [STORED], Insider_Historie: [{}], '13F_Request': [{}] },
    });
    return facts;
  };

  // Jüngster Quartals- oder Jahresbericht zählt; andere Formulare und ältere Stände nicht.
  const facts = await prompt({ units: { shares: [
    fact('2026-06-30', 7300000, '10-Q', '2026-08-05'),
    fact('2026-09-30', 7460000, '10-Q', '2026-11-04'),
    fact('2026-10-15', 999, 'S-1', '2026-10-20'),
    fact('2025-12-31', 7100000, '10-K', '2026-03-01'),
  ] } });
  assert.equal(facts.market.marketCap, 38195200);
  assert.deepEqual(facts.market.marketCapBasis, { sharesOutstanding: 7460000, asOf: '2026-09-30', source: 'SEC' });
  assert.equal(facts.marketCapNote, null);
  assert.equal(facts.derived.purchaseValuePctOfMarketCap, 0.1335, 'die abgeleiteten Kennzahlen rechnen mit dem berechneten Wert');
  assert.equal(facts.market.source, 'Finnhub', 'die Quelle des Kurses bleibt');

  // Keine brauchbare Angabe: Die Lücke bleibt, mit Begründung – geschätzt wird nicht.
  const gap = async (secResponse) => {
    const result = await prompt(secResponse);
    assert.deepEqual([result.market.marketCap, result.market.marketCapBasis, result.derived.purchaseValuePctOfMarketCap], [null, null, null]);
    return result.marketCapNote;
  };
  assert.equal(await gap({ error: { status: 404, message: '404 - "NoSuchKey"' } }), 'Finnhub: keine Angabe · SEC: keine Angabe');
  assert.equal(await gap(HTTP_429), 'Finnhub: keine Angabe · SEC: HTTP 429');
  assert.equal(await gap(TIMEOUT), 'Finnhub: keine Angabe · SEC: nicht erreichbar');
  assert.equal(await gap({ units: { shares: [fact('2024-12-31', 7000000, '10-K', '2025-03-01')] } }), 'Finnhub: keine Angabe · SEC: Aktienzahl veraltet (2024-12-31)');
  assert.equal(await gap({ units: { shares: [fact('2026-09-30', 900000000, '20-F', '2026-10-30')] } }), 'Finnhub: keine Angabe · SEC: keine Angabe', 'ausländische Emittenten: Stammaktien sind nicht das gehandelte Papier');
  assert.equal(await gap({ units: {} }), 'Finnhub: keine Angabe · SEC: keine Angabe');
});

test('Build_Prompt: Cluster aus der Datenbank – unvollständige Historie wird gekennzeichnet, ein Ausfall nicht geraten', async () => {
  const cluster = async (stored) => {
    const built = await buildMarket(finnhubOk);
    const [{ facts }] = await run('Build_Prompt', {
      input: [built],
      nodes: { Config: config(), Parse_Form4: [{ ...SIGNAL, mentions10b51: true }], Build_Market: [built], Store_Filing: [stored], Insider_Historie: [{}], '13F_Request': [{}] },
    });
    assert.equal(facts.mentions10b51, true);
    return facts.cluster;
  };

  const fresh = await cluster({ stored: true, cluster: { windowDays: 14, historyDays: 3, otherInsiders: 0, insidersWithSamePurchase: 0, totalValue: 0, purchases: [] } });
  assert.deepEqual(fresh, { windowDays: 14, otherInsiders: 0, insidersWithSamePurchase: 0, totalValueUsd: 0, purchases: [], historyDays: 3, complete: false });

  const twin = await cluster({ stored: true, cluster: { ...CLUSTER, otherInsiders: 1, insidersWithSamePurchase: 1, purchases: [{ ...CLUSTER.purchases[0], sameAsThisPurchase: true }] } });
  assert.deepEqual([twin.insidersWithSamePurchase, twin.purchases[0].sameAsThisPurchase], [1, true], 'die Kennzeichnung erreicht das Modell');

  assert.equal(await cluster({ error: { message: 'connect ECONNREFUSED' } }), null, 'Datenbank nicht erreichbar');
  assert.equal(await cluster({ stored: false, cluster: null, sellAlert: null }), null);
  assert.equal(await cluster({}), null);
});

test('Build_Prompt kennzeichnet ausgefallene Datenquellen mit null statt mit erfundenen Werten', async () => {
  const failed = [{ error: { message: 'timeout' } }];
  const built = await buildMarket({ Finnhub_Quote: [TIMEOUT], Yahoo_Cookie: [TIMEOUT], Yahoo_Crumb: [TIMEOUT], Yahoo_Quote: [TIMEOUT] });
  const [{ facts }] = await run('Build_Prompt', {
    input: [built],
    nodes: { Config: config(), Parse_Form4: [SIGNAL], Build_Market: [built], Store_Filing: failed, Insider_Historie: failed, '13F_Request': failed },
  });
  assert.equal(facts.market, null);
  assert.deepEqual(facts.marketSources.map((source) => source.reason), ['Zeitüberschreitung', 'Zeitüberschreitung']);
  assert.equal(facts.history, null);
  assert.equal(facts.institutions, null);
  assert.equal(facts.cluster, null);
  assert.deepEqual(facts.derived, { purchaseValuePctOfMarketCap: null, currentPriceVsInsiderPricePct: null });
});

// ---------------------------------------------------------- Build_Message

const FACTS = {
  ...SIGNAL,
  market: null, marketSources: [], marketCapNote: null, history: null, institutions: null,
  cluster: { windowDays: 14, otherInsiders: 0, insidersWithSamePurchase: 0, totalValueUsd: 0, purchases: [], historyDays: 30, complete: true },
  derived: { purchaseValuePctOfMarketCap: null, currentPriceVsInsiderPricePct: null },
};
const llmAnswer = (verdict, stopReason = 'end_turn') => [{
  stop_reason: stopReason,
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof verdict === 'string' ? verdict : JSON.stringify(verdict) }],
}];
const VERDICT = { signal: 'MITTEL', begruendung: 'Text', pro: ['a'], contra: ['b'], datenluecken: ['Marktdaten'] };
const contracts = (symbol, conid = 111) => [{ [symbol]: [{ assetClass: 'STK', contracts: [{ conid: 999, isUS: false }, { conid, isUS: true }] }] }];

const message = (overrides = {}) => run('Build_Message', {
  input: overrides.conid || contracts('ACME'),
  nodes: {
    Config: config(overrides.cfg),
    Build_Prompt: [{ facts: { ...FACTS, ...(overrides.facts || {}) } }],
    LLM_Analysis: overrides.llm || llmAnswer(VERDICT),
  },
}).then(([json]) => json);

test('Build_Message berechnet die Bracket-Order aus Budget, Stop-Loss und Take-Profit', async () => {
  const result = await message();
  assert.deepEqual(result.order, { ticker: 'ACME', conid: 111, quantity: 490, entry: 10.2, stopLoss: 9.38, takeProfit: 11.73 });
  assert.equal(result.callbackOrder, 'o|ACME|111|490|10.2|9.38|11.73');
  assert.equal(result.signal, 'MITTEL');
  assert.deepEqual(result.analysis, VERDICT, 'die Antwort des Modells geht vollständig ins Signal-Protokoll');
  assert.equal(result.analysisNote, null);
  assert.match(result.message, /🟡 <b>Insiderkauf ACME<\/b> – Signal: <b>MITTEL<\/b>/);
  assert.match(result.message, /⚠️ Datenlücken: Marktdaten/);
});

test('Build_Message: feste Stückzahl hat Vorrang, Pennystocks behalten vier Nachkommastellen', async () => {
  const fixed = await message({ cfg: { orderQuantity: 100 } });
  assert.equal(fixed.order.quantity, 100);

  const penny = await message({ facts: { purchase: { ...SIGNAL.purchase, avgPrice: 0.43215 } } });
  assert.deepEqual(
    [penny.order.entry, penny.order.stopLoss, penny.order.takeProfit, penny.order.quantity],
    [0.4322, 0.3976, 0.497, 11568],
  );
});

test('Build_Message schlägt keine Order vor, wenn Budget, Kontrakt oder Parameter nicht passen', async () => {
  const expensive = await message({ facts: { purchase: { ...SIGNAL.purchase, avgPrice: 6200 } } });
  assert.equal(expensive.hasOrder, false);
  assert.match(expensive.message, /Budget \(5\.000 \$\) reicht nicht für eine Aktie/);

  const unknown = await message({ conid: [{ ACME: [] }] });
  assert.equal(unknown.hasOrder, false);

  const gatewayDown = await message({ conid: [{ error: { message: 'ECONNREFUSED' } }] });
  assert.match(gatewayDown.message, /IBKR-Gateway nicht erreichbar oder nicht eingeloggt/);

  const badConfig = await message({ cfg: { stopLossPct: 100 } });
  assert.equal(badConfig.hasOrder, false);
  assert.match(badConfig.message, /STOP_LOSS_PCT und TAKE_PROFIT_PCT prüfen/);
});

test('Build_Message schlägt Aktienklassen bei IBKR mit Leerzeichen nach (BRK.B -> BRK B)', async () => {
  const result = await message({ facts: { ticker: 'BRK.B' }, conid: contracts('BRK B', 72063691) });
  assert.equal(result.order.conid, 72063691);
  assert.ok(Buffer.byteLength(result.callbackOrder) <= 64);
});

test('Build_Message übersteht Ablehnung, abgeschnittene und unlesbare Modellantworten', async () => {
  const refusal = await message({ llm: [{ stop_reason: 'refusal', content: [] }] });
  assert.match(refusal.message, /ohne KI-Einstufung/);
  assert.match(refusal.message, /Das Modell hat die Bewertung abgelehnt\./);
  assert.equal(refusal.hasOrder, true, 'der Order-Vorschlag hängt nicht am Modell');

  const truncated = await message({ llm: llmAnswer('{"signal": "STA', 'max_tokens') });
  assert.match(truncated.message, /Die Antwort des Modells wurde abgeschnitten\./);

  const garbage = await message({ llm: llmAnswer({ signal: 'KAUFEN', begruendung: 'x', pro: [], contra: [], datenluecken: [] }) });
  assert.match(garbage.message, /Die Antwort des Modells war nicht lesbar\./);
  assert.equal(garbage.signal, null);
  assert.equal(garbage.analysis, null);
  assert.equal(garbage.analysisNote, 'Die Antwort des Modells war nicht lesbar.');
});

test('Build_Message maskiert HTML in Fremdtexten', async () => {
  const result = await message({
    facts: { issuerName: 'A <b>& B', insiderName: '<script>' },
    llm: llmAnswer({ ...VERDICT, begruendung: 'x < y & z', pro: ['<i>pro</i>'] }),
  });
  assert.match(result.message, /A &lt;b&gt;&amp; B/);
  assert.match(result.message, /&lt;script&gt;/);
  assert.match(result.message, /x &lt; y &amp; z/);
  assert.match(result.message, /➕ &lt;i&gt;pro&lt;\/i&gt;/);
});

test('Build_Message nennt Cluster-Käufe und sagt offen, wenn die Datenbank nicht geprüft werden konnte', async () => {
  const single = await message();
  assert.match(single.message, /<b>Cluster:<\/b> kein weiterer Insiderkauf in den 14 Tagen davor\n/);
  assert.ok(!single.message.includes('Rule 10b5-1'));

  const young = (historyDays) => message({ facts: { cluster: { ...FACTS.cluster, historyDays, complete: false } } });
  assert.match((await young(3)).message, /kein weiterer Insiderkauf in den 14 Tagen davor \(Datenbank reicht erst 3 Tage zurück\)/);
  assert.match((await young(1)).message, /\(Datenbank reicht erst 1 Tag zurück\)/);
  assert.match((await young(0)).message, /\(Datenbank reicht weniger als einen Tag zurück\)/);

  const purchases = CLUSTER.purchases;
  const one = await message({ facts: { cluster: { ...FACTS.cluster, otherInsiders: 1, totalValueUsd: 100000, purchases: purchases.slice(0, 1) } } });
  assert.match(one.message, /<b>Cluster:<\/b> 1 weiterer Insider kaufte in den 14 Tagen davor – Roe Richard \(100\.000 \$, 2026-11-06\)\n/);

  const many = await message({ facts: { mentions10b51: true, cluster: { ...FACTS.cluster, otherInsiders: 2, totalValueUsd: 150000, purchases } } });
  assert.match(many.message, /<b>Cluster:<\/b> 2 weitere Insider kauften in den 14 Tagen davor – Roe Richard \(100\.000 \$, 2026-11-06\); Poe &lt;Pat&gt; \(50\.000 \$, 2026-11-02\)\n/);
  assert.match(many.message, /<b>Hinweis:<\/b> Das Filing erwähnt einen vorab festgelegten Handelsplan \(Rule 10b5-1\)/);
  assert.ok(!many.message.includes('dieselbe Transaktion'));

  // Ein Fonds und sein Verwalter melden denselben Kauf getrennt: gezählt, aber gekennzeichnet.
  const twin = await message({ facts: { cluster: {
    ...FACTS.cluster, otherInsiders: 2, insidersWithSamePurchase: 1, totalValueUsd: 151000,
    purchases: [{ ...purchases[0], value: 51000, sameAsThisPurchase: true }, purchases[1]],
  } } });
  assert.match(twin.message, /– Roe Richard \(51\.000 \$, 2026-11-06\) ⚠️; Poe &lt;Pat&gt; \(50\.000 \$, 2026-11-02\)\n⚠️ Gleiche Stückzahl und gleicher Kaufwert wie dieser Kauf – vermutlich dieselbe Transaktion, doppelt gemeldet, und kein unabhängiger zweiter Käufer\.\n/);

  const unknown = await message({ facts: { cluster: null } });
  assert.match(unknown.message, /<b>Cluster:<\/b> nicht geprüft – Datenbank nicht erreichbar/);
  assert.equal(unknown.hasOrder, true, 'der Order-Vorschlag hängt nicht an der Datenbank');
});

test('Build_Message: Zeile "Markt" nennt Kurs, Marktkapitalisierung, Quelle und Zeitpunkt', async () => {
  const MARKET = {
    price: 5.12, marketCap: 38200000, trailingPE: null, forwardPE: null, fiftyTwoWeekLow: 3.1, fiftyTwoWeekHigh: 9.8,
    shortPercentOfFloat: null, shortRatioDays: null, heldByInstitutionsPct: null,
    source: 'Finnhub', asOf: '2026-11-14T20:59:30.000Z', marketCapBasis: null,
  };
  const derived = { purchaseValuePctOfMarketCap: 0.1335, currentPriceVsInsiderPricePct: -6.9 };
  const line = async (market, extra = {}) => {
    const result = await message({ facts: { market, derived, ...extra.facts }, cfg: extra.cfg });
    return /<b>Markt:<\/b> ([^\n]*)\n/.exec(result.message)[1];
  };

  // Zeitpunkt in deiner Zeitzone: 20:59 UTC ist 21:59 in Berlin.
  assert.equal(await line(MARKET), 'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. 38,20 Mio. $ · Finnhub, 14.11. 21:59');
  assert.equal(await line(MARKET, { cfg: { timeZone: 'America/New_York' } }), 'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. 38,20 Mio. $ · Finnhub, 14.11. 15:59');
  assert.equal(await line(MARKET, { cfg: { timeZone: 'Nicht/Vorhanden' } }), 'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. 38,20 Mio. $ · Finnhub, 14.11. 20:59 UTC');
  assert.equal(await line({ ...MARKET, source: 'Yahoo', asOf: null }), 'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. 38,20 Mio. $ · Yahoo');

  // Berechnete Marktkapitalisierung ist als solche gekennzeichnet, mit Stand der Aktienzahl.
  assert.equal(
    await line({ ...MARKET, marketCap: 38195200, marketCapBasis: { sharesOutstanding: 7460000, asOf: '2026-09-30', source: 'SEC' } }),
    'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. ca. 38,20 Mio. $ (berechnet: Kurs × 7,5 Mio. Aktien lt. SEC, Stand 30.09.2026) · Finnhub, 14.11. 21:59',
  );
  assert.equal(
    await line({ ...MARKET, marketCap: 6400000000, marketCapBasis: { sharesOutstanding: 1250000000, asOf: null, source: 'Finnhub' } }),
    'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. ca. 6,40 Mrd. $ (berechnet: Kurs × 1,25 Mrd. Aktien lt. Finnhub) · Finnhub, 14.11. 21:59',
  );

  // Fehlt die Marktkapitalisierung, steht der Grund dabei (und ist HTML-sicher).
  assert.equal(
    await line({ ...MARKET, marketCap: null }, { facts: { marketCapNote: 'Finnhub: keine Angabe · SEC: <404>' } }),
    'Kurs 5,12 $ (−6,9 % ggü. Insiderpreis) · Marktkap. n. v. (Finnhub: keine Angabe · SEC: &lt;404&gt;) · Finnhub, 14.11. 21:59',
  );

  // Kennzahlen: Short Interest erscheint nur, wenn die Quelle es liefert.
  const finnhub = await message({ facts: { market: { ...MARKET, trailingPE: 14.24 }, derived } });
  assert.match(finnhub.message, /<b>Kennzahlen:<\/b> KGV 14,2\n/);
  const yahoo = await message({ facts: { market: { ...MARKET, source: 'Yahoo', shortPercentOfFloat: 7.5 }, derived } });
  assert.match(yahoo.message, /<b>Kennzahlen:<\/b> KGV n\. v\. · Short Interest 7,5 % des Floats\n/);
});

test('Build_Message: Fallen alle Quellen aus, nennt die Nachricht kurz den Grund', async () => {
  const blocked = await message({ facts: { marketSources: [
    { source: 'Finnhub', ok: false, reason: 'kein Schlüssel' },
    { source: 'Yahoo', ok: false, reason: 'HTTP 429' },
  ] } });
  assert.match(blocked.message, /<b>Markt:<\/b> Marktdaten nicht verfügbar \(Finnhub: kein Schlüssel · Yahoo: HTTP 429\)\n/);
  assert.ok(!blocked.message.includes('Kennzahlen'));
  assert.equal(blocked.hasOrder, true, 'der Order-Vorschlag hängt nicht an den Marktdaten');

  const escaped = await message({ facts: { marketSources: [{ source: 'Finnhub', ok: false, reason: '<b>kaputt</b>' }] } });
  assert.match(escaped.message, /Marktdaten nicht verfügbar \(Finnhub: &lt;b&gt;kaputt&lt;\/b&gt;\)/);

  const silent = await message();
  assert.match(silent.message, /<b>Markt:<\/b> Marktdaten nicht verfügbar\n/);
});

// --------------------------------------------------------- Parse_Callback

const now = () => Math.floor(Date.now() / 1000);
const callback = (data, { fromId = 4242, date = now(), cfg } = {}) => run('Parse_Callback', {
  input: [{
    cfg: { ...CFG, ...cfg },
    body: { callback_query: { id: 'cq', from: { id: fromId }, data, message: { message_id: 77, date, chat: { id: 4242 } } } },
  }],
}).then(([json]) => json);

const VALID = 'o|ACME|111|490|10.2|9.38|11.73';

test('Parse_Callback baut aus einem gültigen Klick eine Bracket-Order für das Paper-Konto', async () => {
  const result = await callback(VALID);
  assert.equal(result.action, 'order');
  assert.equal(result.coid, 'INS-ACME-77');
  assert.deepEqual([result.ticker, result.replyTo], ['ACME', 77]);
  const [parent, takeProfit, stopLoss] = result.orderBody.orders;
  assert.deepEqual(parent, { acctId: 'DU1234567', conid: 111, tif: 'GTC', quantity: 490, cOID: 'INS-ACME-77', orderType: 'LMT', side: 'BUY', price: 10.2 });
  assert.deepEqual([takeProfit.orderType, takeProfit.side, takeProfit.price, takeProfit.parentId], ['LMT', 'SELL', 11.73, 'INS-ACME-77']);
  assert.deepEqual([stopLoss.orderType, stopLoss.side, stopLoss.price, stopLoss.parentId], ['STP', 'SELL', 9.38, 'INS-ACME-77']);
});

test('Parse_Callback sendet nie an ein Konto, das kein Paper-Konto ist', async () => {
  for (const account of ['U1234567', 'F1234567', '', 'DU', 'du1234567']) {
    const result = await callback(VALID, { cfg: { ibkrAccountId: account } });
    assert.equal(result.action, 'invalid', `Konto "${account}"`);
    assert.equal(result.orderBody, undefined);
    assert.match(result.text, /kein Paper-Konto/);
  }
  for (const account of ['DU1234567', 'DF7654321', ' DU1234567 ', 'DUR123456']) {
    assert.equal((await callback(VALID, { cfg: { ibkrAccountId: account } })).action, 'order', `Konto "${account}"`);
  }
});

test('Parse_Callback lehnt fremde, veraltete und manipulierte Klicks ab', async () => {
  assert.match((await callback(VALID, { fromId: 999 })).text, /fremden Telegram-Konto/);
  const expired = await callback(VALID, { date: now() - 25 * 3600 });
  assert.match(expired.text, /älter als 24 Stunden/);
  assert.deepEqual([expired.action, expired.ticker, expired.placed], ['invalid', 'ACME', false]);
  assert.match((await callback(VALID, { date: 0 })).text, /älter als 24 Stunden/);

  const manipulated = [
    'o|ACME|111|490|10.2|9.38',          // zu wenige Felder
    'o|ACME|111|490|10.2|11|11.73',      // Stop-Loss über dem Limit
    'o|ACME|111|490|10.2|9.38|10',       // Take-Profit unter dem Limit
    'o|ACME|111|0|10.2|9.38|11.73',      // Stückzahl 0
    'o|ACME|111|4.5|10.2|9.38|11.73',    // halbe Aktie
    'o|ACME|-5|490|10.2|9.38|11.73',     // ungültige conid
    'o|acme;|111|490|10.2|9.38|11.73',   // ungültiger Ticker
    'kaufen',
    '',
  ];
  for (const data of manipulated) {
    const result = await callback(data);
    assert.equal(result.action, 'invalid', data);
    assert.equal(result.orderBody, undefined, data);
  }
});

test('Parse_Callback: "Verwerfen" sendet keine Order', async () => {
  const result = await callback('x|ACME');
  assert.equal(result.action, 'discard');
  assert.deepEqual([result.ticker, result.placed, result.orderIds], ['ACME', false, []]);
  assert.match(result.text, /Vorschlag für ACME verworfen/);
});

// ---------------------------------------------------------- Format_Result

const REQUEST = [{ chatId: '4242', replyTo: 77, ticker: 'ACME', account: 'DU1234567', quantity: 490, entry: 10.2, stopLoss: 9.38, takeProfit: 11.73 }];
const question = { id: 'r1', message: ['Are you  sure?\nReally?'], isSuppressed: false };
const placed = (id) => ({ order_id: id, order_status: 'PreSubmitted' });

test('Format_Result meldet Erfolg samt bestätigter IBKR-Rückfragen', async () => {
  const [result] = await run('Format_Result', {
    input: [placed('1'), placed('2'), placed('3')],
    nodes: {
      Parse_Callback: REQUEST,
      IBKR_Order: (branch) => (branch === 0 ? [question] : []),
      IBKR_Reply: (branch, runIndex) => {
        if (runIndex > 0) throw new Error('kein weiterer Lauf');
        return [placed('1')];
      },
    },
  });
  assert.match(result.text, /✅ <b>Bracket-Order für ACME an das Paper-Konto DU1234567 übermittelt<\/b>/);
  assert.match(result.text, /Order-IDs: 1 \(PreSubmitted\), 2 \(PreSubmitted\), 3 \(PreSubmitted\)/);
  assert.match(result.text, /• Are you sure\? Really\?/);
  assert.ok(!result.text.includes('weniger als drei'));
  assert.deepEqual(
    [result.action, result.ticker, result.placed, result.orderIds, result.replyTo],
    ['order', 'ACME', true, ['1', '2', '3'], 77],
  );
});

test('Format_Result warnt bei unvollständiger Bracket-Order und meldet Ablehnungen', async () => {
  const nodes = { Parse_Callback: REQUEST, IBKR_Order: () => [], IBKR_Reply: () => { throw new Error('nicht ausgeführt'); } };

  const [partial] = await run('Format_Result', { input: [placed('1')], nodes });
  assert.match(partial.text, /weniger als drei Teilorders/);

  const [rejected] = await run('Format_Result', { input: [{ error: { message: '401 - not authenticated' } }], nodes });
  assert.match(rejected.text, /❌ <b>Order für ACME wurde nicht angenommen<\/b>/);
  assert.match(rejected.text, /401 - not authenticated/);
  assert.deepEqual([rejected.action, rejected.placed, rejected.orderIds], ['order', false, []]);

  const [unanswered] = await run('Format_Result', { input: [question], nodes });
  assert.match(unanswered.text, /Unbeantwortete Rückfrage: Are you  sure\?/);
});

// ------------------------------------------------- Konsistenz der Dateien

test('docker-compose.yml läuft auf dem Mac und lässt sich in Safari öffnen', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  // Mit Secure-Cookie zeigt n8n Safari auf http://localhost nur eine Fehlerseite.
  assert.match(compose, /^ {6}N8N_SECURE_COOKIE: "false"$/m);
  // Vertretbar nur, weil n8n ausschließlich vom eigenen Rechner aus erreichbar ist.
  assert.match(compose, /^ {6}- "127\.0\.0\.1:5678:5678"$/m);
  assert.equal((compose.match(/^ {6}- "[^"]*:\d+:\d+"$/gm) || []).length, 1, 'kein weiterer Port nach außen');
  // macOS belegt Port 5000 für den AirPlay-Empfänger.
  assert.doesNotMatch(compose, /:5000:5000/);
});

test('Workflow, Bridge und init.sh passen zusammen', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));

  // Jede Verbindung und jeder $('Name')-Verweis zeigt auf einen vorhandenen Node.
  for (const [from, outputs] of Object.entries(workflow.connections)) {
    assert.ok(names.has(from), `Verbindung von unbekanntem Node "${from}"`);
    for (const target of outputs.main.flat()) assert.ok(names.has(target.node), `Verbindung zu unbekanntem Node "${target.node}"`);
  }
  const references = [...JSON.stringify(workflow).matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(references.length > 10);
  for (const name of references) assert.ok(names.has(name), `Verweis auf unbekannten Node "${name}"`);

  // Die Webhook-Pfade sind die, an die die Bridge sendet.
  const bridge = fs.readFileSync(path.join(ROOT, 'bridge/src/index.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'bridge/src/replay.js'), 'utf8');
  for (const webhook of workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook')) {
    assert.ok(bridge.includes(webhook.parameters.path), `Bridge kennt den Webhook-Pfad "${webhook.parameters.path}" nicht`);
    assert.equal(webhook.parameters.authentication, 'headerAuth', 'Webhooks müssen das Bridge-Secret verlangen');
  }

  // Jede im Workflow verwendete Credential-ID legt init.sh an; die Workflow-ID stimmt überein.
  const init = fs.readFileSync(path.join(ROOT, 'n8n/init.sh'), 'utf8');
  const credentialIds = new Set(workflow.nodes.flatMap((n) => Object.values(n.credentials || {}).map((c) => c.id)));
  assert.equal(credentialIds.size, 5);
  for (const id of credentialIds) assert.ok(init.includes(`"${id}"`), `init.sh legt die Credential-ID ${id} nicht an`);
  assert.ok(init.includes(`WORKFLOW_ID="${workflow.id}"`));
  assert.equal(workflow.settings.errorWorkflow, workflow.id);

  // Der Workflow protokolliert auf den Wegen, die der Journal-Dienst anbietet.
  const journal = fs.readFileSync(path.join(ROOT, 'research/src/journal.js'), 'utf8');
  for (const [name, route] of [['Signal_Log', '/signals'], ['Order_Log', '/events']]) {
    assert.ok(node(name).parameters.url.endsWith(route), `${name} zeigt nicht auf ${route}`);
    assert.ok(journal.includes(`'POST ${route}'`), `Journal-Dienst kennt POST ${route} nicht`);
    assert.equal(node(name).onError, undefined, `${name} darf Fehler nicht verschlucken`);
  }

  // Jede Meldung geht zuerst in die Datenbank. Fällt sie aus, läuft die Pipeline
  // trotzdem weiter – die Nachricht sagt dann "Cluster: nicht geprüft".
  assert.ok(node('Store_Filing').parameters.url.endsWith('/filings'));
  assert.ok(journal.includes("'POST /filings'"), 'Journal-Dienst kennt POST /filings nicht');
  assert.equal(node('Store_Filing').onError, 'continueRegularOutput');
  const targets = (name, output = 0) => (workflow.connections[name].main[output] || []).map((target) => target.node);
  assert.deepEqual(targets('Parse_Form4'), ['Store_Filing'], 'gespeichert wird vor dem Kauf-Filter – also auch jeder Verkauf');
  assert.deepEqual(targets('Store_Filing'), ['Verkaufswarnung?']);
  assert.deepEqual(targets('Verkaufswarnung?', 0), ['Build_Sell_Alert']);
  assert.deepEqual(targets('Verkaufswarnung?', 1), ['Kauf-Filter']);
  assert.deepEqual(targets('Build_Sell_Alert'), ['Telegram (Verkaufswarnung)']);
  assert.deepEqual(targets('Telegram (Verkaufswarnung)'), ['Kauf-Filter'], 'eine Meldung mit Verkauf und Kauf wird danach normal weiterverarbeitet');
  assert.equal(node('Telegram (Verkaufswarnung)').onError, undefined, 'eine nicht zustellbare Warnung darf nicht still untergehen');

  // Im Workflow stehen keine Zugangsdaten.
  assert.doesNotMatch(JSON.stringify(workflow), /sk-ant-|token=|apiKey=|bot\d+:/i);
});

test('Marktdaten: Finnhub zuerst, Yahoo als Ersatz, kurze Timeouts und höchstens ein Wiederholversuch', () => {
  const targets = (name, output = 0) => (workflow.connections[name].main[output] || []).map((target) => target.node);

  // Reihenfolge der Quellen
  assert.deepEqual(targets('13F_Request'), ['Finnhub aktiv?']);
  assert.deepEqual([targets('Finnhub aktiv?', 0), targets('Finnhub aktiv?', 1)], [['Finnhub_Quote'], ['Yahoo_Cookie']], 'ohne Schlüssel direkt zu Yahoo');
  assert.deepEqual(targets('Finnhub_Quote'), ['Finnhub-Kurs?']);
  assert.deepEqual([targets('Finnhub-Kurs?', 0), targets('Finnhub-Kurs?', 1)], [['Finnhub_Profile'], ['Yahoo_Cookie']], 'ohne Kurs von Finnhub übernimmt Yahoo');
  assert.deepEqual([targets('Finnhub_Profile'), targets('Finnhub_Metric')], [['Finnhub_Metric'], ['Build_Market']]);
  assert.deepEqual([targets('Yahoo_Cookie'), targets('Yahoo_Crumb'), targets('Yahoo_Quote')], [['Yahoo_Crumb'], ['Yahoo_Quote'], ['Build_Market']]);
  assert.deepEqual(targets('Build_Market'), ['Marktkap. fehlt?']);
  assert.deepEqual([targets('Marktkap. fehlt?', 0), targets('Marktkap. fehlt?', 1), targets('SEC_Shares')], [['SEC_Shares'], ['Build_Prompt'], ['Build_Prompt']]);

  // Kein Abruf darf die Meldung lange aufhalten oder abbrechen.
  const marketNodes = ['Finnhub_Quote', 'Finnhub_Profile', 'Finnhub_Metric', 'Yahoo_Cookie', 'Yahoo_Crumb', 'Yahoo_Quote', 'SEC_Shares'];
  for (const name of marketNodes) {
    const n = node(name);
    assert.equal(n.onError, 'continueRegularOutput', `${name} darf den Workflow nicht abbrechen`);
    assert.ok(n.parameters.options.timeout <= 6000, `${name}: Timeout höchstens 6 Sekunden`);
    assert.ok((n.maxTries || 1) <= 2, `${name}: höchstens ein Wiederholversuch`);
    if (n.retryOnFail) assert.ok(n.waitBetweenTries >= 1000 && n.waitBetweenTries <= 3000, `${name}: kurze Pause vor dem Wiederholversuch`);
  }

  // Der Finnhub-Schlüssel kommt als Header aus dem n8n-Credential – nie in der URL.
  for (const name of ['Finnhub_Quote', 'Finnhub_Profile', 'Finnhub_Metric']) {
    const n = node(name);
    assert.deepEqual(n.credentials, { httpHeaderAuth: { id: 'insiderFinnhub01', name: 'Finnhub (API-Key)' } });
    assert.equal(n.parameters.genericAuthType, 'httpHeaderAuth');
    assert.ok(!n.parameters.queryParameters.parameters.some((parameter) => /token|key/i.test(parameter.name)), `${name}: kein Schlüssel als Parameter`);
  }
  const init = fs.readFileSync(path.join(ROOT, 'n8n/init.sh'), 'utf8');
  assert.match(init, /id: "insiderFinnhub01".*\n\s+data: \{ name: "X-Finnhub-Token", value: env\.FINNHUB_API_KEY \|\| "nicht-gesetzt" \}/);

  // Der Schlüssel selbst erreicht nur n8n-init (legt das Credential an). Der
  // Workflow erfährt bloß, ob es einen gibt – ohne Schlüssel bleibt es bei Yahoo.
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  assert.equal((compose.match(/FINNHUB_API_KEY: /g) || []).length, 1);
  assert.match(compose, /^ {6}FINNHUB_API_KEY: \$\{FINNHUB_API_KEY:-\}$/m);
  assert.match(compose, /^ {6}FINNHUB_ENABLED: \$\{FINNHUB_API_KEY:\+true\}$/m);
  const enabled = node('Config').parameters.assignments.assignments.find((assignment) => assignment.name === 'cfg.finnhubEnabled');
  const evaluate = (env) => new Function('$env', `return (${/^=\{\{(.*)\}\}$/s.exec(enabled.value)[1]});`)(env);
  assert.deepEqual([evaluate({ FINNHUB_ENABLED: 'true' }), evaluate({ FINNHUB_ENABLED: '' }), evaluate({})], [true, false, false]);

  // Die .env.example erklärt den Schlüssel und enthält keinen.
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(example, /^FINNHUB_API_KEY=$/m);

  // Die SEC verlangt eine Kennung im User-Agent.
  const secHeaders = node('SEC_Shares').parameters.headerParameters.parameters;
  assert.deepEqual(secHeaders.map((header) => header.name), ['User-Agent']);
  assert.match(node('SEC_Shares').parameters.url, /companyconcept\/CIK\{\{ .+padStart\(10, '0'\) \}\}\/dei\/EntityCommonStockSharesOutstanding\.json$/);
});
