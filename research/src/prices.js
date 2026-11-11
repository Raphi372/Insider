'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DAY = 86400;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toUnix = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const today = () => new Date().toISOString().slice(0, 10);

/** Die SEC schreibt Aktienklassen mit Punkt (BRK.B), Yahoo mit Bindestrich (BRK-B). */
const yahooSymbol = (ticker) => String(ticker).toUpperCase().replace(/\./g, '-');

/**
 * Wandelt die Antwort der Yahoo-Chart-API in Tageskerzen um.
 * Yahoo liefert Kurse splitbereinigt, aber nicht dividendenbereinigt –
 * Dividenden bleiben in allen Auswertungen unberücksichtigt.
 */
function parseChart(json) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !Array.isArray(result.timestamp)) return { bars: [], splits: [] };

  const offset = (result.meta && result.meta.gmtoffset) || 0;
  const localDate = (timestamp) => new Date((timestamp + offset) * 1000).toISOString().slice(0, 10);
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

  const bars = [];
  result.timestamp.forEach((timestamp, i) => {
    const bar = {
      date: localDate(timestamp),
      open: quote.open && quote.open[i],
      high: quote.high && quote.high[i],
      low: quote.low && quote.low[i],
      close: quote.close && quote.close[i],
      volume: (quote.volume && quote.volume[i]) || 0,
    };
    // Handelsfreie Tage und Lücken liefert Yahoo als null.
    if ([bar.open, bar.high, bar.low, bar.close].every((v) => Number.isFinite(v) && v > 0)) bars.push(bar);
  });

  const splits = Object.values((result.events && result.events.splits) || {})
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ date: localDate(s.date), numerator: s.numerator, denominator: s.denominator }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { bars, splits };
}

/**
 * Faktor, mit dem ein am `date` gemeldeter Preis multipliziert werden muss,
 * um zu den splitbereinigten Yahoo-Kursen zu passen (4:1-Split danach -> 0,25).
 */
function splitFactorAfter(splits, date) {
  return (splits || [])
    .filter((s) => s.date > date)
    .reduce((factor, s) => factor * (s.denominator / s.numerator), 1);
}

/** Lädt Tageskurse von Yahoo Finance und hält sie in einem Datei-Cache. */
class PriceClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
    this.cookieUrl = options.cookieUrl || 'https://fc.yahoo.com';
    this.cacheDir = options.cacheDir || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || defaultSleep;
    this.log = options.log || (() => {});
    this.pauseMs = options.pauseMs === undefined ? 200 : options.pauseMs;
    this.auth = null;
    if (this.cacheDir) fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  cacheFile(symbol) {
    return path.join(this.cacheDir, `${symbol.replace(/[^A-Z0-9^=-]/g, '_')}.json`);
  }

  readCache(symbol, from, to) {
    if (!this.cacheDir) return null;
    try {
      const cached = JSON.parse(fs.readFileSync(this.cacheFile(symbol), 'utf8'));
      // Reicht der Cache bis zum gewünschten Enddatum – oder wurde er heute geholt
      // (neuere Kurse gibt es dann noch nicht) –, ist kein Abruf nötig.
      const fresh = cached.to >= to || cached.fetchedOn === today();
      return cached.from <= from && fresh ? cached : null;
    } catch (err) {
      return null;
    }
  }

  /** Yahoo verlangt für manche Abrufe Cookie und Crumb; besorgt wird beides erst bei Bedarf. */
  async authenticate() {
    const headers = { 'user-agent': USER_AGENT };
    const cookieResponse = await this.fetchImpl(this.cookieUrl, { headers, signal: AbortSignal.timeout(15000) });
    const setCookie = typeof cookieResponse.headers.getSetCookie === 'function'
      ? cookieResponse.headers.getSetCookie()
      : [cookieResponse.headers.get('set-cookie')].filter(Boolean);
    const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    await cookieResponse.arrayBuffer().catch(() => undefined);

    const crumbResponse = await this.fetchImpl(`${this.baseUrl}/v1/test/getcrumb`, {
      headers: { ...headers, cookie }, signal: AbortSignal.timeout(15000),
    });
    if (!crumbResponse.ok) throw new Error(`Yahoo-Crumb nicht erhalten (HTTP ${crumbResponse.status})`);
    this.auth = { cookie, crumb: (await crumbResponse.text()).trim() };
  }

  /**
   * Tageskerzen für `ticker` im Zeitraum [from, to] (ISO-Daten).
   * Liefert `null`, wenn Yahoo den Titel nicht (mehr) kennt – etwa nach einem Delisting.
   */
  async getBars(ticker, from, to) {
    const symbol = yahooSymbol(ticker);
    const cached = this.readCache(symbol, from, to);
    if (cached) return cached.missing ? null : { bars: cached.bars, splits: cached.splits };

    let data = null;
    let missing = false;

    for (let attempt = 1; ; attempt += 1) {
      const params = new URLSearchParams({
        period1: String(toUnix(from)),
        period2: String(toUnix(to) + DAY),
        interval: '1d',
        events: 'div,splits',
      });
      const headers = { 'user-agent': USER_AGENT };
      if (this.auth) {
        params.set('crumb', this.auth.crumb);
        headers.cookie = this.auth.cookie;
      }

      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`, {
          headers, signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        if (attempt >= 4) throw new Error(`Kursabruf für ${symbol} fehlgeschlagen: ${err.message}`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }

      if (response.ok) {
        data = parseChart(await response.json());
        break;
      }
      await response.arrayBuffer().catch(() => undefined);

      if (response.status === 404 || response.status === 400) {
        missing = true; // unbekanntes Symbol
        break;
      }
      if (attempt >= 4) throw new Error(`Kursabruf für ${symbol} fehlgeschlagen: HTTP ${response.status}`);
      if (response.status === 401 || response.status === 403) {
        await this.authenticate();
      } else {
        // 429 und 5xx: Yahoo drosselt – mit wachsendem Abstand erneut versuchen.
        await this.sleep(2000 * 2 ** attempt);
      }
    }

    if (this.pauseMs) await this.sleep(this.pauseMs);
    if (data && data.bars.length === 0) missing = true;

    if (this.cacheDir) {
      const entry = missing
        ? { symbol, from, to, fetchedOn: today(), missing: true }
        : { symbol, from, to, fetchedOn: today(), bars: data.bars, splits: data.splits };
      fs.writeFileSync(this.cacheFile(symbol), JSON.stringify(entry));
    }
    return missing ? null : data;
  }
}

module.exports = { PriceClient, parseChart, splitFactorAfter, yahooSymbol };
