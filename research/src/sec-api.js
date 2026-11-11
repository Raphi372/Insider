'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseForm4, isPurchase } = require('./form4');

const PAGE_SIZE = 50;
const MAX_OFFSET = 10000; // darüber liefert die Suche von sec-api.io keine Treffer mehr
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const today = () => new Date().toISOString().slice(0, 10);

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/** Zerlegt [from, to] in Monatsfenster: [["2024-01-15","2024-02-01"], ["2024-02-01","2024-03-01"], ...]. */
function monthWindows(from, to) {
  const windows = [];
  let start = from;
  while (start <= to) {
    const [year, month] = start.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    // Das Fensterende überlappt mit dem Beginn des nächsten Fensters. So geht
    // kein Filing verloren, egal ob sec-api die Obergrenze ein- oder ausschließt;
    // Dubletten werden über die Accession Number entfernt.
    const end = nextMonth <= to ? nextMonth : to;
    windows.push([start, end]);
    start = nextMonth;
  }
  return windows;
}

/** Nur die Felder, die Auswertung und Merkmale brauchen – hält den Cache klein. */
function compact(signal) {
  const { footnotes, link, transactionCodes, periodOfReport, ...rest } = signal;
  return rest;
}

/** Lädt historische Insiderkäufe (Form 4, Code P) über die Insider-Trading-API. */
class SecApiClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://api.sec-api.io').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.cacheDir = options.cacheDir || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || defaultSleep;
    this.log = options.log || (() => {});
    this.pauseMs = options.pauseMs === undefined ? 250 : options.pauseMs;
    this.maxOffset = options.maxOffset || MAX_OFFSET;
    this.requests = 0;
    if (this.cacheDir) fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async query(body) {
    for (let attempt = 1; ; attempt += 1) {
      let response;
      let failure;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/insider-trading?token=${encodeURIComponent(this.apiKey)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        this.requests += 1;
        if (response.ok) {
          const json = await response.json();
          if (this.pauseMs) await this.sleep(this.pauseMs);
          return json;
        }
        await response.arrayBuffer().catch(() => undefined);
        failure = `HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          throw Object.assign(new Error('sec-api.io lehnt den API-Key ab (SEC_API_KEY prüfen)'), { fatal: true });
        }
      } catch (err) {
        if (err.fatal) throw err;
        failure = failure || err.message;
      }
      if (attempt >= 5) throw new Error(`sec-api.io nicht erreichbar: ${failure}`);
      // 429: Limit überschritten – sec-api sperrt dann kurzzeitig, also deutlich warten.
      await this.sleep((response && response.status === 429 ? 15000 : 2000) * attempt);
    }
  }

  /** Alle Käufe mit filedAt in [from, to]; teilt das Fenster, wenn es zu viele Treffer hat. */
  async fetchWindow(from, to) {
    const query = `documentType:4 AND nonDerivativeTable.transactions.coding.code:P AND filedAt:[${from} TO ${to}]`;
    const signals = [];

    for (let offset = 0; ; offset += PAGE_SIZE) {
      if (offset >= this.maxOffset) {
        if (daysBetween(from, to) < 1) {
          this.log(`Warnung: mehr als ${this.maxOffset} Käufe am ${from} – der Rest fehlt.`);
          break;
        }
        const middle = addDays(from, Math.floor(daysBetween(from, to) / 2));
        return [...await this.fetchWindow(from, middle), ...await this.fetchWindow(middle, to)];
      }
      const page = await this.query({ query, from: offset, size: PAGE_SIZE, sort: [{ filedAt: { order: 'asc' } }] });
      const filings = page.transactions || [];
      for (const filing of filings) {
        const signal = parseForm4(filing);
        if (isPurchase(signal) && signal.filedAt) signals.push(compact(signal));
      }
      if (filings.length < PAGE_SIZE) break;
    }
    return signals;
  }

  /**
   * Alle Insiderkäufe im Zeitraum, ohne Dubletten und nach Meldezeit sortiert.
   * Abgeschlossene Monatsfenster werden auf der Platte zwischengespeichert.
   */
  async fetchPurchases(from, to) {
    const byAccession = new Map();

    for (const [start, end] of monthWindows(from, to)) {
      const cacheFile = this.cacheDir && path.join(this.cacheDir, `${start}_${end}.json`);
      let signals;
      if (cacheFile && fs.existsSync(cacheFile)) {
        signals = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      } else {
        signals = await this.fetchWindow(start, end);
        // Ein Fenster, das bis heute reicht, kann noch wachsen – nicht speichern.
        if (cacheFile && end < today()) fs.writeFileSync(cacheFile, JSON.stringify(signals));
        this.log(`  ${start} bis ${end}: ${signals.length} Käufe geladen`);
      }
      for (const signal of signals) {
        const day = signal.filedAt.slice(0, 10);
        if (day >= from && day <= to) byAccession.set(signal.accessionNo, signal);
      }
    }
    return [...byAccession.values()].sort((a, b) => a.filedAt.localeCompare(b.filedAt));
  }
}

module.exports = { SecApiClient, monthWindows, addDays, daysBetween };
