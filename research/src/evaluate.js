'use strict';

const { splitFactorAfter } = require('./prices');

/**
 * Liest Datum und Uhrzeit (US-Ostküste) aus "2026-03-09T19:00:14-04:00".
 * Ein Filing vor 9:30 Uhr ist vor Börsenbeginn öffentlich.
 */
function parseFiledAt(filedAt) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(filedAt || ''));
  if (!match) return null;
  return { date: match[1], beforeOpen: Number(match[2]) * 60 + Number(match[3]) < 9 * 60 + 30 };
}

const calendarDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * Index der ersten Tageskerze, an deren Eröffnung man auf das Filing reagieren
 * kann: derselbe Tag bei Meldung vor Börsenbeginn, sonst der nächste Handelstag.
 * -1, wenn es keine solche Kerze gibt oder sie mehr als eine Woche entfernt liegt
 * (Handel ausgesetzt, Titel damals noch nicht oder nicht mehr gelistet).
 */
function findEntryIndex(bars, filedAt) {
  const filed = parseFiledAt(filedAt);
  if (!filed) return -1;
  const index = bars.findIndex((bar) => (filed.beforeOpen ? bar.date >= filed.date : bar.date > filed.date));
  if (index === -1 || calendarDays(filed.date, bars[index].date) > 7) return -1;
  return index;
}

/**
 * Rendite bei Kauf zur Eröffnung am Einstiegstag und Verkauf zum Schlusskurs
 * `horizon` Handelstage später, dazu die Rendite des Vergleichsindex über
 * denselben Zeitraum. `null`, wenn der Zeitraum noch nicht abgelaufen ist.
 */
function forwardReturn(bars, entryIndex, horizon, benchmarkByDate) {
  const exitIndex = entryIndex + horizon;
  if (exitIndex >= bars.length) return null;
  const entry = bars[entryIndex];
  const exit = bars[exitIndex];
  const ret = exit.close / entry.open - 1;

  const benchEntry = benchmarkByDate.get(entry.date);
  const benchExit = benchmarkByDate.get(exit.date);
  const bench = benchEntry && benchExit ? benchExit.close / benchEntry.open - 1 : null;
  return { ret, bench, excess: bench === null ? null : ret - bench, exitDate: exit.date };
}

/**
 * Simuliert eine Bracket-Order auf Tageskerzen.
 *
 *   entry: 'market' – Kauf zur Eröffnung am Starttag
 *          'limit'  – Kauf, sobald der Kurs `limitPrice` erreicht; die Order
 *                     verfällt nach `limitValidDays` Handelstagen
 *
 * Stop-Loss und Take-Profit beziehen sich wie im Workflow auf den Orderpreis
 * (Limit bzw. Eröffnungskurs). Innerhalb eines Tages ist die Reihenfolge der
 * Kurse unbekannt; es gilt die ungünstige Annahme: Werden Stop und Ziel am
 * selben Tag berührt, zählt der Stop, und am Tag einer Limit-Ausführung zählt
 * nur der Stop.
 */
