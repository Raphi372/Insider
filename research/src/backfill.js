'use strict';

const { addDays } = require('./sec-api');

/**
 * Füllt die Datenbank mit den Insiderkäufen der letzten Tage, damit die
 * Cluster-Erkennung nicht erst nach zwei Wochen Laufzeit greift.
 *
 * Geladen werden nur Käufe (Code P) – mehr braucht die Cluster-Erkennung nicht.
 * Geschrieben wird über den Protokoll-Dienst, damit nur ein Prozess die
 * Datenbankdatei öffnet.
 */
async function runBackfill({ days, to = new Date().toISOString().slice(0, 10), journalUrl }, deps) {
  const log = deps.log || (() => {});
  const fetchImpl = deps.fetchImpl || fetch;
  const from = addDays(to, -days);

  log(`Lade Insiderkäufe von ${from} bis ${to} ...`);
  const signals = await deps.secApi.fetchPurchases(from, to, { full: true });

  const result = { from, to, found: signals.length, stored: 0, added: 0, failed: 0 };
  for (const signal of signals) {
    let response;
    try {
      response = await fetchImpl(`${journalUrl}/filings?source=backfill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signal),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new Error(`Protokoll-Dienst unter ${journalUrl} nicht erreichbar (${err.message}). Läuft "docker compose up -d"?`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      result.failed += 1;
      continue;
    }
    if (body.stored) result.stored += 1;
    if (body.isNew) result.added += 1;
  }
  return result;
}

module.exports = { runBackfill };
