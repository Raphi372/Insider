'use strict';

// Merkmale, nach denen die Auswertung Signale gruppiert. Jede Funktion liefert
// eine Beschriftung; die Reihenfolge in ORDER bestimmt die Zeilen der Tabellen.

const DAY_MS = 86400000;

function roleClass(signal) {
  if (signal.isOfficer) {
    // "Vice President" zählt nicht zur obersten Führungsebene.
    return /chief executive|\bceo\b|chief financial|\bcfo\b|(?<!vice[\s-])\bpresident\b/i.test(signal.role)
      ? 'CEO/CFO/President' : 'Anderer Officer';
  }
  if (signal.isDirector) return 'Director';
  if (signal.isTenPercentOwner) return '10%-Eigner';
  return 'Sonstige';
}

function valueBucket(signal) {
  const value = signal.purchase.value;
  if (value < 50000) return 'unter 50.000 $';
  if (value < 250000) return '50.000–250.000 $';
  if (value < 1000000) return '250.000–1 Mio. $';
  return 'über 1 Mio. $';
}

function holdingsBucket(signal) {
  const pct = signal.purchase.holdingsIncreasePct;
  if (pct === null || pct === undefined) return 'Erstkauf';
  if (pct < 5) return 'Bestand +0–5 %';
  if (pct < 25) return 'Bestand +5–25 %';
  return 'Bestand über +25 %';
}

function liquidityBucket(dollarVolume) {
  if (dollarVolume === null || dollarVolume === undefined) return 'unbekannt';
  if (dollarVolume < 1e6) return 'Tagesumsatz unter 1 Mio. $';
  if (dollarVolume < 1e7) return 'Tagesumsatz 1–10 Mio. $';
  return 'Tagesumsatz über 10 Mio. $';
}

function runupBucket(runup) {
  if (runup === null || runup === undefined) return 'unbekannt';
  if (runup < -0.2) return 'Kurs zuvor unter −20 %';
  if (runup < 0) return 'Kurs zuvor −20 bis 0 %';
  return 'Kurs zuvor nicht gefallen';
}

/**
 * Cluster-Kauf: Mindestens ein weiterer Insider desselben Unternehmens hat in
 * den `windowDays` Tagen bis zu diesem Filing ebenfalls gekauft.
 * `universe` sind alle bekannten Käufe (auch kleine).
 */
function buildClusterIndex(universe, windowDays = 14) {
  const byIssuer = new Map();
  for (const signal of universe) {
    if (!byIssuer.has(signal.issuerCik)) byIssuer.set(signal.issuerCik, []);
    byIssuer.get(signal.issuerCik).push({ insider: signal.insiderCik, time: Date.parse(signal.filedAt) });
  }
  return (signal) => {
    const time = Date.parse(signal.filedAt);
    const others = new Set();
    for (const other of byIssuer.get(signal.issuerCik) || []) {
      if (other.insider !== signal.insiderCik && other.time <= time && time - other.time <= windowDays * DAY_MS) {
        others.add(other.insider);
      }
    }
    return others.size > 0 ? 'Cluster (mehrere Insider)' : 'Einzelkauf';
  };
}

/**
 * Routinekäufer nach Cohen/Malloy/Pomorski (2012), vereinfacht auf Käufe:
 * Wer in den drei Vorjahren jeweils im selben Kalendermonat gekauft hat,
 * kauft nach Plan und nicht aus Überzeugung. Reicht die Datengrundlage keine
 * drei Jahre zurück, bleibt die Einordnung offen.
 */
function buildRoutineIndex(universe, dataStart) {
  const months = new Map();
  for (const signal of universe) {
    const key = `${signal.issuerCik}|${signal.insiderCik}`;
    if (!months.has(key)) months.set(key, new Set());
    months.get(key).add(signal.filedAt.slice(0, 7));
  }
  return (signal) => {
    const year = Number(signal.filedAt.slice(0, 4));
    const month = signal.filedAt.slice(5, 7);
    if (`${year - 3}-${month}` < dataStart.slice(0, 7)) return 'unbekannt (Historie zu kurz)';
    const seen = months.get(`${signal.issuerCik}|${signal.insiderCik}`) || new Set();
    const routine = [1, 2, 3].every((back) => seen.has(`${year - back}-${month}`));
    return routine ? 'Routinekäufer' : 'Gelegenheitskäufer';
  };
}

const ORDER = [
  'CEO/CFO/President', 'Anderer Officer', 'Director', '10%-Eigner', 'Sonstige',
  'unter 50.000 $', '50.000–250.000 $', '250.000–1 Mio. $', 'über 1 Mio. $',
  'Erstkauf', 'Bestand +0–5 %', 'Bestand +5–25 %', 'Bestand über +25 %',
  'Cluster (mehrere Insider)', 'Einzelkauf',
  'Gelegenheitskäufer', 'Routinekäufer', 'unbekannt (Historie zu kurz)',
  'Tagesumsatz unter 1 Mio. $', 'Tagesumsatz 1–10 Mio. $', 'Tagesumsatz über 10 Mio. $',
  'Kurs zuvor unter −20 %', 'Kurs zuvor −20 bis 0 %', 'Kurs zuvor nicht gefallen',
  'STARK', 'MITTEL', 'SCHWACH', 'ohne Einstufung',
  'Order gesendet', 'Order abgelehnt', 'verworfen', 'keine Reaktion', 'kein Order-Vorschlag',
  'unbekannt',
];

/** Sortiert Gruppenbeschriftungen in fachlicher statt alphabetischer Reihenfolge. */
function sortLabels(labels) {
  const rank = (label) => (ORDER.includes(label) ? ORDER.indexOf(label) : ORDER.length);
  return [...labels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

module.exports = {
  roleClass, valueBucket, holdingsBucket, liquidityBucket, runupBucket,
  buildClusterIndex, buildRoutineIndex, sortLabels,
};
