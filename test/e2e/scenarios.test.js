'use strict';

// End-to-End-Szenarien gegen ein echtes n8n mit dem ausgelieferten Workflow.
// Externe Dienste spielt der Mock-Server; gestartet wird alles über run.sh.

const test = require('node:test');
const assert = require('node:assert/strict');
const { streamFiling, BROKEN_ACCESSION, LLM_VERDICT } = require('./fixtures');
const {
  CHAT_ID, sleep, control, requests, telegram, emit, click, waitFor, waitForMessages, buttons,
  journal, loggedSignal, loggedEvent, webhook, bridgeConnected,
} = require('./helpers');

test.before(bridgeConnected);

test.beforeEach(() => control('reset', {}));

test('Insiderkauf: Analyse per Telegram, Order erst nach Klick auf den Button', async () => {
  await emit(
    streamFiling('0001000000-26-000050', '8-K'),
    streamFiling('0001000000-26-000001'),
    streamFiling('0001000000-26-000001'), // Duplikat
  );

  const [message] = await waitForMessages(1);
  const { text } = message.body;

  // -- Nachricht: Kennzahlen stammen aus dem Workflow, nicht aus dem Modell
  assert.equal(String(message.body.chat_id), String(CHAT_ID));
  assert.equal(message.body.parse_mode, 'HTML');
  assert.match(text, /🟢 <b>Insiderkauf ACME<\/b> – Signal: <b>STARK<\/b>/);
  assert.match(text, /ACME Corp &lt;Test &amp; Co&gt;/, 'HTML muss maskiert sein');
  assert.match(text, /<b>Insider:<\/b> Doe Jane – Officer \(Chief Financial Officer\)/);
  assert.match(text, /<b>Kauf:<\/b> 5\.000 Aktien zu Ø 10,20 \$ = 51\.000 \$/);
  assert.match(text, /<b>Bestand danach:<\/b> 25\.000 Aktien \(\+25,0 %\)/);
  assert.match(text, /<b>Cluster:<\/b> kein weiterer Insiderkauf in den 14 Tagen davor \(Datenbank reicht weniger als einen Tag zurück\)/, 'die Datenbank ist noch leer – das steht dabei');
  assert.match(text, /Kurs 12,00 \$ \(\+17,6 % ggü\. Insiderpreis\) · Marktkap\. 1,50 Mrd\. \$/);
  assert.match(text, /KGV 18,4 · Short Interest 7,5 % des Floats/);
  assert.match(text, /<b>Historie:<\/b> 1 frühere Käufe, 1 Verkäufe · 1 von 1 Käufen heute im Plus \(Ø \+50,0 %/);
  assert.match(text, /<b>13F-Halter:<\/b> Alpha Capital \(120\.000 Stück, 2025-12-31\); Beta Partners \(30\.000 Stück, 2025-12-31\)/);
  assert.match(text, /Die CFO stockt ihren Bestand um ein Viertel auf &lt;ohne&gt; Verkaufsdruck\./);
  assert.match(text, /➕ Bestand \+25 %/);
  assert.match(text, /Kauf 490 × ACME, Limit 10,20 \$/);
  assert.match(text, /Stop-Loss 9,38 \$ \(−8 %\) · Take-Profit 11,73 \$ \(\+15 %\)/);
  assert.ok(!text.includes('This message was sent automatically with n8n'));

  const [orderButton, discardButton] = buttons(message);
  assert.equal(orderButton.callback_data, 'o|ACME|111|490|10.2|9.38|11.73');
  assert.equal(discardButton.callback_data, 'x|ACME');

  // -- sec-api: richtige Abfragen, API-Key als Query-Parameter
  const sec = await requests('sec');
  assert.deepEqual(sec.map((r) => `${r.path} ${r.body.query}`), [
    '/sec/insider-trading accessionNo:"0001000000-26-000001"',
    '/sec/insider-trading issuer.cik:1000001 AND reportingOwner.cik:2000001',
    '/sec/form-13f/holdings holdings.ticker:ACME',
  ]);
  assert.ok(sec.every((r) => r.query.token === 'e2e-sec-key'));

  // -- Yahoo: Cookie -> Crumb -> quoteSummary
  const yahoo = await requests('yahoo');
  assert.deepEqual(yahoo.map((r) => r.path), ['/yahoo-cookie', '/yahoo/v1/test/getcrumb', '/yahoo/v10/finance/quoteSummary/ACME']);
  assert.equal(yahoo[2].query.crumb, 'CRUMB-123');
  assert.equal(yahoo[2].headers.cookie, 'A3=e2e-cookie; B=other');

  // -- Anthropic: aktuelles Modell, keine Sampling-Parameter, JSON-Schema
  const [llm] = await requests('anthropic');
  assert.equal(llm.headers['x-api-key'], 'sk-ant-e2e');
  assert.equal(llm.headers['anthropic-version'], '2026-10-21');
  assert.equal(llm.body.model, 'claude-haiku-5-5');
  assert.ok(llm.body.max_tokens >= 2000, 'max_tokens muss Platz für thinking lassen');
  assert.equal(llm.body.output_config.format.type, 'json_schema');
  assert.deepEqual(llm.body.output_config.format.schema.properties.signal.enum, ['SCHWACH', 'MITTEL', 'STARK']);
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(key in llm.body), `${key} darf nicht gesendet werden`);
  assert.equal(llm.body.messages.length, 1);
  assert.match(llm.body.messages[0].content, /"ticker": "ACME"/);
  assert.match(llm.body.messages[0].content, /"holdingsIncreasePct": 25/);
  assert.match(llm.body.messages[0].content, /"cluster": \{\s+"windowDays": 14,\s+"otherInsiders": 0,/);
  assert.match(llm.body.messages[0].content, /"complete": false/);

  // -- Bis hierhin wurde bei IBKR nur der Kontrakt nachgeschlagen
  let ibkr = await requests('ibkr');
  assert.deepEqual(ibkr.map((r) => `${r.method} ${r.path}`), ['GET /ibkr/v1/api/trsrv/stocks']);

  // Das Duplikat und das 8-K dürfen keine zweite Nachricht auslösen.
  await sleep(3000);
  assert.equal((await telegram('sendMessage')).length, 1);

  // -- Das Signal steht mit Kennzahlen, Einstufung und Order-Vorschlag im Protokoll
  const entry = await loggedSignal('0001000000-26-000001');
  assert.equal(entry.rating, 'STARK');
  assert.deepEqual(entry.analysis, LLM_VERDICT);
  assert.equal(entry.form4.ticker, 'ACME');
  assert.equal(entry.form4.purchase.shares, 5000);
  assert.equal(entry.form4.insiderCik, '2000001');
  assert.equal(entry.market.price, 12);
  assert.equal(entry.history.priorPurchases, 1);
  assert.deepEqual(entry.cluster, { windowDays: 14, otherInsiders: 0, insidersWithSamePurchase: 0, totalValueUsd: 0, purchases: [], historyDays: 0, complete: false });
  assert.deepEqual(entry.order, { ticker: 'ACME', conid: 111, quantity: 490, entry: 10.2, stopLoss: 9.38, takeProfit: 11.73 });
  assert.equal(typeof entry.telegramMessageId, 'number', 'über die Nachrichten-ID wird der spätere Klick zugeordnet');

  // -- Klick auf "Order senden" unter genau dieser Nachricht
  const messageId = entry.telegramMessageId;
  await click(orderButton.callback_data, messageId);

  const [, status] = await waitForMessages(2);
  assert.match(status.body.text, /✅ <b>Bracket-Order für ACME an das Paper-Konto DU1234567 übermittelt<\/b>/);
  assert.match(status.body.text, /Order-IDs: 1001 \(PreSubmitted\), 1002 \(PreSubmitted\), 1003 \(PreSubmitted\)/);
  assert.match(status.body.text, /This order will most likely trigger and fill immediately\. Are you sure/);

  ibkr = await requests('ibkr');
  assert.deepEqual(ibkr.map((r) => `${r.method} ${r.path}`), [
    'GET /ibkr/v1/api/trsrv/stocks',
    'POST /ibkr/v1/api/iserver/account/DU1234567/orders',
    'POST /ibkr/v1/api/iserver/reply/reply-1',
  ]);
  assert.deepEqual(ibkr[1].body, {
    orders: [
      { acctId: 'DU1234567', conid: 111, tif: 'GTC', quantity: 490, cOID: `INS-ACME-${messageId}`, orderType: 'LMT', side: 'BUY', price: 10.2 },
      { acctId: 'DU1234567', conid: 111, tif: 'GTC', quantity: 490, parentId: `INS-ACME-${messageId}`, orderType: 'LMT', side: 'SELL', price: 11.73 },
      { acctId: 'DU1234567', conid: 111, tif: 'GTC', quantity: 490, parentId: `INS-ACME-${messageId}`, orderType: 'STP', side: 'SELL', price: 9.38 },
    ],
  });
  assert.deepEqual(ibkr[2].body, { confirmed: true });

  // -- Die Bridge quittiert den Klick und entfernt die Buttons
  const [edit] = await waitFor('Buttons entfernt', async () => {
    const edits = await telegram('editMessageReplyMarkup');
    return edits.length ? edits : null;
  });
  assert.deepEqual(edit.body, { chat_id: CHAT_ID, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  assert.equal((await telegram('answerCallbackQuery')).length, 1);

  // -- Auch die Entscheidung steht im Protokoll
  const event = await loggedEvent(messageId, 'order');
  assert.deepEqual([event.ticker, event.placed, event.orderIds], ['ACME', true, ['1001', '1002', '1003']]);

  // -- Die Meldung liegt in der Datenbank – genau einmal, trotz Duplikat im Stream
  const stats = await journal('stats');
  assert.deepEqual(
    [stats.filings, stats.withPurchases, stats.withSales, stats.transactions, stats.fromStream, stats.firstFiledDate],
    [1, 1, 0, 2, 1, '2026-11-10'],
  );
});

test('Kauft ein zweiter Insider desselben Unternehmens, nennt die Meldung den Cluster', async () => {
  await emit(streamFiling('0001000000-26-000009'));

  const [message] = await waitForMessages(1);
  const { text } = message.body;
  assert.match(text, /<b>Insiderkauf ACME<\/b>/);
  assert.match(text, /<b>Insider:<\/b> Roe Richard – Director/);
  assert.match(text, /<b>Kauf:<\/b> 4\.000 Aktien zu Ø 10,25 \$ = 41\.000 \$/);
  assert.match(text, /<b>Bestand danach:<\/b> 4\.000 Aktien\n/, 'Erstkauf: keine Prozentangabe');
  assert.match(text, /<b>Cluster:<\/b> 1 weiterer Insider kaufte in den 14 Tagen davor – Doe Jane \(51\.000 \$, 2026-11-10\)\n/);
  assert.equal(buttons(message)[0].callback_data, 'o|ACME|111|487|10.25|9.43|11.79');

  // Das Modell bekommt den Cluster als Tatsache vorgelegt.
  const [llm] = await requests('anthropic');
  assert.match(llm.body.messages[0].content, /"otherInsiders": 1,/);
  assert.match(llm.body.messages[0].content, /"insiderName": "Doe Jane",\s+"role": "Officer \(Chief Financial Officer\)",\s+"filedDate": "2026-11-10"/);
  assert.match(llm.body.system, /Käufe mehrerer Insider in kurzer Zeit \(Cluster\)/);

  // Die Historie wird für diesen Insider abgefragt, nicht für die erste Käuferin.
  assert.ok((await requests('sec')).some((r) => r.body.query === 'issuer.cik:1000001 AND reportingOwner.cik:2000002'));

  const entry = await loggedSignal('0001000000-26-000009');
  assert.deepEqual([entry.cluster.otherInsiders, entry.cluster.totalValueUsd, entry.cluster.purchases.length], [1, 51000, 1]);
  assert.deepEqual([entry.cluster.insidersWithSamePurchase, entry.cluster.purchases[0].sameAsThisPurchase], [0, false], 'anderer Umfang, also ein eigener Kauf');
  assert.equal(entry.form4.insiderName, 'Roe Richard');
});

test('Verkauft ein Insider, dessen Kauf du gefolgt bist, warnt Telegram – genau einmal', async () => {
  const accessionNo = '0001000000-26-000010';
  await emit(streamFiling(accessionNo));

  const [message] = await waitForMessages(1);
  const { text } = message.body;
  assert.equal(String(message.body.chat_id), String(CHAT_ID));
  assert.equal(message.body.parse_mode, 'HTML');
  assert.match(text, /^🔻 <b>Insiderverkauf ACME<\/b> – du bist dem Kauf dieses Insiders gefolgt\nACME Corp &lt;Test &amp; Co&gt;\n/);
  assert.match(text, /<b>Insider:<\/b> Doe Jane – Officer \(Chief Financial Officer\)/);
  assert.match(text, /<b>Verkauf:<\/b> 6\.000 Aktien zu Ø 12,50 \$ = 75\.000 \$/);
  assert.match(text, /<b>Handelstag:<\/b> 2026-11-11\n/);
  assert.match(text, /<b>Bestand danach:<\/b> 19\.000 Aktien \(−24,0 %\)/);
  assert.match(text, /<b>Früherer Kauf:<\/b> gemeldet am 2026-11-10, 5\.000 Aktien zu Ø 10,20 \$/);
  assert.match(text, /vorab festgelegten Handelsplan \(Rule 10b5-1\)/);
  assert.match(text, /Du hattest zu diesem Kauf eine Order gesendet\. Es wird nichts automatisch verkauft/);
  assert.equal(buttons(message).length, 0, 'eine Warnung, kein Order-Vorschlag');
  assert.ok(!text.includes('This message was sent automatically with n8n'));

  // Die Warnung steht im Protokoll und verweist auf den Kauf aus dem ersten Szenario.
  const alert = await waitFor('Verkaufswarnung im Protokoll', async () =>
    (await journal('events')).find((event) => event.action === 'sell-alert' && event.accessionNo === accessionNo));
  assert.deepEqual(
    [alert.ticker, alert.followedAccessionNo, alert.orderSent, alert.saleShares, alert.saleValue],
    ['ACME', '0001000000-26-000001', true, 6000, 75000],
  );

  // Dieselbe Meldung noch einmal (z. B. ein Testlauf mit replay.js): gespeichert, aber keine zweite Warnung.
  assert.equal((await webhook('sec-filing', { ...streamFiling(accessionNo), replay: true })).status, 200);
  await waitFor('zweite Abfrage des Filings', async () => (await requests('sec')).length >= 2);
  await sleep(4000);
  assert.equal((await telegram('sendMessage')).length, 1);
  assert.equal((await journal('events')).filter((event) => event.action === 'sell-alert').length, 1);

  // Ein Verkauf ist kein Kaufsignal: keine Analyse, kein Kontrakt, keine weiteren Abfragen.
  assert.equal((await requests('sec')).length, 2);
  assert.equal((await requests('anthropic')).length, 0);
  assert.equal((await requests('ibkr')).length, 0);
  assert.equal((await journal('stats')).withSales, 1);
});

test('Verkauf, Preis 0 und zu kleiner Kaufwert lösen nichts aus – gespeichert werden sie trotzdem', async () => {
  const before = await journal('stats');
  await emit(
    streamFiling('0001000000-26-000002'), // Verkauf
    streamFiling('0001000000-26-000003'), // Preis 0
    streamFiling('0001000000-26-000004'), // 500 × 30 $ = 15.000 $
    streamFiling('0001000000-26-000012'), // 5.000 × 2 $ = 10.000 $ – viele Aktien, wenig Geld
  );

  await waitFor('vier Form-4-Abfragen', async () => (await requests('sec')).length >= 4);
  const after = await waitFor('vier Meldungen in der Datenbank', async () => {
    const stats = await journal('stats');
    return stats.filings >= before.filings + 4 ? stats : null;
  });
  await sleep(4000);

  assert.equal((await requests('sec')).length, 4, 'nach dem Filter darf keine weitere Abfrage folgen');
  assert.equal((await requests('anthropic')).length, 0);
  assert.equal((await requests('ibkr')).length, 0);
  assert.equal((await telegram('sendMessage')).length, 0);
  assert.deepEqual(
    [after.filings - before.filings, after.withPurchases - before.withPurchases, after.withSales - before.withSales],
    [4, 2, 1],
    'alle vier Meldungen liegen in der Datenbank',
  );
});

test('Wenige teure Aktien: Es zählt der Kaufwert, nicht die Stückzahl', async () => {
  await emit(streamFiling('0001000000-26-000011'));

  const [message] = await waitForMessages(1);
  assert.match(message.body.text, /<b>Insiderkauf PRCY<\/b>/);
  assert.match(message.body.text, /<b>Kauf:<\/b> 300 Aktien zu Ø 900,00 \$ = 270\.000 \$/);
  assert.match(message.body.text, /Kauf 5 × PRCY, Limit 900,00 \$ \(4\.500 \$\)/);
  assert.equal(buttons(message)[0].callback_data, 'o|PRCY|555|5|900|828|1035');
  assert.equal((await loggedSignal('0001000000-26-000011')).form4.purchase.value, 270000);
});

test('Fallen Yahoo und Anthropic aus, kommt die Meldung trotzdem – ohne KI-Einstufung', async () => {
  await control('behavior', { yahooDown: true, anthropicStatus: 500 });
  await emit(streamFiling('0001000000-26-000006'));

  const [message] = await waitForMessages(1, 90000);
  const { text } = message.body;
  assert.match(text, /ℹ️ <b>Insiderkauf DOWN<\/b> – ohne KI-Einstufung/);
  assert.match(text, /<b>Markt:<\/b> Marktdaten nicht verfügbar/);
  assert.match(text, /<b>Historie:<\/b> 1 frühere Käufe, 1 Verkäufe$/m, 'ohne Kurs keine Erfolgsquote');
  assert.match(text, /⚠️ KI-Analyse nicht verfügbar/);
  assert.equal(buttons(message)[0].callback_data, 'o|DOWN|333|490|10.2|9.38|11.73');
  assert.ok(!text.includes(LLM_VERDICT.begruendung));

  const entry = await loggedSignal('0001000000-26-000006');
  assert.deepEqual([entry.rating, entry.analysis, entry.market], [null, null, null], 'Lücken stehen als null im Protokoll');
  assert.match(entry.analysisNote, /KI-Analyse nicht verfügbar/);
  assert.equal(entry.cluster.otherInsiders, 0, 'die Datenbank ist von dem Ausfall nicht betroffen');
});

test('Verkauf nach einem gemeldeten Kauf ohne gesendete Order: keine Warnung', async () => {
  // DOWN wurde im vorigen Szenario gemeldet, aber niemand hat auf "Order senden" getippt.
  const accessionNo = '0001000000-26-000013';
  const before = await journal('stats');
  await emit(streamFiling(accessionNo));

  await waitFor('Verkauf in der Datenbank', async () => (await journal('stats')).withSales > before.withSales);
  await sleep(4000);
  assert.equal((await telegram('sendMessage')).length, 0);
  assert.equal((await journal('events')).some((event) => event.action === 'sell-alert' && event.accessionNo === accessionNo), false);
});

test('Kennt IBKR keinen Kontrakt, kommt die Analyse ohne Order-Button', async () => {
  await emit(streamFiling('0001000000-26-000007'));

  const [message] = await waitForMessages(1);
  assert.match(message.body.text, /Insiderkauf NOIB/);
  assert.match(message.body.text, /Kein US-Kontrakt für NOIB bei IBKR gefunden – kein Order-Vorschlag\./);
  assert.equal(buttons(message).length, 0);
  assert.equal((await loggedSignal('0001000000-26-000007')).order, null);
});

test('Noch nicht indexiertes Filing wird nach kurzer Wartezeit erneut abgefragt', async () => {
  await emit(streamFiling('0001000000-26-000005'));

  const [message] = await waitForMessages(1, 90000);
  assert.match(message.body.text, /Insiderkauf LATE/);
  const lookups = (await requests('sec')).filter((r) => r.body.query === 'accessionNo:"0001000000-26-000005"');
  assert.equal(lookups.length, 2);
});

test('Fremde, veraltete und verworfene Klicks senden keine Order', async () => {
  // Fremdes Telegram-Konto: schon die Bridge lehnt ab.
  await click('o|ACME|111|490|10.2|9.38|11.73', 801, { fromId: 999 });
  const [denied] = await waitFor('Ablehnung', async () => {
    const answers = await telegram('answerCallbackQuery');
    return answers.length ? answers : null;
  });
  assert.equal(denied.body.show_alert, true);

  // Vorschlag älter als ORDER_BUTTON_MAX_AGE_HOURS.
  await click('o|ACME|111|490|10.2|9.38|11.73', 802, { date: Math.floor(Date.now() / 1000) - 30 * 3600 });
  const [expired] = await waitForMessages(1);
  assert.match(expired.body.text, /⌛ Der Vorschlag für ACME ist älter als 24 Stunden – es wurde keine Order gesendet\./);

  // "Verwerfen".
  await click('x|ACME', 803);
  const [, discarded] = await waitForMessages(2);
  assert.match(discarded.body.text, /🗑 Vorschlag für ACME verworfen/);

  // Manipulierte Button-Daten (Stop-Loss über dem Limit).
  await click('o|ACME|111|490|10.2|12|11.73', 804);
  const [, , invalid] = await waitForMessages(3);
  assert.match(invalid.body.text, /⛔ Order-Daten im Button sind ungültig/);

  assert.equal((await requests('ibkr')).length, 0);

  // Verworfene und abgelehnte Klicks stehen ebenfalls im Protokoll.
  assert.deepEqual([(await loggedEvent(803, 'discard')).ticker, (await loggedEvent(803, 'discard')).placed], ['ACME', false]);
  assert.equal((await loggedEvent(802, 'invalid')).placed, false);
});

test('Lehnt IBKR die Order ab, meldet Telegram den Grund', async () => {
  await click('o|REJ|444|490|10.2|9.38|11.73', 805);

  const [message] = await waitForMessages(1);
  assert.match(message.body.text, /❌ <b>Order für REJ wurde nicht angenommen<\/b>/);
  assert.match(message.body.text, /not authenticated|401|Authorization/i);
  assert.deepEqual([(await loggedEvent(805, 'order')).placed, (await loggedEvent(805, 'order')).orderIds], [false, []]);
});

test('Bricht der Workflow ab, meldet der Error Trigger den Fehler per Telegram', async () => {
  await emit(streamFiling(BROKEN_ACCESSION));

  const [message] = await waitForMessages(1, 90000);
  assert.match(message.body.text, /^FEHLER IM WORKFLOW: .+ beim Node Form4_Details\./);
  assert.equal(String(message.body.chat_id), String(CHAT_ID));
  assert.equal(message.body.parse_mode, 'HTML');
});

test('Bleibt ein Filing bei sec-api unauffindbar, fällt das per Telegram auf', async () => {
  const accessionNo = '0001000000-26-000077';
  await emit(streamFiling(accessionNo));

  // Drei Wiederholungen im Abstand von 20 Sekunden, dann Abbruch mit Fehlermeldung.
  const [message] = await waitForMessages(1, 150000);
  assert.match(message.body.text, new RegExp(`^FEHLER IM WORKFLOW: Form 4 ${accessionNo} wurde auch nach mehreren Versuchen nicht`));
  assert.match(message.body.text, /beim Node Abbruch \(nicht indexiert\)\./);
  assert.equal((await requests('sec')).length, 4);
});

test('Die Webhooks nehmen ohne Bridge-Secret nichts an', async () => {
  const forged = {
    callback_query: {
      id: 'forged', from: { id: CHAT_ID }, data: 'o|ACME|111|490|10.2|9.38|11.73',
      message: { message_id: 900, date: Math.floor(Date.now() / 1000), chat: { id: CHAT_ID } },
    },
  };
  const post = (path, headers) => webhook(path, path === 'order-confirm' ? forged : streamFiling('0001000000-26-000001'), headers);

  assert.equal((await post('order-confirm', {})).status, 403);
  assert.equal((await post('order-confirm', { 'x-bridge-token': 'falsch' })).status, 403);
  assert.equal((await post('sec-filing', {})).status, 403);

  await sleep(3000);
  assert.equal((await requests('ibkr')).length, 0);
  assert.equal((await requests('sec')).length, 0);
  assert.equal((await telegram('sendMessage')).length, 0);
});
