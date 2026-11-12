'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const { parseForm4, isPurchase, passesFilter } = require('../src/form4');
const { openDatabase } = require('../src/db');
const { findFollowedSignal, buildSellAlert } = require('../src/alerts');
const { createJournal, createServer } = require('../src/journal');
const { runBackfill } = require('../src/backfill');
const features = require('../src/features');
const { rawTx, rawForm4 } = require('./helpers');

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insider-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const memoryDb = (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
};
const buy = (accessionNo, overrides = {}) => parseForm4(rawForm4({
  accessionNo, transactions: [rawTx('P', 5000, 10, 25000)], ...overrides,
}));
const sell = (accessionNo, overrides = {}) => parseForm4(rawForm4({
  accessionNo, transactions: [rawTx('S', 6000, 15, 19000)], ...overrides,
}));

// ------------------------------------------------------------------ Parser

test('parseForm4 fasst Käufe und Verkäufe getrennt zusammen und liefert jede Zeile für die Datenbank', () => {
  const signal = parseForm4(rawForm4({
    accessionNo: 'a',
    transactions: [
      rawTx('M', 9000, 0, 30000),
      rawTx('P', 3000, 10, 23000),
      rawTx('P', 2000, 10.5, 25000),
      rawTx('S', 4000, 12, 21000, { date: '2024-03-02' }),
      rawTx('S', 1000, 13, 20000, { date: '2024-03-03' }),
      rawTx('F', 500, 12, 19500),
    ],
    footnotes: [{ text: 'Shares sold pursuant to a Rule 10b5-1 trading plan.' }],
  }));

  assert.deepEqual(signal.purchase, {
    lots: 2, shares: 5000, value: 51000, avgPrice: 10.2, firstDate: '2024-03-01', lastDate: '2024-03-01',
    sharesOwnedBefore: 20000, sharesOwnedAfter: 25000, holdingsIncreasePct: 25,
  });
  assert.deepEqual(signal.sale, {
    lots: 2, shares: 5000, value: 61000, avgPrice: 12.2, firstDate: '2024-03-02', lastDate: '2024-03-03',
    sharesOwnedBefore: 25000, sharesOwnedAfter: 20000, holdingsDecreasePct: 20,
  });
  assert.equal(signal.mentions10b51, true);
  assert.deepEqual(signal.transactions.map((row) => row.code), ['M', 'P', 'P', 'S', 'S', 'F']);
  assert.deepEqual(signal.transactions[3], {
    date: '2024-03-02', code: 'S', shares: 4000, price: 12, acquiredDisposed: 'D', sharesOwnedAfter: 21000, ownership: 'D', securityTitle: 'Common Stock',
  });
});

test('parseForm4: ohne Verkauf bleibt "sale" leer, sehr lange Meldungen enden nach 100 Zeilen', () => {
  const signal = buy('a');
  assert.deepEqual([signal.sale.lots, signal.sale.shares, signal.sale.holdingsDecreasePct], [0, 0, null]);
  assert.equal(signal.mentions10b51, false);

  const long = parseForm4(rawForm4({ accessionNo: 'b', transactions: Array.from({ length: 130 }, () => rawTx('P', 10, 5, 100)) }));
  assert.equal(long.transactions.length, 100);
  assert.equal(long.purchase.shares, 1300, 'die Summen zählen trotzdem alle Zeilen');
});

test('Kauf-Filter: Kaufwert zählt, nicht die Stückzahl', () => {
  const few = parseForm4(rawForm4({ accessionNo: 'a', transactions: [rawTx('P', 300, 900, 300)] })); // 270.000 $
  const many = parseForm4(rawForm4({ accessionNo: 'b', transactions: [rawTx('P', 5000, 2, 5000)] })); // 10.000 $
  assert.equal(passesFilter(few, { minValue: 25000 }), true);
  assert.equal(passesFilter(many, { minValue: 25000 }), false);
  assert.equal(passesFilter(many, { minValue: 10000 }), true, 'die Grenze selbst zählt mit');
  assert.equal(passesFilter(few, { minValue: 25000, minShares: 1000 }), false, 'optionale Mindeststückzahl');
  assert.equal(passesFilter(sell('c'), { minValue: 0 }), false);
  assert.equal(isPurchase(many), true);
});

