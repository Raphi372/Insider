'use strict';

// Dieselbe Logik wie der Node "Parse_Form4" im n8n-Workflow. Ein Test
// (test/unit/workflow.test.js) vergleicht beide, damit Live-Pipeline und
// Backtest dieselben Signale sehen.

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Verdichtet ein Dokument der sec-api Insider-Trading-API zu einem Signal. */
function parseForm4(doc = {}) {
  const transactions = (doc.nonDerivativeTable || {}).transactions || [];

  // Offenmarktkäufe: Tabelle I, Transaction Code "P", Erwerb ("A").
  const purchases = transactions.filter((t) =>
    t.coding && t.coding.code === 'P' && (!t.amounts || t.amounts.acquiredDisposedCode !== 'D'));

  const shares = purchases.reduce((sum, t) => sum + num(t.amounts && t.amounts.shares), 0);
  const value = purchases.reduce(
    (sum, t) => sum + num(t.amounts && t.amounts.shares) * num(t.amounts && t.amounts.pricePerShare), 0);
  const avgPrice = shares > 0 ? value / shares : 0;

  // Direkt und indirekt gehaltene Aktien weist das Formular getrennt aus.
  const groups = {};
  for (const t of purchases) {
    const nature = t.ownershipNature || {};
    const key = `${nature.directOrIndirectOwnership || ''}|${nature.natureOfOwnership || ''}`;
    const group = groups[key] || (groups[key] = { bought: 0, after: 0 });
    group.bought += num(t.amounts && t.amounts.shares);
    group.after = num(t.postTransactionAmounts && t.postTransactionAmounts.sharesOwnedFollowingTransaction);
  }
  const sharesOwnedAfter = Object.values(groups).reduce((sum, g) => sum + g.after, 0);
  const sharesOwnedBefore = Object.values(groups).reduce((sum, g) => sum + Math.max(g.after - g.bought, 0), 0);
  const holdingsIncreasePct = sharesOwnedBefore > 0 ? (shares / sharesOwnedBefore) * 100 : null;

  const owner = doc.reportingOwner || {};
  const relationship = owner.relationship || {};
  const roles = [];
  if (relationship.isOfficer) roles.push(relationship.officerTitle ? `Officer (${relationship.officerTitle})` : 'Officer');
  if (relationship.isDirector) roles.push('Director');
  if (relationship.isTenPercentOwner) roles.push('10%-Eigner');
  if (relationship.isOther) roles.push(relationship.otherText ? `Sonstige (${relationship.otherText})` : 'Sonstige');

  const issuer = doc.issuer || {};
  const ticker = String(issuer.tradingSymbol || '').trim().toUpperCase();
  const tickerValid = /^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker) && !['NONE', 'NA', 'N.A'].includes(ticker);

  const dates = purchases.map((t) => t.transactionDate).filter(Boolean).sort();
  const accessionNo = doc.accessionNo || '';

  return {
    accessionNo,
    filedAt: doc.filedAt || null,
    periodOfReport: doc.periodOfReport || null,
    ticker,
    tickerValid,
    issuerName: issuer.name || '',
    issuerCik: String(issuer.cik || ''),
    insiderName: owner.name || '',
    insiderCik: String(owner.cik || ''),
    role: roles.join(', ') || 'unbekannt',
    isOfficer: Boolean(relationship.isOfficer),
    isDirector: Boolean(relationship.isDirector),
    isTenPercentOwner: Boolean(relationship.isTenPercentOwner),
    purchase: {
      lots: purchases.length,
      shares,
      value: Math.round(value * 100) / 100,
      avgPrice: Math.round(avgPrice * 10000) / 10000,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      sharesOwnedBefore,
      sharesOwnedAfter,
      holdingsIncreasePct: holdingsIncreasePct === null ? null : Math.round(holdingsIncreasePct * 10) / 10,
    },
    transactionCodes: [...new Set(transactions.map((t) => t.coding && t.coding.code).filter(Boolean))],
    footnotes: (doc.footnotes || []).slice(0, 6).map((f) => String(f.text || '').slice(0, 400)),
    link: accessionNo && issuer.cik
      ? `https://www.sec.gov/Archives/edgar/data/${issuer.cik}/${accessionNo.replace(/-/g, '')}/${accessionNo}-index.htm`
      : null,
  };
}

/** Ein Offenmarktkauf mit Preis und handelbarem Ticker – unabhängig von der Größe. */
function isPurchase(signal) {
  return signal.purchase.lots > 0 && signal.purchase.avgPrice > 0 && signal.tickerValid;
}

/** Der Kauf-Filter des Workflows: zusätzlich mehr als `minShares` Aktien. */
function passesFilter(signal, minShares) {
  return isPurchase(signal) && signal.purchase.shares > minShares;
}

module.exports = { parseForm4, isPurchase, passesFilter };
