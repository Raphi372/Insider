'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize } = require('../src/stats');
const { pct, share, table, toCsv } = require('../src/render');
const { parseFiledAt, findEntryIndex, forwardReturn, simulateBracket, evaluateSignal } = require('../src/evaluate');
const features = require('../src/features');
const { makeBars, bar, signal } = require('./helpers');

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || ''} erwartet ${expected}, erhalten ${actual}`);

// ------------------------------------------------------------ Grundlagen

test('summarize liefert Mittelwert, Median, Trefferquote und t-Wert', () => {
  const stats = summarize([0.1, -0.05, 0.2, 0, NaN, null]);
  assert.equal(stats.n, 4);
  close(stats.mean, 0.0625);
  close(stats.median, 0.05);
  close(stats.hitRate, 0.5);
  close(stats.tStat, 0.0625 / (Math.sqrt(((0.0375 ** 2) + (0.1125 ** 2) + (0.1375 ** 2) + (0.0625 ** 2)) / 3) / 2));
  assert.deepEqual(summarize([]), { n: 0, mean: null, median: null, hitRate: null, tStat: null });
  assert.equal(summarize([0.1]).tStat, null);
});

test('Formatierung: Prozent, Tabelle und Excel-CSV', () => {
  assert.deepEqual([pct(0.0123), pct(-0.5), pct(-0.0004), pct(null), share(0.544)], ['+1,2 %', '−50,0 %', '0,0 %', '–', '54 %']);
  assert.equal(table(['Gruppe', 'n'], [['Alle', '12']]), '| Gruppe |   n |\n| :----- | --: |\n| Alle   |  12 |');
  assert.equal(toCsv(['a', 'b'], [{ a: 1.5, b: 'x;y' }, { a: null, b: '"q"' }]), '﻿a;b\r\n1,5;"x;y"\r\n;"""q"""\r\n');
});

// --------------------------------------------------------------- Einstieg

test('Einstieg: nach Börsenschluss gemeldet -> nächster Handelstag, vor Börsenbeginn -> derselbe Tag', () => {
  const bars = makeBars('2024-03-01', 10); // Fr 1.3., Mo 4.3., Di 5.3., ...
  assert.deepEqual(parseFiledAt('2024-03-04T17:30:00-05:00'), { date: '2024-03-04', beforeOpen: false });
  assert.equal(bars[findEntryIndex(bars, '2024-03-04T17:30:00-05:00')].date, '2024-03-05');
  assert.equal(bars[findEntryIndex(bars, '2024-03-04T11:00:00-05:00')].date, '2024-03-05', 'während des Handels: vorsichtshalber nächster Tag');
  assert.equal(bars[findEntryIndex(bars, '2024-03-04T08:15:00-05:00')].date, '2024-03-04');
  assert.equal(bars[findEntryIndex(bars, '2024-03-01T18:00:00-05:00')].date, '2024-03-04', 'Freitagabend -> Montag');
  assert.equal(bars[findEntryIndex(bars, '2024-03-02T08:00:00-05:00')].date, '2024-03-04', 'Samstag -> Montag');
});

test('Einstieg: kein Handelstag in Reichweite', () => {
  const bars = makeBars('2024-03-01', 5);
  assert.equal(findEntryIndex(bars, '2024-03-07T17:00:00-05:00'), -1, 'Daten enden');
  assert.equal(findEntryIndex(bars, '2024-02-01T17:00:00-05:00'), -1, 'erste Kerze liegt Wochen nach dem Filing');
  assert.equal(findEntryIndex(bars, 'unlesbar'), -1);
});

test('forwardReturn: Eröffnung bis Schlusskurs N Tage später, Überrendite gegen den Index', () => {
  const bars = makeBars('2024-03-04', 30, (i) => 100 + i); // jeden Tag +1
  const bench = new Map(makeBars('2024-03-04', 30, (i) => 400 + 2 * i).map((b) => [b.date, b]));

  const result = forwardReturn(bars, 2, 5, bench);
  close(result.ret, 107 / 102 - 1);
  close(result.bench, 414 / 404 - 1);
  close(result.excess, 107 / 102 - 414 / 404);
  assert.equal(result.exitDate, bars[7].date);

  assert.equal(forwardReturn(bars, 26, 5, bench), null, 'Haltedauer noch nicht abgelaufen');
  assert.equal(forwardReturn(bars, 2, 5, new Map()).excess, null, 'ohne Indexdaten keine Überrendite');
});

// ---------------------------------------------------------- Bracket-Order

const BRACKET = { stopLossPct: 8, takeProfitPct: 15, maxHoldDays: 5, costBps: 0 };
const days = (...bars) => bars.map((values, i) => bar(`2024-03-${String(4 + i).padStart(2, '0')}`, ...values));

test('Marktorder: Ziel, Stop und Zeitablauf', () => {
  const target = simulateBracket(days([100], [101], [110, { high: 116 }]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([target.exitReason, target.holdDays], ['target', 2]);
  close(target.exitPrice, 115);
  close(target.ret, 0.15);

  const stop = simulateBracket(days([100], [99, { low: 91 }]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([stop.exitReason, stop.exitPrice], ['stop', 92]);
  close(stop.ret, -0.08);

  const time = simulateBracket(days([100], [101], [102], [103], [104], [105, { close: 106 }], [200]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([time.exitReason, time.exitPrice, time.holdDays], ['time', 106, 5]);
});

test('Im Zweifel gegen die Strategie: Stop vor Ziel am selben Tag, Kurslücken zum Eröffnungskurs', () => {
  const both = simulateBracket(days([100], [100, { high: 120, low: 90 }]), 0, { ...BRACKET, entry: 'market' });
  assert.equal(both.exitReason, 'stop');

  const gapDown = simulateBracket(days([100], [85]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([gapDown.exitReason, gapDown.exitPrice], ['stop', 85], 'Stop wird zum schlechteren Eröffnungskurs ausgeführt');

  const gapUp = simulateBracket(days([100], [120]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([gapUp.exitReason, gapUp.exitPrice], ['target', 120]);

  const sameDay = simulateBracket(days([100, { low: 90 }]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([sameDay.exitReason, sameDay.holdDays], ['stop', 0]);
});

test('Kosten werden für Kauf und Verkauf abgezogen', () => {
  const result = simulateBracket(days([100], [120]), 0, { ...BRACKET, entry: 'market', costBps: 10 });
  close(result.ret, 0.2 - 0.002);
});

test('Limit-Order: Ausführung zum Limit, zur besseren Eröffnung oder gar nicht', () => {
  const limit = { ...BRACKET, entry: 'limit', limitPrice: 100, limitValidDays: 3 };

  const touched = simulateBracket(days([105], [104, { low: 99 }], [103], [116, { high: 116 }]), 0, limit);
  assert.deepEqual([touched.filled, touched.entryDate, touched.entryPrice, touched.exitReason], [true, '2024-03-05', 100, 'target']);

  const gapBelow = simulateBracket(days([105], [96], [97], [98], [99], [99], [99, { close: 99.5 }]), 0, limit);
  assert.deepEqual([gapBelow.entryPrice, gapBelow.exitReason, gapBelow.exitPrice], [96, 'time', 99.5], 'Eröffnung unter dem Limit -> Kauf zur Eröffnung');

  const never = simulateBracket(days([105], [104], [103], [90]), 0, limit);
  assert.deepEqual(never, { filled: false, complete: true }, 'der Kurs erreicht das Limit erst nach Ablauf der Gültigkeit');

  const pending = simulateBracket(days([105], [104]), 0, limit);
  assert.deepEqual(pending, { filled: false, complete: false }, 'Gültigkeit läuft noch');
});

test('Limit-Order: Stop und Ziel beziehen sich auf das Limit; am Ausführungstag zählt nur der Stop', () => {
  const limit = { ...BRACKET, entry: 'limit', limitPrice: 100, limitValidDays: 3 };

  const crash = simulateBracket(days([105, { low: 90 }]), 0, limit);
  assert.deepEqual([crash.entryPrice, crash.exitReason, crash.exitPrice, crash.holdDays], [100, 'stop', 92, 0]);

  const spike = simulateBracket(days([105, { low: 99, high: 120 }], [101], [102], [103], [104], [105, { close: 105 }]), 0, limit);
  assert.equal(spike.exitReason, 'time', 'ein Hoch am Ausführungstag kann vor dem Kauf gelegen haben');

  const belowStop = simulateBracket(days([105], [90]), 0, limit);
  assert.deepEqual([belowStop.entryPrice, belowStop.exitReason], [90, 'stop'], 'Eröffnung unter dem Stop: Kauf und sofortiger Stop');
  close(belowStop.ret, 0);
});

test('Enden die Daten vor dem Ausstieg, gilt der Trade als offen', () => {
  const open = simulateBracket(days([100], [101]), 0, { ...BRACKET, entry: 'market' });
  assert.deepEqual([open.filled, open.complete], [true, false]);
});

// ------------------------------------------------------- Signal auswerten

const PARAMS = { horizons: [5, 20], stopLossPct: 8, takeProfitPct: 15, maxHoldDays: 20, limitValidDays: 10, costBps: 10 };

test('evaluateSignal rechnet Renditen, Order-Regeln und Kursmerkmale', () => {
  // 100 Tage flach bei 100, ab dem Einstieg täglich +0,5.
  const bars = makeBars('2023-10-02', 200, (i) => (i < 110 ? 100 : 100 + (i - 110) * 0.5));
  const filedDay = bars[109].date;
  const bench = new Map(makeBars('2023-10-02', 200, () => 400).map((b) => [b.date, b]));

  const result = evaluateSignal(signal({ filedAt: `${filedDay}T17:00:00-05:00` }), { bars, splits: [] }, bench, PARAMS);
  assert.equal(result.status, 'ok');
  assert.equal(result.entryDate, bars[110].date);
  close(result.horizons[5].ret, 102.5 / 100 - 1);
  close(result.horizons[5].excess, 0.025);
  close(result.horizons[20].ret, 0.1);
  close(result.strategies.hold.ret, 0.1 - 0.002);
  assert.equal(result.strategies.marketBracket.exitReason, 'time');
  assert.deepEqual(result.strategies.limitBracket.filled, true, 'Eröffnung genau am Insiderpreis');
  close(result.dollarVolume, 100 * 100000);
  close(result.runup, 0);
  close(result.premiumToInsider, 0);
});

test('evaluateSignal passt den Insiderpreis an spätere Splits an', () => {
  // Insider zahlte 400 $ vor einem 4:1-Split; die bereinigten Kurse stehen bei 100 $.
  const bars = makeBars('2024-01-02', 120);
  const bench = new Map(bars.map((b) => [b.date, b]));
  const splits = [{ date: bars[100].date, numerator: 4, denominator: 1 }];
  const filedAt = `${bars[60].date}T17:00:00-05:00`;

  const result = evaluateSignal(signal({ filedAt, purchase: { avgPrice: 400, lastDate: bars[59].date } }), { bars, splits }, bench, PARAMS);
  assert.equal(result.status, 'ok');
  close(result.insiderPrice, 100);

  const noSplit = evaluateSignal(signal({ filedAt, purchase: { avgPrice: 400, lastDate: bars[59].date } }), { bars, splits: [] }, bench, PARAMS);
  assert.equal(noSplit.status, 'Kurs passt nicht zum Insiderpreis', 'ohne Split wäre 100 $ gegen 400 $ ein anderer Titel');
});

test('evaluateSignal meldet fehlende Daten statt zu raten', () => {
  const bench = new Map();
  assert.equal(evaluateSignal(signal(), null, bench, PARAMS).status, 'keine Kursdaten');
  assert.equal(evaluateSignal(signal(), { bars: makeBars('2025-01-02', 30), splits: [] }, bench, PARAMS).status, 'kein Handelstag nach dem Filing');
});

// --------------------------------------------------------------- Merkmale

test('Rolle, Kaufvolumen, Bestand, Handelbarkeit und Vorlauf werden eingeordnet', () => {
  const role = (overrides) => features.roleClass(signal(overrides));
  assert.equal(role({ role: 'Officer (Chief Financial Officer)' }), 'CEO/CFO/President');
  assert.equal(role({ role: 'Officer (President and COO), Director' }), 'CEO/CFO/President');
  assert.equal(role({ role: 'Officer (Senior Vice President)' }), 'Anderer Officer');
  assert.equal(role({ role: 'Director', isOfficer: false, isDirector: true }), 'Director');
  assert.equal(role({ role: '10%-Eigner', isOfficer: false, isTenPercentOwner: true }), '10%-Eigner');
  assert.equal(role({ role: 'unbekannt', isOfficer: false }), 'Sonstige');

  const value = (v) => features.valueBucket(signal({ purchase: { value: v } }));
  assert.deepEqual([value(49999), value(50000), value(999999), value(1e6)], ['unter 50.000 $', '50.000–250.000 $', '250.000–1 Mio. $', 'über 1 Mio. $']);

  const holdings = (p) => features.holdingsBucket(signal({ purchase: { holdingsIncreasePct: p } }));
  assert.deepEqual([holdings(null), holdings(4.9), holdings(5), holdings(25)], ['Erstkauf', 'Bestand +0–5 %', 'Bestand +5–25 %', 'Bestand über +25 %']);

  assert.deepEqual([features.liquidityBucket(5e5), features.liquidityBucket(5e6), features.liquidityBucket(5e7), features.liquidityBucket(null)],
    ['Tagesumsatz unter 1 Mio. $', 'Tagesumsatz 1–10 Mio. $', 'Tagesumsatz über 10 Mio. $', 'unbekannt']);
  assert.deepEqual([features.runupBucket(-0.3), features.runupBucket(-0.1), features.runupBucket(0), features.runupBucket(null)],
    ['Kurs zuvor unter −20 %', 'Kurs zuvor −20 bis 0 %', 'Kurs zuvor nicht gefallen', 'unbekannt']);
});

test('Cluster: ein anderer Insider desselben Unternehmens hat kurz zuvor gekauft', () => {
  const a = signal({ accessionNo: 'a', insiderCik: '100', filedAt: '2024-03-01T17:00:00-05:00' });
  const b = signal({ accessionNo: 'b', insiderCik: '200', filedAt: '2024-03-10T17:00:00-04:00' });
  const sameInsider = signal({ accessionNo: 'c', insiderCik: '200', filedAt: '2024-03-12T17:00:00-04:00' });
  const late = signal({ accessionNo: 'd', insiderCik: '300', filedAt: '2024-04-20T17:00:00-04:00' });
  const otherIssuer = signal({ accessionNo: 'e', issuerCik: '2', insiderCik: '400', filedAt: '2024-03-10T17:00:00-04:00' });
  const clusterOf = features.buildClusterIndex([a, b, sameInsider, late, otherIssuer], 14);

  assert.equal(clusterOf(a), 'Einzelkauf', 'spätere Käufe anderer zählen nicht – sie waren noch nicht bekannt');
  assert.equal(clusterOf(b), 'Cluster (mehrere Insider)');
  assert.equal(clusterOf(sameInsider), 'Cluster (mehrere Insider)');
  assert.equal(clusterOf(late), 'Einzelkauf', 'außerhalb des Zeitfensters');
  assert.equal(clusterOf(otherIssuer), 'Einzelkauf');
});

test('Routinekäufer: in den drei Vorjahren jeweils im selben Monat gekauft', () => {
  const buy = (date, insiderCik = '100') => signal({ accessionNo: `${insiderCik}-${date}`, insiderCik, filedAt: `${date}T17:00:00-05:00` });
  const universe = [
    buy('2021-03-10'), buy('2022-03-08'), buy('2023-03-15'), buy('2024-03-05'),
    buy('2022-03-08', '200'), buy('2023-03-15', '200'), buy('2024-03-05', '200'),
  ];
  const routineOf = features.buildRoutineIndex(universe, '2021-01-01');

  assert.equal(routineOf(buy('2024-03-05')), 'Routinekäufer');
  assert.equal(routineOf(buy('2024-03-05', '200')), 'Gelegenheitskäufer', 'nur zwei Vorjahre');
  assert.equal(routineOf(buy('2024-06-05')), 'Gelegenheitskäufer', 'anderer Monat');
  assert.equal(routineOf(buy('2023-03-15')), 'unbekannt (Historie zu kurz)', 'drei Jahre zurück liegt vor Beginn der Daten');
});