// --------------------------------------------------------------- Datenbank

test('Datenbank speichert jede Meldung mit allen Transaktionen und ersetzt Wiederholungen', (t) => {
  const db = memoryDb(t);

  assert.deepEqual(db.storeFiling(buy('a')), { stored: true, isNew: true });
  assert.deepEqual(db.storeFiling(sell('b', { insiderCik: '200' })), { stored: true, isNew: true });
  assert.deepEqual(db.storeFiling(buy('a')), { stored: true, isNew: false });
  assert.deepEqual(db.storeFiling(buy('c', { filedAt: '2024-03-06T17:00:00-05:00' }), 'backfill'), { stored: true, isNew: true });

  const stats = db.stats();
  assert.deepEqual(
    [stats.filings, stats.withPurchases, stats.withSales, stats.transactions, stats.fromStream, stats.fromBackfill, stats.firstFiledDate, stats.lastFiledDate],
    [3, 2, 1, 3, 2, 1, '2024-03-04', '2024-03-06'],
  );
});

test('Datenbank lehnt unvollständige Meldungen ab und überspringt Meldungen ohne Aktien-Transaktionen', (t) => {
  const db = memoryDb(t);
  assert.equal(db.storeFiling({ accessionNo: 'x' }).stored, false);
  assert.equal(db.storeFiling({ ...buy('a'), filedAt: 'unlesbar' }).stored, false);
  assert.equal(db.storeFiling(null).stored, false);
  assert.deepEqual(
    db.storeFiling(parseForm4(rawForm4({ accessionNo: 'leer', transactions: [] }))),
    { stored: false, isNew: false, reason: 'keine Aktien-Transaktionen' },
  );
  assert.equal(db.stats().filings, 0);
  assert.equal(db.historyDays(), 0);
});

test('Datenbank bleibt über einen Neustart erhalten', (t) => {
  const file = path.join(tempDir(t), 'insider.db');
  const first = openDatabase(file);
  first.storeFiling(buy('a'));
  first.close();

  const second = openDatabase(file);
  t.after(() => second.close());
  assert.equal(second.stats().filings, 1);
  assert.equal(second.storeFiling(buy('a'), 'backfill').isNew, false);
  assert.deepEqual([second.stats().fromStream, second.stats().fromBackfill], [1, 0], 'die Herkunft der ersten Speicherung bleibt stehen');
});

test('historyDays zählt ab der ältesten gespeicherten Meldung', (t) => {
  const db = memoryDb(t);
  const now = Date.parse('2024-03-20T12:00:00Z');
  db.storeFiling(buy('a', { filedAt: '2024-03-10T12:00:00-04:00' }));
  db.storeFiling(buy('b', { filedAt: '2024-03-04T12:00:00-05:00' }));
  assert.equal(db.historyDays(now), 15);
});

// ------------------------------------------------------------------ Cluster

