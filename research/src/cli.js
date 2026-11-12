'use strict';

// Kommandozeile des Research-Pakets:
//   journal   – nimmt Meldungen, Signale und Ereignisse der Pipeline entgegen (Dauerdienst)
//   stats     – zeigt, was in der Datenbank steht
//   backfill  – füllt die Datenbank mit den Insiderkäufen der letzten Tage
//   report    – wertet das Signal-Protokoll aus
//   backtest  – prüft die Regeln an historischen Insiderkäufen

const path = require('node:path');
const { createJournal, createServer } = require('./journal');
const { openDatabase } = require('./db');
const { PriceClient } = require('./prices');
const { SecApiClient, addDays } = require('./sec-api');
const { runBacktest } = require('./backtest');
const { runBackfill } = require('./backfill');
const { runReport } = require('./report');

const HELP = `Aufruf: <befehl> [Optionen]

  journal                 Protokoll-Dienst starten (läuft als Docker-Dienst "journal")
  stats                   Stand der Datenbank anzeigen
  backfill [--days N]     Insiderkäufe der letzten N Tage (30) in die Datenbank laden;
                          mit --to JJJJ-MM-TT endet der Zeitraum an diesem Tag statt heute
  report                  Signal-Protokoll auswerten -> data/signals-report.{md,csv}
  backtest                Regeln an historischen Insiderkäufen prüfen -> data/backtest/

Optionen für backtest (Standard in Klammern):
  --from JJJJ-MM-TT       erstes Filing-Datum (zwei Jahre vor --to)
  --to JJJJ-MM-TT         letztes Filing-Datum (heute)
  --min-value N           Mindest-Kaufwert in US-Dollar (MIN_PURCHASE_VALUE_USD, 25000)
  --min-shares N          zusätzlich: mehr als N Aktien (0)
  --stop-loss P           Stop-Loss in Prozent (STOP_LOSS_PCT, 8)
  --take-profit P         Take-Profit in Prozent (TAKE_PROFIT_PCT, 15)
  --max-hold N            spätester Ausstieg nach N Handelstagen (60)
  --limit-days N          Gültigkeit der Limit-Order in Handelstagen (20)
  --cost-bps N            Kosten je Kauf und je Verkauf in Basispunkten (10)
  --horizons A,B,...      Haltedauern in Handelstagen (5,20,60,120)
  --lookback-years N      Vorlauf zur Erkennung von Routinekäufern (3; 0 schaltet ab)
  --cluster-days N        Zeitfenster für Cluster-Käufe in Tagen (CLUSTER_DAYS, 14)
  --benchmark SYMBOL      Vergleichsindex (SPY)`;

/** "--max-hold 60 --from=2024-01-01" -> { 'max-hold': '60', from: '2024-01-01' } */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unbekanntes Argument: ${arg}`);
    const [name, inline] = arg.slice(2).split('=');
    options[name] = inline !== undefined ? inline : argv[i += 1];
    if (options[name] === undefined) throw new Error(`Wert für --${name} fehlt`);
  }
  return options;
}

function number(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Ungültiger Wert für ${name}: ${value}`);
  return parsed;
}

function date(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`Ungültiges Datum für ${name}: ${value} (erwartet JJJJ-MM-TT)`);
  return value;
}

const days = (n) => `${n} ${n === 1 ? 'Tag' : 'Tage'}`;

function assertKnown(options, known) {
  for (const name of Object.keys(options)) {
    if (!known.includes(name)) throw new Error(`Unbekannte Option --${name}`);
  }
}

/** Baut die Parameter für Backtest und Auswertung aus Optionen und Umgebung. */
function buildParams(options, env, command) {
  assertKnown(options, ['from', 'to', 'min-value', 'min-shares', 'stop-loss', 'take-profit', 'max-hold', 'limit-days', 'cost-bps', 'horizons', 'lookback-years', 'cluster-days', 'benchmark']);
  const today = new Date().toISOString().slice(0, 10);
  const to = date(options.to, today, '--to');
  const from = date(options.from, addDays(to, -730), '--from');
  if (from > to) throw new Error('--from liegt nach --to');

  const defaultHorizons = command === 'report' ? '5,20,60' : '5,20,60,120';
  const horizons = String(options.horizons || defaultHorizons).split(',').map((h) => number(h, null, '--horizons'));
  if (horizons.some((h) => !Number.isInteger(h) || h < 1)) throw new Error('--horizons erwartet ganze Zahlen ab 1, z. B. 5,20,60');

  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');
  return {
    from,
    to,
    minValue: number(options['min-value'], number(env.MIN_PURCHASE_VALUE_USD, 25000, 'MIN_PURCHASE_VALUE_USD'), '--min-value'),
    minShares: number(options['min-shares'], 0, '--min-shares'),
    stopLossPct: number(options['stop-loss'], number(env.STOP_LOSS_PCT, 8, 'STOP_LOSS_PCT'), '--stop-loss'),
    takeProfitPct: number(options['take-profit'], number(env.TAKE_PROFIT_PCT, 15, 'TAKE_PROFIT_PCT'), '--take-profit'),
    maxHoldDays: number(options['max-hold'], 60, '--max-hold'),
    limitValidDays: number(options['limit-days'], 20, '--limit-days'),
    costBps: number(options['cost-bps'], 10, '--cost-bps'),
    lookbackYears: number(options['lookback-years'], 3, '--lookback-years'),
    clusterDays: number(options['cluster-days'], number(env.CLUSTER_DAYS, 14, 'CLUSTER_DAYS'), '--cluster-days'),
    benchmark: options.benchmark || env.BENCHMARK || 'SPY',
    horizons,
    dataDir,
    outDir: command === 'backtest' ? path.join(dataDir, 'backtest') : dataDir,
  };
}

