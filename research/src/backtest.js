'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { passesFilter } = require('./form4');
const { addDays } = require('./sec-api');
const { evaluateSignal } = require('./evaluate');
const features = require('./features');
const { horizonTable, strategyTable, segmentTable } = require('./analysis');
const { toCsv, pct } = require('./render');

const today = () => new Date().toISOString().slice(0, 10);

/** Führt `task` für alle Einträge aus, höchstens `limit` gleichzeitig. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Lädt Kurse für alle Ticker und den Vergleichsindex. */
async function loadPrices(priceClient, tickers, benchmark, from, to, log) {
  const benchmarkPrices = await priceClient.getBars(benchmark, from, to);
  if (!benchmarkPrices) throw new Error(`Keine Kursdaten für den Vergleichsindex ${benchmark}`);

  let done = 0;
  const entries = await mapLimit(tickers, 3, async (ticker) => {
    let prices = null;
    try {
      prices = await priceClient.getBars(ticker, from, to);
    } catch (err) {
      log(`  ${ticker}: ${err.message}`);
    }
    done += 1;
    if (done % 100 === 0) log(`  Kurse: ${done} von ${tickers.length}`);
    return [ticker, prices];
  });
  return {
    byTicker: new Map(entries),
    benchmarkByDate: new Map(benchmarkPrices.bars.map((bar) => [bar.date, bar])),
  };
}

const count = (n) => Number(n).toLocaleString('de-DE');

function buildReport({ params, universe, candidates, evaluated, excluded }) {
  const lines = [];
  const segmentHorizons = [20, 60].filter((h) => params.horizons.includes(h));
  const shownHorizons = segmentHorizons.length ? segmentHorizons : params.horizons.slice(0, 2);

  lines.push('# Backtest Insiderkäufe', '');
  lines.push(`Filings vom ${params.from} bis ${params.to}, erstellt am ${today()}.`);
  const sharesNote = params.minShares > 0 ? `, mehr als ${count(params.minShares)} Aktien` : '';
  lines.push(`Filter wie im Workflow: Offenmarktkauf (Code P), Kaufwert ab ${count(params.minValue)} $${sharesNote}, Preis über 0.`);
  lines.push(`Vergleichsindex: ${params.benchmark}. Überrendite = Rendite der Aktie minus Rendite des Index im selben Zeitraum.`, '');

  lines.push('## Datengrundlage', '');
  lines.push(`- Insiderkäufe im Zeitraum (alle Größen): ${count(universe)}`);
  lines.push(`- davon über dem Filter: ${count(candidates)}`);
  lines.push(`- auswertbar: ${count(evaluated.length)}`);
  for (const [status, n] of Object.entries(excluded)) lines.push(`- nicht auswertbar – ${status}: ${count(n)}`);
  if (excluded['keine Kursdaten']) {
    lines.push('', `Achtung: Zu ${count(excluded['keine Kursdaten'])} von ${count(candidates)} Signalen liefert Yahoo keine Kurse. Das sind überwiegend Unternehmen, die inzwischen insolvent, übernommen oder von der Börse genommen sind. Weil gerade die Verlierer fehlen, fallen die Ergebnisse unten besser aus, als sie tatsächlich waren.`);
  }

  if (evaluated.length === 0) {
    lines.push('', 'Keine auswertbaren Signale – Zeitraum oder Filter prüfen.');
    return lines.join('\n');
  }

  lines.push('', '## 1. Was ist das Signal wert?', '');
  lines.push('Kauf zum Eröffnungskurs am ersten Handelstag nach dem Filing, Verkauf zum Schlusskurs nach der angegebenen Zahl von Handelstagen. Ohne Kosten.', '');
  lines.push(horizonTable(evaluated, params.horizons));

  lines.push('', '## 2. Order-Regeln im Vergleich', '');
  lines.push(`Stop-Loss ${params.stopLossPct} %, Take-Profit ${params.takeProfitPct} %, spätester Ausstieg nach ${params.maxHoldDays} Handelstagen, Limit-Order ${params.limitValidDays} Handelstage gültig. Renditen nach Kosten von ${params.costBps} Basispunkten je Kauf und je Verkauf.`, '');
  lines.push(strategyTable(evaluated, params));
  const premium = evaluated.map((e) => e.result.premiumToInsider);
  lines.push('', `Am Einstiegstag eröffnete die Aktie im Mittel ${pct(premium.reduce((a, b) => a + b, 0) / premium.length)} gegenüber dem Insiderpreis. „Ø je Signal“ rechnet nicht ausgeführte Orders mit 0 ein und ist die Zahl, die für den Vergleich der Regeln zählt.`);

  lines.push('', '## 3. Welche Signale sind besser?', '');
  lines.push('Überrendite nach Merkmalen. „Treffer“ ist der Anteil der Signale, die besser liefen als der Index. Kleine Gruppen (n unter etwa 50) und t-Werte unter 2 sagen wenig aus.');
  const segments = [
    ['role', 'Rolle des Insiders'],
    ['value', 'Kaufvolumen'],
    ['holdings', 'Veränderung des Bestands'],
    ['cluster', `Cluster-Käufe (weiterer Insider in den ${params.clusterDays} Tagen davor)`],
    ['routine', 'Routine- oder Gelegenheitskäufer'],
    ['liquidity', 'Handelbarkeit'],
    ['runup', 'Kursverlauf in den 60 Handelstagen davor'],
  ];
  for (const [name, title] of segments) {
    lines.push('', `### ${title}`, '', segmentTable(evaluated, name, shownHorizons));
  }

  lines.push('', '## Grenzen dieser Auswertung', '');
  lines.push('- Delistete Unternehmen fehlen (siehe oben); die Ergebnisse sind dadurch geschönt.');
  lines.push('- Tageskurse: Die Reihenfolge von Hoch und Tief innerhalb eines Tages ist unbekannt. Im Zweifel wurde gegen die Strategie gerechnet (Stop vor Ziel).');
  lines.push('- Dividenden sind weder bei den Aktien noch beim Index berücksichtigt.');
  lines.push('- Kosten sind pauschal angesetzt. Bei wenig gehandelten Titeln sind Spanne und Markteinfluss in der Praxis höher.');
  lines.push('- Signale aus derselben Marktphase sind nicht unabhängig; t-Werte wirken dadurch überzeugender, als sie sind.');
  lines.push('- Wer viele Merkmale durchprobiert, findet immer eine Gruppe, die zufällig gut aussieht. Ein Merkmal verdient erst Vertrauen, wenn es sich in einem zweiten, getrennten Zeitraum bestätigt.');
  return lines.join('\n');
}