test('Cluster: andere Insider desselben Unternehmens, die kurz zuvor gekauft haben', (t) => {
  const db = memoryDb(t);
  db.storeFiling(buy('a', { insiderCik: '100', insiderName: 'Doe Jane', filedAt: '2024-03-01T17:00:00-05:00' }));
  db.storeFiling(buy('b', { insiderCik: '200', insiderName: 'Roe Richard', relationship: { isDirector: true }, filedAt: '2024-03-08T17:00:00-05:00' }));
  db.storeFiling(sell('c', { insiderCik: '300', filedAt: '2024-03-09T17:00:00-05:00' }));
  db.storeFiling(buy('d', { issuerCik: '2', ticker: 'OTHR', insiderCik: '400', filedAt: '2024-03-09T17:00:00-05:00' }));

  const cluster = db.findCluster({ issuerCik: '1', insiderCik: '500', filedAt: '2024-03-10T17:00:00-04:00', days: 14 });
  assert.equal(cluster.otherInsiders, 2);
  assert.equal(cluster.totalValue, 100000);
  assert.equal(cluster.historyDays, 8, 'gerechnet ab dieser Meldung, nicht ab heute – sonst gälte ein Testlauf mit einer alten Meldung als vollständig geprüft');
  assert.deepEqual(cluster.purchases.map((p) => [p.insiderName, p.role, p.filedDate, p.shares, p.value]), [
    ['Roe Richard', 'Director', '2024-03-08', 5000, 50000],
    ['Doe Jane', 'Officer (Chief Financial Officer)', '2024-03-01', 5000, 50000],
  ]);
  assert.deepEqual([cluster.insidersWithSamePurchase, cluster.purchases.map((p) => p.sameAsThisPurchase)], [0, [false, false]], 'ohne Angabe des eigenen Kaufs wird nichts gekennzeichnet');

  // Gleiche Stückzahl und gleicher Kaufwert wie der eigene Kauf: vermutlich dieselbe Transaktion, doppelt gemeldet.
  const query = { issuerCik: '1', insiderCik: '500', filedAt: '2024-03-10T17:00:00-04:00', days: 14 };
  const twin = db.findCluster({ ...query, purchase: { shares: 5000, value: 50000 } });
  assert.deepEqual([twin.otherInsiders, twin.insidersWithSamePurchase, twin.purchases.map((p) => p.sameAsThisPurchase)], [2, 2, [true, true]]);
  const other = db.findCluster({ ...query, purchase: { shares: 5000, value: 50500 } });
  assert.deepEqual([other.otherInsiders, other.insidersWithSamePurchase, other.purchases.map((p) => p.sameAsThisPurchase)], [2, 0, [false, false]], 'gleiche Stückzahl zu anderem Preis ist ein eigener Kauf');

  assert.equal(db.findCluster({ issuerCik: '1', insiderCik: '200', filedAt: '2024-03-08T17:00:00-05:00', days: 14 }).otherInsiders, 1, 'eigene Käufe zählen nicht');
  assert.equal(db.findCluster({ issuerCik: '1', insiderCik: '500', filedAt: '2024-03-10T17:00:00-04:00', days: 1 }).otherInsiders, 0, 'außerhalb des Zeitfensters');
  assert.equal(db.findCluster({ issuerCik: '1', insiderCik: '500', filedAt: '2024-03-05T17:00:00-05:00', days: 14 }).otherInsiders, 1, 'spätere Käufe waren noch nicht bekannt');
  assert.equal(db.findCluster({ issuerCik: '9', insiderCik: '500', filedAt: '2024-03-10T17:00:00-04:00', days: 14 }).otherInsiders, 0);
});

test('Cluster in der Datenbank und im Backtest sind gleich definiert', (t) => {
  const db = memoryDb(t);
  const universe = [];
  // Reproduzierbare Mischung: 4 Unternehmen, 6 Insider, Meldungen über 60 Tage.
  for (let i = 0; i < 80; i += 1) {
    const day = String(1 + ((i * 7) % 28)).padStart(2, '0');
    const month = i % 2 ? '03' : '04';
    const hour = String(8 + (i % 12)).padStart(2, '0');
    const filing = buy(`f-${i}`, {
      issuerCik: String(1 + (i % 4)),
      insiderCik: String(100 + (i % 6)),
      filedAt: `2024-${month}-${day}T${hour}:15:00-04:00`,
    });
    universe.push(filing);
    db.storeFiling(filing);
  }

  for (const days of [3, 14]) {
    const clusterOf = features.buildClusterIndex(universe, days);
    for (const filing of universe) {
      const fromDb = db.findCluster({ issuerCik: filing.issuerCik, insiderCik: filing.insiderCik, filedAt: filing.filedAt, days });
      assert.equal(
        fromDb.otherInsiders > 0 ? 'Cluster (mehrere Insider)' : 'Einzelkauf',
        clusterOf(filing),
        `${filing.accessionNo} bei ${days} Tagen`,
      );
    }
  }
});

// ----------------------------------------------------------- Verkaufswarnung

