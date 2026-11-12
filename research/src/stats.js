'use strict';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Stichproben-Standardabweichung. */
function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Kennzahlen einer Renditereihe. Der t-Wert (Mittelwert / Standardfehler) zeigt,
 * wie deutlich sich der Mittelwert von null abhebt; ab etwa 2 gilt das als
 * statistisch auffällig. Er setzt unabhängige Beobachtungen voraus – Signale
 * aus demselben Zeitraum sind das nicht, er ist also eher zu optimistisch.
 */
function summarize(values) {
  const xs = values.filter((x) => Number.isFinite(x));
  const sd = stdev(xs);
  return {
    n: xs.length,
    mean: mean(xs),
    median: median(xs),
    hitRate: xs.length ? xs.filter((x) => x > 0).length / xs.length : null,
    // Ohne Streuung (lauter gleiche Werte) wäre der t-Wert eine Division durch Rundungsreste.
    tStat: sd > 1e-9 ? mean(xs) / (sd / Math.sqrt(xs.length)) : null,
  };
}

module.exports = { mean, median, stdev, summarize };
