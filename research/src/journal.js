'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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
  const read = (file) => {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch (err) { return []; } // beschädigte Zeile überspringen
    });
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
    readEvents: () => read(files.events),
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

/** HTTP-Schnittstelle, über die der n8n-Workflow Signale und Ereignisse ablegt. */
function createServer(journal, log = () => {}) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const route = `${req.method} ${req.url.split('?')[0]}`;

    try {
      if (route === 'GET /healthz') return send(200, { status: 'ok' });
      if (route === 'GET /signals') return send(200, journal.readSignals());
      if (route === 'GET /events') return send(200, journal.readEvents());

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