const logged = (accessionNo, messageId, overrides = {}) => ({
  accessionNo, telegramMessageId: messageId, rating: 'STARK', form4: buy(accessionNo, overrides),
});
const SALE = { issuerCik: '1', insiderCik: '100', filedAt: '2024-06-03T17:00:00-04:00' };

test('findFollowedSignal: nur derselbe Insider beim selben Unternehmen, nur frühere Käufe', () => {
  const signals = [
    logged('kauf', 11),
    logged('anderer-insider', 12, { insiderCik: '200' }),
    logged('anderes-unternehmen', 13, { issuerCik: '2' }),
    logged('nach-dem-verkauf', 14, { filedAt: '2024-07-01T17:00:00-04:00' }),
  ];
  const events = [11, 12, 13, 14].map((id) => ({ action: 'order', placed: true, telegramMessageId: id }));

  const followed = findFollowedSignal(signals, events, SALE);
  assert.deepEqual(
    [followed.accessionNo, followed.filedAt, followed.shares, followed.avgPrice, followed.rating, followed.orderSent],
    ['kauf', '2024-03-04T17:30:00-05:00', 5000, 10, 'STARK', true],
  );
  assert.equal(findFollowedSignal(signals, events, { ...SALE, insiderCik: '999' }), null);
});

test('findFollowedSignal: Standard warnt nur nach gesendeter Order, "signals" bei jedem gemeldeten Kauf', () => {
  const signals = [logged('kauf', 11)];
  const discarded = [{ action: 'discard', telegramMessageId: 11 }];
  const rejected = [{ action: 'order', placed: false, telegramMessageId: 11 }];

  assert.equal(findFollowedSignal(signals, [], SALE), null);
  assert.equal(findFollowedSignal(signals, discarded, SALE), null);
  assert.equal(findFollowedSignal(signals, rejected, SALE), null, 'von IBKR abgelehnt heißt: keine Position');
  assert.equal(findFollowedSignal(signals, [], { ...SALE, scope: 'signals' }).orderSent, false);
  assert.equal(findFollowedSignal(signals, [{ action: 'order', placed: true, telegramMessageId: 11 }], SALE).orderSent, true);
});

test('findFollowedSignal: nimmt den jüngsten Kauf und ignoriert zu alte', () => {
  const signals = [
    logged('alt', 11, { filedAt: '2023-01-10T17:00:00-05:00' }),
    logged('mittel', 12, { filedAt: '2024-02-01T17:00:00-05:00' }),
    logged('neu', 13, { filedAt: '2024-05-20T17:00:00-04:00' }),
  ];
  const events = [11, 12, 13].map((id) => ({ action: 'order', placed: true, telegramMessageId: id }));

  assert.equal(findFollowedSignal(signals, events, SALE).accessionNo, 'neu');
  assert.equal(findFollowedSignal(signals.slice(0, 2), events, SALE).accessionNo, 'mittel');
  assert.equal(findFollowedSignal(signals.slice(0, 1), events, SALE), null, 'älter als 365 Tage');
  assert.equal(findFollowedSignal(signals.slice(0, 1), events, { ...SALE, lookbackDays: 800 }).accessionNo, 'alt');
});

test('buildSellAlert meldet Verkauf, Anteil am Bestand und das Signal, dem du gefolgt bist', (t) => {
  const journal = createJournal(tempDir(t));
  journal.appendSignal(logged('kauf', 11));
  journal.appendEvent({ action: 'order', placed: true, telegramMessageId: 11 });

  const sale = sell('verkauf', { filedAt: SALE.filedAt, footnotes: [{ text: 'Sold under a 10b5-1 plan.' }] });
  const alert = buildSellAlert(sale, journal, {});
  assert.deepEqual([alert.ticker, alert.insiderName, alert.mentions10b51], ['ACME', 'Doe Jane', true]);
  assert.deepEqual([alert.sale.shares, alert.sale.value, alert.sale.avgPrice, alert.sale.holdingsDecreasePct], [6000, 90000, 15, 24]);
  assert.deepEqual([alert.followed.accessionNo, alert.followed.orderSent], ['kauf', true]);

  assert.equal(buildSellAlert(buy('kein-verkauf', { filedAt: SALE.filedAt }), journal, {}), null);
  assert.equal(buildSellAlert(sell('fremd', { filedAt: SALE.filedAt, insiderCik: '200' }), journal, {}), null);
});

