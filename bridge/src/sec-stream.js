'use strict';

const WebSocket = require('ws');

const MAX_SEEN = 10000;

/**
 * Hält eine dauerhafte WebSocket-Verbindung zum sec-api.io-Stream und ruft
 * `onFiling` für jedes neue Filing der gewünschten Formulartypen genau einmal auf.
 *
 * n8n selbst hat keinen WebSocket-Trigger; diese Klasse ersetzt ihn.
 */
class SecStream {
  constructor(options) {
    const {
      url,
      apiKey,
      formTypes = ['4'],
      onFiling,
      log,
      pingIntervalMs = 30000,
      pongTimeoutMs = 10000,
      minBackoffMs = 1000,
      maxBackoffMs = 60000,
    } = options;

    this.url = url;
    this.apiKey = apiKey;
    this.formTypes = new Set(formTypes);
    this.onFiling = onFiling;
    this.log = log;
    this.pingIntervalMs = pingIntervalMs;
    this.pongTimeoutMs = pongTimeoutMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;

    this.ws = null;
    this.stopped = false;
    this.backoffMs = minBackoffMs;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.seen = new Map();
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this._stopHeartbeat();
    if (this.ws) this.ws.terminate();
  }

  _connect() {
    if (this.stopped) return;

    // Der API-Key steht in der URL – deshalb wird die URL nie geloggt.
    const ws = new WebSocket(`${this.url}?apiKey=${encodeURIComponent(this.apiKey)}`);
    this.ws = ws;

    ws.on('open', () => {
      this.log.info(`sec-api-Stream verbunden (${this.url}), Filter: Form ${[...this.formTypes].join(', ')}`);
      this.backoffMs = this.minBackoffMs;
      this._startHeartbeat(ws);
    });

    ws.on('message', (raw) => this._handleMessage(raw));

    ws.on('pong', () => clearTimeout(this.pongTimer));

    // Der Server hat den WebSocket-Handshake mit einem HTTP-Status abgelehnt.
    ws.on('unexpected-response', (_request, response) => {
      const hint = response.statusCode === 401 || response.statusCode === 403
        ? ' – SEC_API_KEY prüfen und ob der Tarif die Stream-API enthält'
        : '';
      this.log.error(`sec-api-Stream hat die Verbindung abgelehnt (HTTP ${response.statusCode})${hint}`);
      // Bei abgelehnten Zugangsdaten bringt schnelles Wiederholen nichts.
      this.backoffMs = this.maxBackoffMs;
      ws.terminate();
    });

    ws.on('error', (err) => {
      this.log.warn(`sec-api-Stream Fehler: ${err.message}`);
    });

    ws.on('close', (code) => {
      this._stopHeartbeat();
      if (this.stopped) return;
      const jitter = Math.floor(Math.random() * 250);
      const delay = this.backoffMs + jitter;
      this.log.warn(`sec-api-Stream getrennt (Code ${code}) – neuer Verbindungsversuch in ${delay} ms`);
      this.reconnectTimer = setTimeout(() => this._connect(), delay);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    });
  }

  /**
   * Erkennt hängende Verbindungen: Bleibt die Antwort auf einen Ping aus,
   * wird die Verbindung beendet und über den `close`-Handler neu aufgebaut.
   */
  _startHeartbeat(ws) {
    this._stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.log.warn('sec-api-Stream antwortet nicht auf Ping – Verbindung wird neu aufgebaut');
        ws.terminate();
      }, this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  _stopHeartbeat() {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  _handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      this.log.warn(`Nicht lesbare Stream-Nachricht verworfen: ${err.message}`);
      return;
    }

    // sec-api sendet pro Nachricht ein Array von Filings.
    const filings = Array.isArray(data) ? data : [data];

    for (const filing of filings) {
      if (!filing || typeof filing !== 'object') continue;
      if (!this.formTypes.has(filing.formType)) continue;
      if (this._alreadySeen(filing)) continue;

      Promise.resolve()
        .then(() => this.onFiling(filing))
        .catch((err) => this.log.error(`Verarbeitung von ${filing.accessionNo || filing.id} fehlgeschlagen: ${err.message}`));
    }
  }

  /**
   * Ein Form 4 hängt bei EDGAR sowohl am Emittenten als auch am Insider und
   * kann deshalb mehrfach im Stream auftauchen. Dedupliziert wird über die
   * Accession Number.
   */
  _alreadySeen(filing) {
    const key = filing.accessionNo || filing.id;
    if (!key) return false;
    if (this.seen.has(key)) return true;

    this.seen.set(key, Date.now());
    if (this.seen.size > MAX_SEEN) {
      // Map behält die Einfügereihenfolge – der erste Schlüssel ist der älteste.
      this.seen.delete(this.seen.keys().next().value);
    }
    return false;
  }
}

module.exports = { SecStream };
