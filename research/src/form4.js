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

  // Vorab festgelegter Handelsplan (Rule 10b5-1): Seit April 2023 hat das Formular dafür ein
  // eigenes Kästchen (aff10b5One). Ältere Filings erwähnen den Plan, wenn überhaupt, in
  // Fußnoten oder Anmerkungen – deshalb zählt beides.
  const tradingPlan10b51Affirmed = doc.aff10b5One === true;
  const notes = (doc.footnotes || []).map((f) => String(f.text || '')).concat(String(doc.remarks || '')).join(' ');
  const accessionNo = doc.accessionNo || '';

  // Fußnoten und Anmerkungen gehen vollständig an die KI. Eine Obergrenze bleibt,
  // damit ein ausuferndes Filing die Anfrage nicht sprengt; greift sie, steht
  // das im Text, statt still abzuschneiden.
  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const cut = (text, max) => (text.length > max ? `${text.slice(0, Math.max(0, max - 12)).trimEnd()} […gekürzt]` : text);
  const footnotes = [];
  let budget = 12000;
  for (const f of doc.footnotes || []) {
    const text = clean(f && f.text);
    if (!text) continue;
    if (budget <= 0) {
      footnotes.push('[weitere Fußnoten gekürzt]');
      break;
    }
    const entry = `${f.id ? `${clean(f.id)}: ` : ''}${text}`;
    footnotes.push(cut(entry, budget));
    budget -= entry.length;
  }

  // Tabelle II: Derivate wie Warrants, Optionen oder Wandelpapiere. Bei einer
  // Privatplatzierung stehen hier die mitgekauften Warrants samt Ausübungspreis.
  const scalar = (value) => (value && typeof value === 'object' && 'value' in value ? value.value : value);
  const numOrNull = (value) => {
    const raw = scalar(value);
    return raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
  };
  const day = (value) => {
    const raw = String(scalar(value) || '');
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  };
  const derivatives = ((doc.derivativeTable || {}).transactions || []).slice(0, 20).map((t) => ({
    title: clean(t.securityTitle).slice(0, 120),
    date: day(t.transactionDate),
    code: code(t),
    acquiredDisposed: direction(t),
    amount: num(t.amounts && t.amounts.shares),
    price: numOrNull(t.amounts && t.amounts.pricePerShare),
    exercisePrice: numOrNull(t.conversionOrExercisePrice),
    exerciseDate: day(t.exerciseDate),
    expirationDate: day(t.expirationDate),
    underlyingTitle: clean((t.underlyingSecurity || {}).title).slice(0, 80) || null,
    underlyingShares: numOrNull((t.underlyingSecurity || {}).shares),
    ownership: (t.ownershipNature && t.ownershipNature.directOrIndirectOwnership) || null,
  }));

  // Kauf aus einer Kapitalmaßnahme statt vom offenen Markt? Code "P" deckt beides
  // ab. Hinweise liefern die Fußnoten und mitgekaufte Warrants oder Wandelpapiere.
  const placementPatterns = [
    [/securities purchase agreement/i, 'Securities Purchase Agreement'],
    [/subscription agreement/i, 'Subscription Agreement'],
    [/private placement|private offering|\bPIPE\b/i, 'Privatplatzierung'],
    [/registered direct/i, 'Registered Direct Offering'],
    [/public offering price|underwritten (public )?offering|\b(in|through) (the|an|a|its) (underwritten |registered |public )*offering\b/i, 'Angebot des Unternehmens'],
    [/\beach unit\b|\bunits?,? (each )?(consisting|consists|comprised|composed) of/i, 'Units'],
    [/pre-?funded warrants?/i, 'Pre-funded Warrants'],
    [/(purchased|acquired) (directly )?from the (company|issuer)/i, 'Kauf direkt vom Unternehmen'],
  ];
  const placementReasons = placementPatterns.filter(([pattern]) => pattern.test(notes)).map(([, reason]) => reason);
  const financingRows = derivatives.filter((d) => d.acquiredDisposed !== 'D');
  if (financingRows.some((d) => /warrant/i.test(d.title))) placementReasons.push('Warrants erworben (Tabelle II)');
  if (financingRows.some((d) => /convertible|debenture|\bnotes?\b|preferred/i.test(d.title))) placementReasons.push('Wandelpapiere erworben (Tabelle II)');

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
    mentions10b51: tradingPlan10b51Affirmed || /10b5-?1/i.test(notes),
    // Nur das Kästchen, ohne Textsuche – damit Auswertungen beide Quellen unterscheiden können.
    tradingPlan10b51Affirmed,
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
    footnotes,
    remarks: cut(clean(doc.remarks), 2000) || null,
    derivatives,
    placement: { detected: placementReasons.length > 0, reasons: placementReasons },
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