// ------------------------------------------------------------- HTTP-Dienst

async function startServer(t, context) {
  const journal = createJournal(tempDir(t));
  const db = openDatabase(':memory:');
  const server = createServer(journal, () => {}, { db, ...context });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => {
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { journal, db, base, post };
}

test('POST /filings speichert, erkennt Cluster und warnt einmalig bei Verkäufen', async (t) => {
  const { journal, post, base } = await startServer(t, { clusterDays: 14 });

  const first = await post('/filings', buy('a', { insiderCik: '100' }));
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.stored, first.body.isNew, first.body.cluster.otherInsiders, first.body.sellAlert], [true, true, 0, null]);

  const second = await post('/filings', buy('b', { insiderCik: '200', filedAt: '2024-03-06T17:00:00-05:00' }));
  assert.equal(second.body.cluster.otherInsiders, 1);
  assert.equal(second.body.cluster.purchases[0].insiderName, 'Doe Jane');
  assert.deepEqual(
    [second.body.cluster.insidersWithSamePurchase, second.body.cluster.purchases[0].sameAsThisPurchase], [1, true],
    'beide Meldungen nennen 5.000 Aktien für 50.000 $ – das wird gekennzeichnet',
  );

  // Der erste Kauf wurde gemeldet und die Order gesendet; jetzt verkauft derselbe Insider.
  journal.appendSignal(logged('a', 11));
  journal.appendEvent({ action: 'order', placed: true, telegramMessageId: 11 });
  const sale = sell('s1', { insiderCik: '100', filedAt: '2024-06-03T17:00:00-04:00' });

  const alerted = await post('/filings', sale);
  assert.equal(alerted.body.cluster, null, 'Cluster betrifft nur Käufe');
  assert.equal(alerted.body.sellAlert.followed.accessionNo, 'a');
  assert.equal(alerted.body.sellAlert.sale.shares, 6000);

  const repeated = await post('/filings', sale);
  assert.deepEqual([repeated.body.isNew, repeated.body.sellAlert], [false, null], 'ein Testlauf mit derselben Meldung warnt nicht erneut');
  assert.deepEqual(
    journal.readEvents().filter((event) => event.action === 'sell-alert')
      .map((event) => [event.ticker, event.accessionNo, event.followedAccessionNo, event.orderSent, event.saleShares, event.saleValue]),
    [['ACME', 's1', 'a', true, 6000, 90000]],
    'die Warnung steht genau einmal im Protokoll',
  );

  const backfilled = await post('/filings?source=backfill', sell('s2', { insiderCik: '100', filedAt: '2024-06-04T17:00:00-04:00' }));
  assert.equal(backfilled.body.sellAlert, null, 'Nachladen löst keine Warnungen aus');

  const stats = await (await fetch(`${base}/stats`)).json();
  assert.deepEqual([stats.filings, stats.withPurchases, stats.withSales, stats.fromBackfill], [4, 2, 2, 1]);
});

test('POST /filings: ungültige Meldungen 400, leere Meldungen ohne Fehler, ohne Datenbank 503', async (t) => {
  const { post } = await startServer(t, {});
  assert.equal((await post('/filings', { accessionNo: 'x' })).status, 400);
  const empty = await post('/filings', parseForm4(rawForm4({ accessionNo: 'leer', transactions: [] })));
  assert.deepEqual([empty.status, empty.body.stored, empty.body.cluster, empty.body.sellAlert], [200, false, null, null]);

  const bare = createServer(createJournal(tempDir(t)));
  bare.listen(0);
  await once(bare, 'listening');
  t.after(() => bare.close());
  const url = `http://127.0.0.1:${bare.address().port}`;
  assert.equal((await fetch(`${url}/stats`)).status, 503);
  assert.equal((await fetch(`${url}/filings`, { method: 'POST', body: '{}' })).status, 503);
  assert.equal((await fetch(`${url}/healthz`)).status, 200, 'das Signal-Protokoll läuft auch ohne Datenbank');
});

