'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { addDays } = require('./sec-api');
const { evaluateSignal } = require('./evaluate');
const { loadPrices } = require('./backtest');
const { horizonTable, segmentTable } = require('./analysis');
const { table, toCsv, pct } = require('./render');

const today = () => new Date().toISOString().slice(0, 10);

/** Was nach der Telegram-Nachricht geschah, je Nachricht. */
function decisionsByMessage(events) {
  const rank = { 'Order gesendet': 3, 'Order abgelehnt': 2, verworfen: 1 };
  const decisions = new Map();
  for (const event of events) {
    let decision = null;
    if (event.action === 'order') decision = event.placed ? 'Order gesendet' : 'Order abgelehnt';
    if (event.action === 'discard') decision = 'verworfen';
    if (!decision || event.telegramMessageId === null || event.telegramMessageId === undefined) continue;
    const key = String(event.telegramMessageId);
    if ((rank[decision] || 0) > (rank[decisions.get(key)] || 0)) decisions.set(key, decision);
  }
  return decisions;
}

/**
 * Wertet das Signal-Protokoll aus: Wie haben sich die gemeldeten Aktien seit
 * dem Signal entwickelt – insgesamt, je Einstufung des Modells und je Entscheidung?
 */
async function runReport(params, deps) {
  const log = deps.log || (() => {});
  const entries = deps.journal.readSignals().filter((entry) => entry.form4 && entry.form4.filedAt);
  if (entries.length === 0) {
    return { report: 'Noch keine Signale protokolliert. Das Protokoll füllt sich mit jeder Telegram-Meldung der Pipeline.', records: [] };
  }

  const decisions = decisionsByMessage(deps.journal.readEvents());
  const firstDay = entries.map((entry) => entry.form4.filedAt.slice(0, 10)).sort()[0];
  const tickers = [...new Set(entries.map((entry) => entry.form4.ticker))];
  log(`Lade Kurse für ${tickers.length} Titel ...`);
  const prices = await loadPrices(deps.prices, tickers, params.benchmark, addDays(firstDay, -130), today(), log);

  const items = entries
    .sort((a, b) => a.form4.filedAt.localeCompare(b.form4.filedAt))
    .map((entry) => {
      const signal = entry.form4;
      let decision = 'kein Order-Vorschlag';
      if (entry.order) decision = decisions.get(String(entry.telegramMessageId)) || 'keine Reaktion';
      return {
        entry,
        signal,
        result: evaluateSignal(signal, prices.byTicker.get(signal.ticker), prices.benchmarkByDate, params),
        labels: { rating: entry.rating || 'ohne Einstufung', decision },
      };
    });
  const evaluated = items.filter((item) => item.result.status === 'ok');

  const excess = (item, horizon) => {
    const outcome = item.result.status === 'ok' ? item.result.horizons[horizon] : null;
    return outcome && outcome.excess !== null ? outcome.excess : null;
  };

  const lines = ['# Auswertung des Signal-Protokolls', ''];
  lines.push(`Stand ${today()}: ${entries.length} Signale protokolliert, ${evaluated.length} mit Kursdaten.`);
  lines.push(`Kauf zum Eröffnungskurs am ersten Handelstag nach dem Filing; Überrendite gegenüber ${params.benchmark}. Ein Signal zählt bei einer Haltedauer erst mit, wenn sie abgelaufen ist.`);

  if (evaluated.length > 0) {
    lines.push('', '## Alle Signale', '', horizonTable(evaluated, params.horizons));
    lines.push('', '## Nach Einstufung des Modells', '', segmentTable(evaluated, 'rating', params.horizons, { compact: true }));
    lines.push('', '## Nach deiner Entscheidung', '', segmentTable(evaluated, 'decision', params.horizons, { compact: true }));
  }

  lines.push('', '## Letzte Signale', '');
  lines.push(table(
    ['Gemeldet', 'Ticker', 'Einstufung', 'Entscheidung', ...params.horizons.map((h) => `Überrendite ${h} T.`)],
    items.slice(-20).reverse().map((item) => [
      item.signal.filedAt.slice(0, 10),
      item.signal.ticker,
      item.labels.rating,
      item.labels.decision,
      ...params.horizons.map((h) => (item.result.status === 'ok' ? pct(excess(item, h)) : item.result.status)),
    ]),
  ));
  lines.push('', 'Erst ab etwa 100 Signalen je Gruppe lassen sich Unterschiede zwischen den Einstufungen von Zufall trennen.');

  const records = items.map((item) => {
    const record = {
      filedAt: item.signal.filedAt,
      ticker: item.signal.ticker,
      insider: item.signal.insiderName,
      role: item.signal.role,
      shares: item.signal.purchase.shares,
      valueUsd: item.signal.purchase.value,
      rating: item.labels.rating,
      decision: item.labels.decision,
      status: item.result.status,
      entryDate: item.result.entryDate || null,
      entryOpen: item.result.entryOpen ? Number(item.result.entryOpen.toFixed(4)) : null,
    };
    for (const horizon of params.horizons) {
      const outcome = item.result.status === 'ok' ? item.result.horizons[horizon] : null;
      record[`ret${horizon}`] = outcome ? Number(outcome.ret.toFixed(4)) : null;
      record[`excess${horizon}`] = outcome && outcome.excess !== null ? Number(outcome.excess.toFixed(4)) : null;
    }
    return { ...record, accessionNo: item.signal.accessionNo };
  });

  const report = lines.join('\n');
  if (params.outDir) {
    fs.mkdirSync(params.outDir, { recursive: true });
    fs.writeFileSync(path.join(params.outDir, 'signals-report.md'), `${report}\n`);
    fs.writeFileSync(path.join(params.outDir, 'signals-report.csv'), toCsv(Object.keys(records[0]), records));
  }
  return { report, records, evaluated };
}

module.exports = { runReport, decisionsByMessage };
