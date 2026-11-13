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
  const $ = (nodeName) => {
    if (!(nodeName in nodes)) throw new Error(`Node "${nodeName}" wurde nicht ausgeführt`);
    const value = nodes[nodeName];
    const items = (branch, runIndex) => wrap(typeof value === 'function' ? value(branch, runIndex) : value);
    return { first: (b, r) => items(b, r)[0], all: (b, r) => items(b, r) };
  };
  const output = await new AsyncFunction('$input', '$', node(name).parameters.jsCode)($input, $);
  return output.map((item) => item.json);
}

const CFG = {
  minPurchaseValueUsd: 25000, orderBudgetUsd: 5000, orderQuantity: 0, stopLossPct: 8, takeProfitPct: 15,
  orderMaxAgeHours: 24, telegramChatId: '4242', ibkrAccountId: 'DU1234567', model: 'claude-haiku-5-5',
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
  accessionNo: '0001000000-26-000001', ticker: 'ACME', issuerName: 'ACME Corp', insiderName: 'Doe Jane', role: 'Officer (CEO)',
  filedAt: '2026-11-10', transactionCodes: ['P'], mentions10b51: false, footnotes: [], link: 'https://www.sec.gov/x',
  purchase: { lots: 1, shares: 5000, value: 51000, avgPrice: 10.2, firstDate: '2026-11-09', lastDate: '2026-11-09', sharesOwnedBefore: 20000, sharesOwnedAfter: 25000, holdingsIncreasePct: 25 },
};
const quote = (price = 12) => ({ quoteSummary: { result: [{
  price: { regularMarketPrice: { raw: price }, marketCap: { raw: 1.5e9 } },
  summaryDetail: { trailingPE: { raw: 18.44 } },
  defaultKeyStatistics: { shortPercentOfFloat: { raw: 0.075 } },
}] } });

const CLUSTER = {
  windowDays: 14, historyDays: 30, otherInsiders: 2, insidersWithSamePurchase: 0, totalValue: 150000,
  purchases: [
    { insiderName: 'Roe Richard', role: 'Director', filedDate: '2026-11-06', shares: 10000, value: 100000, sameAsThisPurchase: false },
    { insiderName: 'Poe <Pat>', role: 'Officer (CFO)', filedDate: '2026-11-02', shares: 5000, value: 50000, sameAsThisPurchase: false },
  ],
};
const STORED = { stored: true, isNew: true, cluster: CLUSTER, sellAlert: null };

test('Build_Prompt berechnet Erfolgsquote, filtert 13F-Positionen und baut eine gültige Anfrage', async () => {
  const [{ facts, llmRequest }] = await run('Build_Prompt', {
    input: [quote()],
    nodes: {
      Config: config(),
      Parse_Form4: [SIGNAL],
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
});

test('Build_Prompt: Cluster aus der Datenbank – unvollständige Historie wird gekennzeichnet, ein Ausfall nicht geraten', async () => {
  const cluster = async (stored) => {
    const [{ facts }] = await run('Build_Prompt', {
      input: [quote()],
      nodes: { Config: config(), Parse_Form4: [{ ...SIGNAL, mentions10b51: true }], Store_Filing: [stored], Insider_Historie: [{}], '13F_Request': [{}] },
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
  const [{ facts }] = await run('Build_Prompt', {
    input: failed,
    nodes: { Config: config(), Parse_Form4: [SIGNAL], Store_Filing: failed, Insider_Historie: failed, '13F_Request': failed },
  });
  assert.equal(facts.market, null);
  assert.equal(facts.history, null);
  assert.equal(facts.institutions, null);
  assert.equal(facts.cluster, null);
  assert.deepEqual(facts.derived, { purchaseValuePctOfMarketCap: null, currentPriceVsInsiderPricePct: null });
});

// ---------------------------------------------------------- Build_Message

const FACTS = {
  ...SIGNAL,
  market: null, history: null, institutions: null,
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
  for (const account of ['DU1234567', 'DF7654321', ' DU1234567 ']) {
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
  assert.equal(credentialIds.size, 4);
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