const SELL_ALERT_SCOPES = ['orders', 'signals', 'off'];

/** Einstellungen des Protokoll-Dienstes aus der Umgebung. */
function journalContext(env, warn = () => {}) {
  // 'orders': nur warnen, wenn du die Order gesendet hattest; 'signals': bei
  // jedem gemeldeten Kauf; 'off': nie.
  const wanted = String(env.SELL_ALERT_SCOPE || 'orders').trim().toLowerCase();
  const known = SELL_ALERT_SCOPES.includes(wanted);
  if (!known) warn(`SELL_ALERT_SCOPE="${env.SELL_ALERT_SCOPE}" ist unbekannt (erlaubt: ${SELL_ALERT_SCOPES.join(', ')}) – es gilt "orders".`);
  return {
    clusterDays: number(env.CLUSTER_DAYS, 14, 'CLUSTER_DAYS'),
    sellAlert: {
      scope: known ? wanted : 'orders',
      lookbackDays: number(env.SELL_ALERT_LOOKBACK_DAYS, 365, 'SELL_ALERT_LOOKBACK_DAYS'),
    },
  };
}

function secApiClient(env, dataDir, log) {
  if (!env.SEC_API_KEY) throw new Error('SEC_API_KEY fehlt (siehe .env)');
  return new SecApiClient({
    baseUrl: env.SEC_API_BASE_URL,
    apiKey: env.SEC_API_KEY,
    cacheDir: path.join(dataDir, 'cache', 'form4'),
    log,
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const log = (message) => console.error(message);
  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');
  const journalUrl = (env.JOURNAL_URL || 'http://journal:8090').replace(/\/+$/, '');

  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }

  if (command === 'journal') {
    const journal = createJournal(dataDir);
    journal.assertWritable();
    const db = openDatabase(path.join(dataDir, 'insider.db'));
    const port = Number(env.JOURNAL_PORT || 8090);
    const context = { db, ...journalContext(env, (message) => console.log(`Hinweis: ${message}`)) };
    const server = createServer(journal, (message) => console.log(`${new Date().toISOString()} ${message}`), context);
    server.listen(port, () => {
      const { filings, historyDays } = db.stats();
      console.log(`Protokoll-Dienst lauscht auf Port ${port}, Daten in ${dataDir} (${filings} Meldungen in der Datenbank, ${days(historyDays)} zurück; `
        + `Cluster-Fenster ${days(context.clusterDays)}, Verkaufswarnung "${context.sellAlert.scope}")`);
    });
    process.on('SIGTERM', () => server.close(() => {
      db.close();
      process.exit(0);
    }));
    return;
  }

  if (command === 'stats') {
    assertKnown(parseArgs(rest), []);
    let stats;
    try {
      const response = await fetch(`${journalUrl}/stats`, { signal: AbortSignal.timeout(15000) });
      stats = await response.json();
      if (!response.ok) throw new Error(stats.error || `HTTP ${response.status}`);
    } catch (err) {
      throw new Error(`Protokoll-Dienst unter ${journalUrl} nicht erreichbar (${err.message}). Läuft "docker compose up -d"?`);
    }
    const count = (n) => Number(n).toLocaleString('de-DE');
    const rows = [
      ['Meldungen (Form 4):', count(stats.filings)],
      ['  mit Käufen (Code P):', count(stats.withPurchases)],
      ['  mit Verkäufen (Code S):', count(stats.withSales)],
      ['Transaktionen:', count(stats.transactions)],
      ['Zeitraum:', stats.filings > 0 ? `${stats.firstFiledDate} bis ${stats.lastFiledDate} (${days(stats.historyDays)} zurück)` : 'noch leer'],
      ['Herkunft:', `${count(stats.fromStream)} aus dem Stream, ${count(stats.fromBackfill)} nachgeladen`],
    ];
    console.log(rows.map(([label, value]) => `${label.padEnd(26)}${value}`).join('\n'));
    return;
  }

  if (command === 'backfill') {
    const options = parseArgs(rest);
    assertKnown(options, ['days', 'to']);
    const days = number(options.days, 30, '--days');
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days erwartet eine ganze Zahl von 1 bis 365');
    const secApi = secApiClient(env, dataDir, log);
    const result = await runBackfill({ days, to: date(options.to, undefined, '--to'), journalUrl }, { secApi, log });
    console.log(`${result.found} Insiderkäufe von ${result.from} bis ${result.to} geladen, davon ${result.added} neu in der Datenbank`
      + `${result.failed ? `, ${result.failed} abgelehnt` : ''} (${secApi.requests} Abrufe bei sec-api.io).`);
    return;
  }

  if (command !== 'report' && command !== 'backtest') throw new Error(`Unbekannter Befehl: ${command}\n\n${HELP}`);

  const params = buildParams(parseArgs(rest), env, command);
  const prices = new PriceClient({
    baseUrl: env.YAHOO_BASE_URL,
    cookieUrl: env.YAHOO_COOKIE_URL,
    cacheDir: path.join(params.dataDir, 'cache', 'prices'),
    log,
  });

  if (command === 'report') {
    const { report } = await runReport(params, { journal: createJournal(params.dataDir), prices, log });
    console.log(report);
    return;
  }

  const secApi = secApiClient(env, params.dataDir, log);
  const { report } = await runBacktest(params, { secApi, prices, log });
  console.log(report);
  log(`\nGespeichert: ${path.join(params.outDir, 'report.md')} und trades.csv (${secApi.requests} Abrufe bei sec-api.io)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Fehler: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, buildParams, journalContext };