function tradeRecord(item, params) {
  const { signal, result, labels } = item;
  const record = {
    accessionNo: signal.accessionNo,
    filedAt: signal.filedAt,
    ticker: signal.ticker,
    issuer: signal.issuerName,
    insider: signal.insiderName,
    shares: signal.purchase.shares,
    valueUsd: signal.purchase.value,
    insiderPrice: Number(result.insiderPrice.toFixed(4)),
    entryDate: result.entryDate,
    entryOpen: Number(result.entryOpen.toFixed(4)),
  };
  for (const horizon of params.horizons) {
    const outcome = result.horizons[horizon];
    record[`ret${horizon}`] = outcome ? Number(outcome.ret.toFixed(4)) : null;
    record[`excess${horizon}`] = outcome && outcome.excess !== null ? Number(outcome.excess.toFixed(4)) : null;
  }
  for (const key of ['hold', 'marketBracket', 'limitBracket']) {
    const outcome = result.strategies[key];
    record[`${key}Filled`] = outcome.complete ? (outcome.filled ? 'ja' : 'nein') : 'offen';
    record[`${key}Ret`] = outcome.complete && outcome.filled ? Number(outcome.ret.toFixed(4)) : null;
    record[`${key}Exit`] = outcome.complete && outcome.filled ? outcome.exitReason : null;
  }
  return { ...record, ...labels };
}

/**
 * Backtest über historische Insiderkäufe. `deps` liefert die Clients für
 * sec-api.io und Kursdaten (in Tests durch Attrappen ersetzt).
 */
async function runBacktest(params, deps) {
  const log = deps.log || (() => {});
  const maxHorizon = Math.max(...params.horizons, params.maxHoldDays + params.limitValidDays);

  // Für die Erkennung von Routinekäufern werden auch die Jahre davor geladen.
  const dataStart = addDays(params.from, -Math.round(params.lookbackYears * 365.25));
  log(`Lade Insiderkäufe von ${dataStart} bis ${params.to} ...`);
  const universe = await deps.secApi.fetchPurchases(dataStart, params.to);
  const inPeriod = universe.filter((signal) => signal.filedAt.slice(0, 10) >= params.from);
  const candidates = inPeriod.filter((signal) => passesFilter(signal, { minValue: params.minValue, minShares: params.minShares }));
  log(`${count(universe.length)} Käufe geladen, ${count(candidates.length)} Signale im Zeitraum über dem Filter.`);

  const tickers = [...new Set(candidates.map((signal) => signal.ticker))];
  const priceFrom = addDays(params.from, -130);
  const priceTo = [addDays(params.to, Math.ceil(maxHorizon * 1.6) + 15), today()].sort()[0];
  log(`Lade Kurse für ${count(tickers.length)} Titel ...`);
  const prices = await loadPrices(deps.prices, tickers, params.benchmark, priceFrom, priceTo, log);

  const clusterOf = features.buildClusterIndex(universe, params.clusterDays);
  const routineOf = features.buildRoutineIndex(universe, dataStart);

  const evaluated = [];
  const excluded = {};
  for (const signal of candidates) {
    const result = evaluateSignal(signal, prices.byTicker.get(signal.ticker), prices.benchmarkByDate, params);
    if (result.status !== 'ok') {
      excluded[result.status] = (excluded[result.status] || 0) + 1;
      continue;
    }
    evaluated.push({
      signal,
      result,
      labels: {
        role: features.roleClass(signal),
        value: features.valueBucket(signal),
        holdings: features.holdingsBucket(signal),
        cluster: clusterOf(signal),
        routine: routineOf(signal),
        liquidity: features.liquidityBucket(result.dollarVolume),
        runup: features.runupBucket(result.runup),
      },
    });
  }

  const report = buildReport({ params, universe: inPeriod.length, candidates: candidates.length, evaluated, excluded });
  const trades = evaluated.map((item) => tradeRecord(item, params));

  if (params.outDir) {
    fs.mkdirSync(params.outDir, { recursive: true });
    fs.writeFileSync(path.join(params.outDir, 'report.md'), `${report}\n`);
    if (trades.length) fs.writeFileSync(path.join(params.outDir, 'trades.csv'), toCsv(Object.keys(trades[0]), trades));
  }
  return { report, trades, evaluated, excluded };
}

module.exports = { runBacktest, loadPrices, mapLimit };
