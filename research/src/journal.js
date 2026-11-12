'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { buildSellAlert } = require('./alerts');

/**
 * Das Signal-Protokoll: zwei Dateien, in die nur angehängt wird.
 *   signals.jsonl – jedes gemeldete Signal mit allen Kennzahlen und der Einstufung
 *   events.jsonl  – was danach geschah (Order gesendet, verworfen, abgelehnt)
 * Eine Zeile ist ein JSON-Objekt; die Dateien lassen sich mit jedem Editor lesen.
 */
function createJournal(dataDir) {
  const files = { signals: path.join(dataDir, 'signals.jsonl'), events: path.join(dataDir, 'events.jsonl') };

  const append = (file, entry) => {
    const record = { loggedAt: new Date().toISOString(), ...entry };
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    return record;
  };
  // Der Protokoll-Dienst liest die Dateien bei jedem gemeldeten Insiderverkauf
  // (Verkaufswarnung). Neu eingelesen wird nur, wenn sich eine Datei geändert hat.
  const cache = new Map();
  const read = (file) => {
    let stat;
    try { stat = fs.statSync(file); } catch (err) { return []; }
    const cached = cache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.entries;
    const entries = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch (err) { return []; } // beschädigte Zeile überspringen
    });
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
    return entries;
  };

  return {
    dataDir,
    /** Prüft beim Start, ob das Verzeichnis beschreibbar ist – sonst fiele es erst beim ersten Signal auf. */
    assertWritable() {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.accessSync(dataDir, fs.constants.W_OK);
      } catch (err) {
        throw new Error(
          `Das Verzeichnis ${dataDir} ist nicht beschreibbar (${err.code}). `
          + 'Unter Linux hilft: sudo chown -R 1000:1000 data');
      }
    },
    appendSignal: (entry) => append(files.signals, entry),
    appendEvent: (entry) => append(files.events, entry),
    /** Jedes Filing einmal; bei Wiederholungen (z. B. Testläufe mit replay.js) gilt der letzte Eintrag. */
    readSignals() {
      const byAccession = new Map();
      for (const entry of read(files.signals)) byAccession.set(entry.accessionNo, entry);
      return [...byAccession.values()];
    },
    readEvents: () => [...read(files.events)],
  };
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limitBytes) reject(Object.assign(new Error('Anfrage zu groß'), { status: 413 }));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch (err) { reject(Object.assign(new Error('Kein gültiges JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * HTTP-Schnittstelle, über die der n8n-Workflow Meldungen, Signale und
 * Ereignisse ablegt.
 *
 * `context.db` ist die Datenbank aller Insider-Meldungen (db.js). Ohne sie
 * arbeitet der Dienst nur als Signal-Protokoll.
 */
function createServer(journal, log = () => {}, context = {}) {
  const { db = null, clusterDays = 14, sellAlert = {} } = context;

  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://journal');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /healthz') return send(200, { status: 'ok' });
      if (route === 'GET /signals') return send(200, journal.readSignals());
      if (route === 'GET /events') return send(200, journal.readEvents());

      if (route === 'GET /stats') {
        if (!db) return send(503, { error: 'Datenbank nicht verfügbar' });
        return send(200, db.stats());
      }

      // Jedes Form 4, das die Pipeline sieht. Die Antwort sagt dem Workflow,
      // ob andere Insider ebenfalls gekauft haben (cluster) und ob ein Insider
      // verkauft, dessen Kauf gemeldet wurde (sellAlert).
      if (route === 'POST /filings') {
        if (!db) return send(503, { error: 'Datenbank nicht verfügbar' });
        const signal = await readBody(req);
        const source = url.searchParams.get('source') === 'backfill' ? 'backfill' : 'stream';
        const result = db.storeFiling(signal, source);
        if (!result.stored) {
          const empty = result.reason === 'keine Aktien-Transaktionen';
          return send(empty ? 200 : 400, { ...result, cluster: null, sellAlert: null });
        }

        const cluster = signal.purchase && signal.purchase.lots > 0
          ? db.findCluster({ issuerCik: signal.issuerCik, insiderCik: signal.insiderCik, filedAt: signal.filedAt, days: clusterDays, purchase: signal.purchase })
          : null;
        // Nur beim ersten Eintreffen warnen – ein Testlauf mit replay.js soll keine zweite Warnung auslösen.
        const alert = result.isNew && source === 'stream' ? buildSellAlert(signal, journal, sellAlert) : null;
        if (alert) {
          // Im Protokoll festhalten, dass gewarnt wurde – so lässt sich später
          // auswerten, was nach solchen Verkäufen geschah.
          journal.appendEvent({
            action: 'sell-alert',
            ticker: alert.ticker,
            accessionNo: alert.accessionNo,
            insiderName: alert.insiderName,
            saleShares: alert.sale.shares,
            saleValue: alert.sale.value,
            followedAccessionNo: alert.followed.accessionNo,
            orderSent: alert.followed.orderSent,
          });
          log(`Verkaufswarnung: ${signal.insiderName} verkauft ${signal.ticker} (${signal.accessionNo})`);
        }
        return send(201, { ...result, cluster, sellAlert: alert });
      }

      if (route === 'POST /signals') {
        const entry = await readBody(req);
        if (!entry || !entry.accessionNo || !entry.form4) return send(400, { error: 'accessionNo und form4 sind erforderlich' });
        journal.appendSignal(entry);
        log(`Signal protokolliert: ${entry.form4.ticker} ${entry.accessionNo} (${entry.rating || 'ohne Einstufung'})`);
        return send(201, { ok: true });
      }
      if (route === 'POST /events') {
        const entry = await readBody(req);
        if (!entry || !entry.action) return send(400, { error: 'action ist erforderlich' });
        journal.appendEvent(entry);
        log(`Ereignis protokolliert: ${entry.action} ${entry.ticker || ''}`.trim());
        return send(201, { ok: true });
      }
      return send(404, { error: 'nicht gefunden' });
    } catch (err) {
      log(`Fehler bei ${route}: ${err.message}`);
      return send(err.status || 500, { error: err.message });
    }
  });
}

module.exports = { createJournal, createServer };
