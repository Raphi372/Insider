'use strict';

// Lokale Datenbank aller Insider-Meldungen (SQLite, Datei data/insider.db).
// Gespeichert wird jedes Form 4, das die Pipeline sieht – nicht nur die Käufe,
// die als Signal gemeldet werden. Darauf bauen die Cluster-Erkennung und die
// Verkaufswarnung auf. Die Datei lässt sich mit jedem SQLite-Programm öffnen.

const { DatabaseSync } = require('node:sqlite');

const DAY_MS = 86400000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS filings (
    accession_no           TEXT PRIMARY KEY,
    filed_at               TEXT NOT NULL,     -- Meldezeit wie geliefert, z. B. 2026-03-09T19:00:14-04:00
    filed_at_ms            INTEGER NOT NULL,  -- dieselbe Zeit als Unix-Millisekunden
    filed_date             TEXT NOT NULL,     -- Kalendertag der Meldung (US-Ostküste)
    ticker                 TEXT,
    issuer_cik             TEXT NOT NULL,
    issuer_name            TEXT,
    insider_cik            TEXT NOT NULL,
    insider_name           TEXT,
    role                   TEXT,
    is_officer             INTEGER NOT NULL DEFAULT 0,
    is_director            INTEGER NOT NULL DEFAULT 0,
    is_ten_percent_owner   INTEGER NOT NULL DEFAULT 0,
    purchase_shares        REAL NOT NULL DEFAULT 0,   -- Offenmarktkäufe (Code P) dieser Meldung
    purchase_value         REAL NOT NULL DEFAULT 0,
    purchase_avg_price     REAL NOT NULL DEFAULT 0,
    sale_shares            REAL NOT NULL DEFAULT 0,   -- Offenmarktverkäufe (Code S)
    sale_value             REAL NOT NULL DEFAULT 0,
    sale_avg_price         REAL NOT NULL DEFAULT 0,
    mentions_10b5_1        INTEGER NOT NULL DEFAULT 0,
    source                 TEXT NOT NULL,     -- 'stream' (laufende Pipeline) oder 'backfill'
    stored_at              TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    accession_no        TEXT NOT NULL REFERENCES filings(accession_no) ON DELETE CASCADE,
    line                INTEGER NOT NULL,
    transaction_date    TEXT,
    code                TEXT,               -- P Kauf, S Verkauf, A Zuteilung, M Optionsausübung, G Schenkung, F Steuereinbehalt ...
    shares              REAL,
    price               REAL,
    acquired_disposed   TEXT,               -- A erworben, D veräußert
    shares_owned_after  REAL,
    ownership           TEXT,               -- D direkt, I indirekt
    security_title      TEXT,
    PRIMARY KEY (accession_no, line)
  );
  CREATE INDEX IF NOT EXISTS idx_filings_issuer_time ON filings (issuer_cik, filed_at_ms);
  CREATE INDEX IF NOT EXISTS idx_filings_insider ON filings (insider_cik, issuer_cik, filed_at_ms);
  CREATE INDEX IF NOT EXISTS idx_transactions_code ON transactions (code, transaction_date);
