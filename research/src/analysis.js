'use strict';

const { summarize } = require('./stats');
const { pct, share, fixed, table } = require('./render');
const { sortLabels } = require('./features');

// Alle Funktionen erwarten ausgewertete Signale: [{ signal, result, labels }]
// mit result.status === 'ok' (siehe evaluate.js).

/** Rendite und Überrendite je Haltedauer. */
function horizonTable(evaluated, horizons) {
  const rows = horizons.map((horizon) => {
    const outcomes = evaluated.map((e) => e.result.horizons[horizon]).filter((o) => o && o.excess !== null);
    const excess = summarize(outcomes.map((o) => o.excess));
    return [
      `${horizon} Handelstage`,
      String(excess.n),
      pct(summarize(outcomes.map((o) => o.ret)).mean),
      pct(summarize(outcomes.map((o) => o.bench)).mean),
      pct(excess.mean),
      pct(excess.median),
      share(excess.hitRate),
      fixed(excess.tStat),
    ];
  });
  return table(
    ['Haltedauer', 'n', 'Ø Rendite', 'Ø Index', 'Ø Überrendite', 'Median Überrendite', 'besser als Index', 't-Wert'],
    rows,
  );
}

/** Vergleich der drei Order-Regeln; Renditen nach Kosten. */
function strategyTable(evaluated, params) {
  const rules = [
    ['hold', `Kauf zur Eröffnung, ${params.maxHoldDays} Tage halten`],
    ['marketBracket', 'Kauf zur Eröffnung mit Stop-Loss/Take-Profit'],
    ['limitBracket', 'Limit zum Insiderpreis mit Stop-Loss/Take-Profit (Workflow)'],
  ];
  const rows = rules.map(([key, label]) => {
    const outcomes = evaluated.map((e) => e.result.strategies[key]).filter((o) => o.complete);
    const trades = outcomes.filter((o) => o.filled);
    const stats = summarize(trades.map((o) => o.ret));
    const reasons = ['stop', 'target', 'time'].map((reason) =>
      share(trades.length ? trades.filter((o) => o.exitReason === reason).length / trades.length : null));
    return [
      label,
      String(outcomes.length),
      share(outcomes.length ? trades.length / outcomes.length : null),
      pct(stats.mean),
      pct(stats.median),
      share(stats.hitRate),
      // Nicht ausgeführte Orders zählen mit 0 – das Geld lag dann ungenutzt.
      pct(outcomes.length ? trades.reduce((sum, o) => sum + o.ret, 0) / outcomes.length : null),
      fixed(summarize(trades.map((o) => o.holdDays)).mean, 0),
      reasons.join(' / '),
    ];
  });
  return table(
    ['Regel', 'Signale', 'ausgeführt', 'Ø je Trade', 'Median', 'Gewinner', 'Ø je Signal', 'Ø Haltetage', 'Stop / Ziel / Zeit'],
    rows,
  );
}

/**
 * Überrendite nach Gruppen eines Merkmals. `compact` lässt Trefferquote und
 * t-Wert weg – sinnvoll, solange erst wenige Signale vorliegen.
 */
function segmentTable(evaluated, labelName, horizons, { compact = false } = {}) {
  const groups = new Map();
  for (const item of evaluated) {
    const label = item.labels[labelName];
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const headers = ['Gruppe'];
  for (const horizon of horizons) {
    headers.push(`n (${horizon} T.)`, `Ø Überrendite ${horizon} T.`);
    if (!compact) headers.push(`Treffer ${horizon} T.`, `t-Wert ${horizon} T.`);
  }

  const rows = sortLabels([...groups.keys()]).map((label) => {
    const row = [label];
    for (const horizon of horizons) {
      const stats = summarize(groups.get(label)
        .map((item) => item.result.horizons[horizon])
        .filter((o) => o && o.excess !== null)
        .map((o) => o.excess));
      row.push(String(stats.n), pct(stats.mean));
      if (!compact) row.push(share(stats.hitRate), fixed(stats.tStat));
    }
    return row;
  });
  return table(headers, rows);
}

module.exports = { horizonTable, strategyTable, segmentTable };
