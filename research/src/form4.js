'use strict';

// Dieselbe Logik wie der Node "Parse_Form4" im n8n-Workflow: Dessen Code wird
// aus dieser Datei übernommen, und ein Test (test/unit/workflow.test.js)
// vergleicht beide, damit Live-Pipeline, Datenbank und Backtest dieselben
// Signale sehen.

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Verdichtet ein Dokument der sec-api Insider-Trading-API zu einem Signal. */
function parseForm4(doc = {}) {
  const transactions = (doc.nonDerivativeTable || {}).transactions || [];
  const amount = (t) => num(t.amounts && t.amounts.shares);
  const price = (t) => num(t.amounts && t.amounts.pricePerShare);
  const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

  // Fasst die Zeilen einer Richtung zusammen. direction: +1 für Käufe, -1 für Verkäufe.
  const aggregate = (rows, direction) => {
    const shares = rows.reduce((sum, t) => sum + amount(t), 0);
    const value = rows.reduce((sum, t) => sum + amount(t) * price(t), 0);

    // Direkt und indirekt gehaltene Aktien (z. B. über einen Trust) weist das
    // Formular getrennt aus – deshalb je Halteform rechnen. Die letzte Zeile
    // einer Halteform enthält den Endbestand.
    const groups = {};
    for (const t of rows) {
      const nature = t.ownershipNature || {};
      const key = `${nature.directOrIndirectOwnership || ''}|${nature.natureOfOwnership || ''}`;
      const group = groups[key] || (groups[key] = { moved: 0, after: 0 });
      group.moved += amount(t);
      group.after = num(t.postTransactionAmounts && t.postTransactionAmounts.sharesOwnedFollowingTransaction);
    }
    const after = Object.values(groups).reduce((sum, g) => sum + g.after, 0);
    const before = Object.values(groups).reduce(
      (sum, g) => sum + (direction > 0 ? Math.max(g.after - g.moved, 0) : g.after + g.moved), 0);
    const dates = rows.map((t) => t.transactionDate).filter(Boolean).sort();

    return {
      lots: rows.length,
      shares,
      value: round(value, 2),
      avgPrice: shares > 0 ? round(value / shares, 4) : 0,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
      sharesOwnedBefore: before,
      sharesOwnedAfter: after,
      changePct: before > 0 ? round((shares / before) * 100, 1) : null,
    };
  };

  // Offenmarktkäufe: Tabelle I, Transaction Code "P", Erwerb ("A").
  // Offenmarktverkäufe: Code "S", Veräußerung ("D").
  const code = (t) => (t.coding && t.coding.code) || null;
  const direction = (t) => (t.amounts && t.amounts.acquiredDisposedCode) || null;
  const bought = aggregate(transactions.filter((t) => code(t) === 'P' && direction(t) !== 'D'), 1);
  const sold = aggregate(transactions.filter((t) => code(t) === 'S' && direction(t) !== 'A'), -1);
  const { changePct: holdingsIncreasePct, ...purchase } = bought;
  const { changePct: holdingsDecreasePct, ...sale } = sold;

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

  // Hinweis auf einen vorab festgelegten Handelsplan (Rule 10b5-1) in Fußnoten oder Anmerkungen.
  const notes = (doc.footnotes || []).map((f) => String(f.text || '')).concat(String(doc.remarks || '')).join(' ');
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
    purchase: { ...purchase, holdingsIncreasePct },
    sale: { ...sale, holdingsDecreasePct },
    mentions10b51: /10b5-?1/i.test(notes),
    // Alle Transaktionscodes des Filings, z. B. ["P"] oder ["M", "S"].
    transactionCodes: [...new Set(transactions.map(code).filter(Boolean))],
    // Jede Aktien-Transaktion der Tabelle I für die Datenbank – auch Zuteilungen,
    // Optionsausübungen und Schenkungen. Sehr lange Meldungen enden nach 100 Zeilen.
    transactions: transactions.slice(0, 100).map((t) => ({
      date: t.transactionDate || null,
      code: code(t),
      shares: amount(t),
      price: price(t),
      acquiredDisposed: direction(t),
      sharesOwnedAfter: num(t.postTransactionAmounts && t.postTransactionAmounts.sharesOwnedFollowingTransaction),
      ownership: (t.ownershipNature && t.ownershipNature.directOrIndirectOwnership) || null,
      securityTitle: String(t.securityTitle || '').slice(0, 80),
    })),
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

/**
 * Der Kauf-Filter des Workflows: Kaufwert ab `minValue` US-Dollar.
 * `minShares` ist ein optionaler zweiter Schwellenwert (mehr als so viele Aktien).
 */
function passesFilter(signal, { minValue = 0, minShares = 0 } = {}) {
  return isPurchase(signal) && signal.purchase.value >= minValue && signal.purchase.shares > minShares;
}

module.exports = { parseForm4, isPurchase, passesFilter };