function simulateBracket(bars, startIndex, options) {
  const {
    entry = 'market', limitPrice, limitValidDays = 20,
    stopLossPct, takeProfitPct, maxHoldDays, costBps = 0,
  } = options;

  let fillIndex = -1;
  let entryPrice = null;
  let filledAtOpen = true;

  if (entry === 'market') {
    if (startIndex < bars.length) {
      fillIndex = startIndex;
      entryPrice = bars[startIndex].open;
    }
  } else {
    const lastIndex = Math.min(startIndex + limitValidDays, bars.length);
    for (let i = startIndex; i < lastIndex; i += 1) {
      if (bars[i].open <= limitPrice) {
        fillIndex = i;
        entryPrice = bars[i].open; // Eröffnung unter dem Limit: besserer Preis
        break;
      }
      if (bars[i].low <= limitPrice) {
        fillIndex = i;
        entryPrice = limitPrice;
        filledAtOpen = false;
        break;
      }
    }
  }

  if (fillIndex === -1) {
    // Noch offen, wenn die Daten vor Ablauf der Gültigkeit enden.
    const pending = entry === 'limit' && startIndex + limitValidDays > bars.length;
    return { filled: false, complete: !pending };
  }

  const reference = entry === 'limit' ? limitPrice : entryPrice;
  const stop = reference * (1 - stopLossPct / 100);
  const target = reference * (1 + takeProfitPct / 100);
  const finish = (index, price, reason) => ({
    filled: true,
    complete: true,
    entryDate: bars[fillIndex].date,
    entryPrice,
    exitDate: bars[index].date,
    exitPrice: price,
    exitReason: reason,
    holdDays: index - fillIndex,
    ret: price / entryPrice - 1 - (2 * costBps) / 10000,
  });

  // Ausführungstag
  const first = bars[fillIndex];
  if (entryPrice <= stop) return finish(fillIndex, entryPrice, 'stop'); // Stop greift sofort
  if (first.low <= stop) return finish(fillIndex, stop, 'stop');
  if (filledAtOpen && first.high >= target) return finish(fillIndex, target, 'target');

  for (let i = fillIndex + 1; i < bars.length; i += 1) {
    const bar = bars[i];
    if (bar.open <= stop) return finish(i, bar.open, 'stop'); // Kurslücke nach unten
    if (bar.open >= target) return finish(i, bar.open, 'target'); // Kurslücke nach oben
    if (bar.low <= stop) return finish(i, stop, 'stop');
    if (bar.high >= target) return finish(i, target, 'target');
    if (i - fillIndex >= maxHoldDays) return finish(i, bar.close, 'time');
  }

  // Daten enden, bevor die Position geschlossen ist: noch nicht auswertbar.
  return { filled: true, complete: false, entryDate: first.date, entryPrice };
}

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/**
 * Wertet ein Signal gegen Kursdaten aus: Renditen über mehrere Haltedauern,
 * drei Order-Regeln im Vergleich und zwei Merkmale aus den Kursen selbst.
 */
function evaluateSignal(signal, prices, benchmarkByDate, params) {
  if (!prices) return { status: 'keine Kursdaten' };
  const { bars, splits } = prices;

  const entryIndex = findEntryIndex(bars, signal.filedAt);
  if (entryIndex === -1) return { status: 'kein Handelstag nach dem Filing' };

  // Der gemeldete Kaufpreis ist nicht splitbereinigt, die Yahoo-Kurse schon.
  const tradeDate = signal.purchase.lastDate || signal.filedAt.slice(0, 10);
  const insiderPrice = signal.purchase.avgPrice * splitFactorAfter(splits, tradeDate);
  const entryBar = bars[entryIndex];

  // Liegt der Marktpreis um ein Vielfaches neben dem Insiderpreis, gehören die
  // Kurse sehr wahrscheinlich zu einem anderen Unternehmen (Ticker neu vergeben).
  const ratio = entryBar.open / insiderPrice;
  if (!(ratio > 1 / 3 && ratio < 3)) return { status: 'Kurs passt nicht zum Insiderpreis' };

  const horizons = {};
  for (const horizon of params.horizons) {
    horizons[horizon] = forwardReturn(bars, entryIndex, horizon, benchmarkByDate);
  }

  const bracket = {
    stopLossPct: params.stopLossPct,
    takeProfitPct: params.takeProfitPct,
    maxHoldDays: params.maxHoldDays,
    costBps: params.costBps,
  };
  const hold = forwardReturn(bars, entryIndex, params.maxHoldDays, benchmarkByDate);
  const strategies = {
    hold: hold
      ? { filled: true, complete: true, ret: hold.ret - (2 * params.costBps) / 10000, exitReason: 'time', holdDays: params.maxHoldDays }
      : { filled: true, complete: false },
    marketBracket: simulateBracket(bars, entryIndex, { ...bracket, entry: 'market' }),
    limitBracket: simulateBracket(bars, entryIndex, {
      ...bracket, entry: 'limit', limitPrice: insiderPrice, limitValidDays: params.limitValidDays,
    }),
  };

  const before = bars.slice(Math.max(0, entryIndex - 20), entryIndex);
  const runupStart = bars[entryIndex - 61];
  return {
    status: 'ok',
    entryDate: entryBar.date,
    entryOpen: entryBar.open,
    insiderPrice,
    premiumToInsider: ratio - 1,
    horizons,
    strategies,
    // Durchschnittlicher Tagesumsatz in USD über die 20 Handelstage vor dem Einstieg.
    dollarVolume: average(before.map((bar) => bar.close * bar.volume)),
    // Kursentwicklung über die 60 Handelstage vor dem Einstieg.
    runup: runupStart ? bars[entryIndex - 1].close / runupStart.close - 1 : null,
  };
}

module.exports = { parseFiledAt, findEntryIndex, forwardReturn, simulateBracket, evaluateSignal };