test('Verkaufswarnung mit "signals" auch ohne gesendete Order', async (t) => {
  const { journal, post } = await startServer(t, { sellAlert: { scope: 'signals' } });
  journal.appendSignal(logged('a', 11));
  const response = await post('/filings', sell('s1', { filedAt: '2024-06-03T17:00:00-04:00' }));
  assert.equal(response.body.sellAlert.followed.orderSent, false);
});

test('Verkaufswarnung mit "off" bleibt aus, gespeichert wird trotzdem', async (t) => {
  const { journal, post, db } = await startServer(t, { sellAlert: { scope: 'off' } });
  journal.appendSignal(logged('a', 11));
  journal.appendEvent({ action: 'order', placed: true, telegramMessageId: 11 });
  const response = await post('/filings', sell('s1', { filedAt: '2024-06-03T17:00:00-04:00' }));
  assert.deepEqual([response.status, response.body.stored, response.body.sellAlert], [201, true, null]);
  assert.equal(db.stats().withSales, 1);
  assert.equal(journal.readEvents().some((event) => event.action === 'sell-alert'), false);
});

test('Protokoll liest neu, sobald etwas angehängt wurde, und gibt den Zwischenspeicher nicht aus der Hand', (t) => {
  const journal = createJournal(tempDir(t));
  assert.deepEqual([journal.readSignals(), journal.readEvents()], [[], []]);

  journal.appendSignal(logged('a', 11));
  journal.appendEvent({ action: 'discard', telegramMessageId: 11 });
  assert.deepEqual(journal.readSignals().map((entry) => entry.accessionNo), ['a']);
  journal.readEvents().push({ action: 'von außen angehängt' });
  journal.readSignals().length = 0;
  assert.equal(journal.readEvents().length, 1);
  assert.equal(journal.readSignals().length, 1);

  journal.appendSignal(logged('b', 12));
  journal.appendEvent({ action: 'order', placed: true, telegramMessageId: 12 });
  assert.deepEqual(journal.readSignals().map((entry) => entry.accessionNo), ['a', 'b']);
  assert.deepEqual(journal.readEvents().map((event) => event.action), ['discard', 'order']);

  // Auch eine zweite Instanz (z. B. "research report") sieht den aktuellen Stand.
  assert.equal(createJournal(journal.dataDir).readSignals().length, 2);
});

// ---------------------------------------------------------------- Backfill

test('Backfill lädt die Käufe der letzten Tage ungekürzt und schreibt sie über den Protokoll-Dienst', async (t) => {
  const { db, base } = await startServer(t, {});
  const requested = [];
  const secApi = {
    fetchPurchases: async (from, to, options) => {
      requested.push([from, to, options]);
      return [buy('a'), buy('b', { insiderCik: '200' }), { accessionNo: 'kaputt' }];
    },
  };

  const first = await runBackfill({ days: 30, journalUrl: base }, { secApi });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(requested[0][1], today);
  assert.equal(Math.round((Date.parse(today) - Date.parse(requested[0][0])) / 86400000), 30);
  assert.deepEqual(requested[0][2], { full: true });
  assert.deepEqual([first.found, first.stored, first.added, first.failed], [3, 2, 2, 1]);
  assert.equal(db.stats().fromBackfill, 2);

  const again = await runBackfill({ days: 30, journalUrl: base }, { secApi });
  assert.deepEqual([again.stored, again.added], [2, 0], 'ein zweiter Lauf legt nichts doppelt an');

  const dated = await runBackfill({ days: 10, to: '2024-03-31', journalUrl: base }, { secApi });
  assert.deepEqual([dated.from, dated.to, requested.at(-1).slice(0, 2)], ['2024-03-21', '2024-03-31', ['2024-03-21', '2024-03-31']]);
});

test('Backfill erklärt, wenn der Protokoll-Dienst nicht läuft', async () => {
  const secApi = { fetchPurchases: async () => [buy('a')] };
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(runBackfill({ days: 5, journalUrl: 'http://journal:8090' }, { secApi, fetchImpl }), /nicht erreichbar.*docker compose up/);
});