`;

function openDatabase(file) {
  const db = new DatabaseSync(file);
  // Klassisches Journal statt WAL: Die Datei liegt in einem Docker-Bind-Mount,
  // und WAL braucht gemeinsam genutzten Speicher, der dort nicht überall funktioniert.
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const statements = {
    existing: db.prepare('SELECT source FROM filings WHERE accession_no = ?'),
    upsertFiling: db.prepare(`
      INSERT OR REPLACE INTO filings (
        accession_no, filed_at, filed_at_ms, filed_date, ticker, issuer_cik, issuer_name, insider_cik, insider_name, role,
        is_officer, is_director, is_ten_percent_owner, purchase_shares, purchase_value, purchase_avg_price,
        sale_shares, sale_value, sale_avg_price, mentions_10b5_1, source, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    deleteTransactions: db.prepare('DELETE FROM transactions WHERE accession_no = ?'),
    insertTransaction: db.prepare(`
      INSERT INTO transactions (
        accession_no, line, transaction_date, code, shares, price, acquired_disposed, shares_owned_after, ownership, security_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    cluster: db.prepare(`
      SELECT insider_cik, insider_name, role, filed_date, purchase_shares, purchase_value
      FROM filings
      WHERE issuer_cik = ? AND insider_cik <> ? AND purchase_value > 0 AND filed_at_ms <= ? AND filed_at_ms >= ?
      ORDER BY filed_at_ms DESC`),
    earliest: db.prepare('SELECT MIN(filed_at_ms) AS earliest FROM filings'),
    stats: db.prepare(`
      SELECT COUNT(*) AS filings,
             COALESCE(SUM(purchase_value > 0), 0) AS withPurchases,
             COALESCE(SUM(sale_shares > 0), 0) AS withSales,
             COALESCE(SUM(source = 'stream'), 0) AS fromStream,
             COALESCE(SUM(source = 'backfill'), 0) AS fromBackfill,
             MIN(filed_date) AS firstFiledDate,
             MAX(filed_date) AS lastFiledDate
      FROM filings`),
    transactionCount: db.prepare('SELECT COUNT(*) AS transactions FROM transactions'),
  };

  /**
   * Speichert ein ausgewertetes Form 4 (Ausgabe von parseForm4) samt allen
   * Transaktionen. Eine bereits bekannte Accession Number wird ersetzt.
   * @returns {{stored: boolean, isNew: boolean, reason?: string}}
   */
  function storeFiling(signal, source = 'stream') {
    const filedAtMs = Date.parse(signal && signal.filedAt);
    if (!signal || !signal.accessionNo || !signal.issuerCik || !signal.insiderCik || Number.isNaN(filedAtMs)) {
      return { stored: false, isNew: false, reason: 'accessionNo, filedAt, issuerCik und insiderCik sind erforderlich' };
    }
    const rows = Array.isArray(signal.transactions) ? signal.transactions : [];
    if (rows.length === 0) return { stored: false, isNew: false, reason: 'keine Aktien-Transaktionen' };

    const purchase = signal.purchase || {};
    const sale = signal.sale || {};
    const existing = statements.existing.get(signal.accessionNo);
    const isNew = !existing;
    // Woher die Meldung zuerst kam, bleibt stehen – auch wenn sie später erneut eintrifft.
    const origin = existing ? existing.source : source;

    db.exec('BEGIN');
    try {
      statements.upsertFiling.run(
        signal.accessionNo, signal.filedAt, filedAtMs, String(signal.filedAt).slice(0, 10),
        signal.ticker || null, String(signal.issuerCik), signal.issuerName || null,
        String(signal.insiderCik), signal.insiderName || null, signal.role || null,
        signal.isOfficer ? 1 : 0, signal.isDirector ? 1 : 0, signal.isTenPercentOwner ? 1 : 0,
        Number(purchase.shares) || 0, Number(purchase.value) || 0, Number(purchase.avgPrice) || 0,
        Number(sale.shares) || 0, Number(sale.value) || 0, Number(sale.avgPrice) || 0,
        signal.mentions10b51 ? 1 : 0, origin, new Date().toISOString(),
      );
      statements.deleteTransactions.run(signal.accessionNo);
      rows.forEach((row, line) => {
        statements.insertTransaction.run(
          signal.accessionNo, line, row.date || null, row.code || null,
          Number(row.shares) || 0, Number(row.price) || 0, row.acquiredDisposed || null,
          Number(row.sharesOwnedAfter) || 0, row.ownership || null, row.securityTitle || null,
        );
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { stored: true, isNew };
  }

  /** Wie viele Tage die gespeicherten Meldungen zurückreichen. */
  function historyDays(now = Date.now()) {
    const { earliest } = statements.earliest.get();
    return earliest === null ? 0 : Math.max(0, Math.floor((now - earliest) / DAY_MS));
  }

  /**
   * Cluster-Kauf: Haben andere Insider desselben Unternehmens in den `days`
   * Tagen bis zu dieser Meldung ebenfalls am Markt gekauft? Dieselbe Definition
   * wie im Backtest (features.buildClusterIndex) – ein Test hält beide gleich.
   *
   * Verbundene Meldepflichtige (etwa ein Fonds und sein Verwalter) melden
   * denselben Kauf mitunter in getrennten Formularen. Mit `purchase` (dem Kauf
   * dieser Meldung) werden solche Fälle gekennzeichnet: gleiche Stückzahl und
   * gleicher Kaufwert. Mitgezählt werden sie trotzdem – ob es dieselbe
   * Transaktion ist, lässt sich aus den Zahlen allein nicht sicher sagen.
   */
  function findCluster({ issuerCik, insiderCik, filedAt, days = 14, purchase = null }) {
    const time = Date.parse(filedAt);
    const rows = Number.isNaN(time)
      ? []
      : statements.cluster.all(String(issuerCik), String(insiderCik), time, time - days * DAY_MS);
    const insiders = new Set(rows.map((row) => row.insider_cik));
    const samePurchase = (row) => Boolean(purchase) && Number(purchase.shares) > 0
      && row.purchase_shares === Number(purchase.shares)
      && Math.abs(row.purchase_value - Number(purchase.value)) < 0.005;
    return {
      windowDays: days,
      // Wie weit die Datenbank vor dieser Meldung zurückreicht. Ist das kürzer
      // als das Zeitfenster, kann ein Cluster unentdeckt bleiben.
      historyDays: Number.isNaN(time) ? 0 : historyDays(time),
      otherInsiders: insiders.size,
      insidersWithSamePurchase: new Set(rows.filter(samePurchase).map((row) => row.insider_cik)).size,
      totalValue: Math.round(rows.reduce((sum, row) => sum + row.purchase_value, 0) * 100) / 100,
      purchases: rows.slice(0, 5).map((row) => ({
        insiderName: row.insider_name,
        role: row.role,
        filedDate: row.filed_date,
        shares: row.purchase_shares,
        value: row.purchase_value,
        sameAsThisPurchase: samePurchase(row),
      })),
    };
  }

  function stats() {
    return { ...statements.stats.get(), ...statements.transactionCount.get(), historyDays: historyDays() };
  }

  return { storeFiling, findCluster, historyDays, stats, close: () => db.close() };
}

module.exports = { openDatabase };
