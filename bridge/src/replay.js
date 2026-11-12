'use strict';

// Testlauf ohne Warten auf den Stream: schickt ein bereits veröffentlichtes
// Form 4 durch die Pipeline – mit echten Daten und echten API-Aufrufen.
//
//   docker compose exec bridge node src/replay.js                  # jüngsten passenden Insiderkauf suchen
//   docker compose exec bridge node src/replay.js 0001234567-26-000123
//
// Ohne Argument sucht das Skript über die Insider-Trading-API das neueste
// Form 4, das den Kauf-Filter des Workflows passieren würde.

const log = require('./log');
const { loadConfig } = require('./config');
const { postJson } = require('./forwarder');

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Wählt aus Antworten der Insider-Trading-API das erste Filing, das der
 * Workflow als Signal melden würde: Offenmarktkauf (Code P) im Wert von
 * mindestens `minValue` Dollar, Preis > 0 und einem Ticker.
 */
function pickReplayCandidate(filings, minValue) {
  for (const filing of filings || []) {
    const ticker = String((filing.issuer || {}).tradingSymbol || '').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) || ['NONE', 'NA', 'N.A'].includes(ticker)) continue;

    const purchases = (((filing.nonDerivativeTable || {}).transactions) || []).filter(
      (t) => (t.coding || {}).code === 'P' && (t.amounts || {}).acquiredDisposedCode !== 'D');
    const shares = purchases.reduce((sum, t) => sum + num((t.amounts || {}).shares), 0);
    const value = purchases.reduce((sum, t) => sum + num((t.amounts || {}).shares) * num((t.amounts || {}).pricePerShare), 0);

    if (shares > 0 && value > 0 && value >= minValue) return filing;
  }
  return null;
}

async function findLatestPurchase(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.secApiBaseUrl}/insider-trading?token=${encodeURIComponent(config.secApiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'documentType:4 AND nonDerivativeTable.transactions.coding.code:P',
      from: 0,
      size: 50,
      sort: [{ filedAt: { order: 'desc' } }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`sec-api.io antwortet mit HTTP ${response.status} – SEC_API_KEY prüfen`);
  const data = await response.json();
  return pickReplayCandidate(data.transactions, config.minPurchaseValueUsd);
}

async function main() {
  const config = loadConfig();
  let accessionNo = process.argv[2];
  let label = accessionNo;

  if (!accessionNo) {
    const filing = await findLatestPurchase(config);
    if (!filing) throw new Error('Unter den letzten 50 Insiderkäufen passt keiner zum Filter – MIN_PURCHASE_VALUE_USD senken oder eine Accession Number angeben');
    accessionNo = filing.accessionNo;
    label = `${accessionNo} (${filing.issuer.tradingSymbol}, ${filing.reportingOwner && filing.reportingOwner.name}, gemeldet ${filing.filedAt})`;
  }
  if (!/^\d{10}-\d{2}-\d{6}$/.test(accessionNo)) {
    throw new Error(`"${accessionNo}" ist keine Accession Number (Format 0001234567-26-000123)`);
  }

  log.info(`Sende Form 4 ${label} an n8n ...`);
  const result = await postJson(`${config.n8nWebhookBaseUrl}/sec-filing`, { formType: '4', accessionNo, replay: true }, {
    headers: { 'x-bridge-token': config.bridgeSecret },
    attempts: 2,
    log,
  });
  if (!result.ok) {
    const hint = result.status === 404 ? ' – ist der Workflow in n8n veröffentlicht?' : '';
    throw new Error(`n8n hat das Filing nicht angenommen: ${result.error}${hint}`);
  }
  log.info('Übergeben. Die Telegram-Nachricht sollte in wenigen Sekunden eintreffen; Details unter http://localhost:5678 -> Executions.');
}

if (require.main === module) {
  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}

module.exports = { pickReplayCandidate, findLatestPurchase };
