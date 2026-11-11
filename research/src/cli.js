'use strict';

// Kommandozeile des Research-Pakets:
//   journal   – nimmt Signale und Ereignisse der Pipeline entgegen (Dauerdienst)
//   report    – wertet das Signal-Protokoll aus
//   backtest  – prüft die Regeln an historischen Insiderkäufen

const path = require('node:path');
const { createJournal, createServer } = require('./journal');
const { PriceClient } = require('./prices');
const { SecApiClient, addDays } = require('./sec-api');
const { runBacktest } = require('./backtest');
const { runReport } = require('./report');

const HELP = `Aufruf: <befehl> [Optionen]

  journal                 Protokoll-Dienst starten (läuft als Docker-Dienst "journal")
  report                  Signal-Protokoll auswerten -> data/signals-report.{md,csv}
  backtest                Regeln an historischen Insiderkäufen prüfen -> data/backtest/

Optionen für backtest (Standard in Klammern):
  --from JJJJ-MM-TT       erstes Filing-Datum (zwei Jahre vor --to)
  --to JJJJ-MM-TT         letztes Filing-Datum (heute)
  --min-shares N          Mindeststückzahl (MIN_SHARES, 1000)
  --stop-loss P           Stop-Loss in Prozent (STOP_LOSS_PCT, 8)
  --take-profit P         Take-Profit in Prozent (TAKE_PROFIT_PCT, 15)
  --max-hold N            spätester Ausstieg nach N Handelstagen (60)
  --limit-days N          Gültigkeit der Limit-Order in Handelstagen (20)
  --cost-bps N            Kosten je Kauf und je Verkauf in Basispunkten (10)
  --horizons A,B,...      Haltedauern in Handelstagen (5,20,60,120)
  --lookback-years N      Vorlauf zur Erkennung von Routinekäufern (3; 0 schaltet ab)
  --cluster-days N        Zeitfenster für Cluster-Käufe in Tagen (14)
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

/** Baut die Parameter für Backtest und Auswertung aus Optionen und Umgebung. */
function buildParams(options, env, command) {
  const known = ['from', 'to', 'min-shares', 'stop-loss', 'take-profit', 'max-hold', 'limit-days', 'cost-bps', 'horizons', 'lookback-years', 'cluster-days', 'benchmark'];
  for (const name of Object.keys(options)) {
    if (!known.includes(name)) throw new Error(`Unbekannte Option --${name}`);
  }
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
    minShares: number(options['min-shares'], number(env.MIN_SHARES, 1000, 'MIN_SHARES'), '--min-shares'),
    stopLossPct: number(options['stop-loss'], number(env.STOP_LOSS_PCT, 8, 'STOP_LOSS_PCT'), '--stop-loss'),
    takeProfitPct: number(options['take-profit'], number(env.TAKE_PROFIT_PCT, 15, 'TAKE_PROFIT_PCT'), '--take-profit'),
    maxHoldDays: number(options['max-hold'], 60, '--max-hold'),
    limitValidDays: number(options['limit-days'], 20, '--limit-days'),
    costBps: number(options['cost-bps'], 10, '--cost-bps'),
    lookbackYears: number(options['lookback-years'], 3, '--lookback-years'),
    clusterDays: number(options['cluster-days'], 14, '--cluster-days'),
    benchmark: options.benchmark || env.BENCHMARK || 'SPY',
    horizons,
    dataDir,
    outDir: command === 'backtest' ? path.join(dataDir, 'backtest') : dataDir,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = argv;
  const log = (message) => console.error(message);

  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }

  if (command === 'journal') {
    const journal = createJournal(env.DATA_DIR || path.join(process.cwd(), 'data'));
    journal.assertWritable();
    const port = Number(env.JOURNAL_PORT || 8090);
    const server = createServer(journal, (message) => console.log(`${new Date().toISOString()} ${message}`));
    server.listen(port, () => console.log(`Signal-Protokoll lauscht auf Port ${port}, Daten in ${journal.dataDir}`));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
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

  if (!env.SEC_API_KEY) throw new Error('SEC_API_KEY fehlt (siehe .env)');
  const secApi = new SecApiClient({
    baseUrl: env.SEC_API_BASE_URL,
    apiKey: env.SEC_API_KEY,
    cacheDir: path.join(params.dataDir, 'cache', 'form4'),
    log,
  });
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

module.exports = { main, parseArgs, buildParams };
