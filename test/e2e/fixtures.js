'use strict';

// Testdaten im Format der sec-api.io-Antworten (Insider-Trading-API, 13F-Holdings-API).

function transaction({ code, shares, price, after, date = '2026-11-09', acquired = 'A' }) {
  return {
    securityTitle: 'Common Stock',
    transactionDate: date,
    coding: { formType: '4', code, equitySwapInvolved: false },
    amounts: { shares, pricePerShare: price, acquiredDisposedCode: acquired },
    postTransactionAmounts: { sharesOwnedFollowingTransaction: after },
    ownershipNature: { directOrIndirectOwnership: 'D' },
  };
}

function form4({ accessionNo, ticker, issuerCik, insiderCik = '2000001', transactions, filedAt = '2026-11-10T16:31:02-05:00' }) {
  return {
    id: `id-${accessionNo}`,
    accessionNo,
    filedAt,
    schemaVersion: 'X0508',
    documentType: '4',
    periodOfReport: '2026-11-09',
    notSubjectToSection16: false,
    issuer: { cik: issuerCik, name: `${ticker} Corp <Test & Co>`, tradingSymbol: ticker },
    reportingOwner: {
      cik: insiderCik,
      name: 'Doe Jane',
      relationship: { isDirector: false, isOfficer: true, officerTitle: 'Chief Financial Officer', isTenPercentOwner: false, isOther: false },
    },
    nonDerivativeTable: { transactions },
    footnotes: [{ id: 'F1', text: 'Purchase in the open market.' }],
  };
}

// Zwei Lose: 3.000 @ 10,00 und 2.000 @ 10,50 -> 5.000 Aktien, 51.000 $, Ø 10,20 $.
const purchaseLots = () => [
  transaction({ code: 'P', shares: 3000, price: 10.0, after: 23000 }),
  transaction({ code: 'P', shares: 2000, price: 10.5, after: 25000 }),
];

const FILINGS = {
  // Standardfall: Kauf, alle Datenquellen verfügbar.
  '0001000000-26-000001': form4({ accessionNo: '0001000000-26-000001', ticker: 'ACME', issuerCik: '1000001', transactions: purchaseLots() }),
  // Verkauf -> wird vom Kauf-Filter verworfen.
  '0001000000-26-000002': form4({
    accessionNo: '0001000000-26-000002', ticker: 'SELL', issuerCik: '1000002',
    transactions: [transaction({ code: 'S', shares: 9000, price: 20, after: 1000, acquired: 'D' })],
  }),
  // Preis 0 (z. B. Schenkung als Kauf kodiert) -> verworfen.
  '0001000000-26-000003': form4({
    accessionNo: '0001000000-26-000003', ticker: 'ZERO', issuerCik: '1000003',
    transactions: [transaction({ code: 'P', shares: 8000, price: 0, after: 8000 })],
  }),
  // Zu kleine Stückzahl -> verworfen.
  '0001000000-26-000004': form4({
    accessionNo: '0001000000-26-000004', ticker: 'TINY', issuerCik: '1000004',
    transactions: [transaction({ code: 'P', shares: 500, price: 30, after: 900 })],
  }),
  // Wird erst beim zweiten Abruf gefunden (verzögerte Indexierung).
  '0001000000-26-000005': form4({ accessionNo: '0001000000-26-000005', ticker: 'LATE', issuerCik: '1000005', transactions: purchaseLots() }),
  // Kauf, während Yahoo und Anthropic ausfallen.
  '0001000000-26-000006': form4({ accessionNo: '0001000000-26-000006', ticker: 'DOWN', issuerCik: '1000006', transactions: purchaseLots() }),
  // Kauf, aber IBKR kennt keinen Kontrakt.
  '0001000000-26-000007': form4({ accessionNo: '0001000000-26-000007', ticker: 'NOIB', issuerCik: '1000007', transactions: purchaseLots() }),
  // Kauf für den Test "IBKR lehnt die Order ab".
  '0001000000-26-000008': form4({ accessionNo: '0001000000-26-000008', ticker: 'REJ', issuerCik: '1000008', transactions: purchaseLots() }),
};

// Dieses Filing lässt die sec-api im Mock mit HTTP 500 scheitern (Fehlerpfad).
const BROKEN_ACCESSION = '0001000000-26-000099';

/** Stream-Nachricht (Metadaten), wie sie sec-api.io über den WebSocket sendet. */
function streamFiling(accessionNo, formType = '4') {
  const doc = FILINGS[accessionNo];
  return {
    id: `stream-${accessionNo}`,
    accessionNo,
    cik: doc ? doc.issuer.cik : '9999999',
    ticker: doc ? doc.issuer.tradingSymbol : 'XXXX',
    companyName: doc ? doc.issuer.name : 'Unknown Corp',
    formType,
    description: `Form ${formType}`,
    filedAt: '2026-11-10T16:31:02-05:00',
    linkToFilingDetails: `https://www.sec.gov/Archives/edgar/data/1/${accessionNo}.xml`,
  };
}

/** Frühere Meldungen desselben Insiders: ein Kauf zu 8,00 $ und ein Verkauf. */
function history(issuerCik) {
  const current = Object.values(FILINGS).find((f) => f.issuer.cik === issuerCik);
  const ticker = current ? current.issuer.tradingSymbol : 'XXXX';
  return [
    ...(current ? [current] : []),
    form4({
      accessionNo: `0001000000-25-9${issuerCik.slice(-5)}`, ticker, issuerCik, filedAt: '2025-05-02T17:00:00-04:00',
      transactions: [transaction({ code: 'P', shares: 4000, price: 8.0, after: 24000, date: '2025-05-01' })],
    }),
    form4({
      accessionNo: `0001000000-24-9${issuerCik.slice(-5)}`, ticker, issuerCik, filedAt: '2024-03-12T17:00:00-04:00',
      transactions: [transaction({ code: 'S', shares: 4000, price: 9.0, after: 20000, date: '2024-03-11', acquired: 'D' })],
    }),
  ];
}

function holding(ticker, shares, value) {
  return {
    nameOfIssuer: `${ticker} CORP`, cusip: '000000000', titleOfClass: 'COM', value,
    shrsOrPrnAmt: { sshPrnamt: shares, sshPrnamtType: 'SH' }, ticker, cik: '1',
  };
}

/** 13F-Filings enthalten das ganze Portfolio – der Workflow muss die passende Position heraussuchen. */
function institutionalHoldings(ticker) {
  return [
    {
      accessionNo: '0009000000-26-000001', cik: '9000001', companyName: 'Alpha Capital', formType: '13F-HR',
      filedAt: '2026-02-14T10:00:00-05:00', periodOfReport: '2025-12-31',
      holdings: [holding('OTHER', 5, 5), holding(ticker, 120000, 1440000), holding('MISC', 7, 7)],
    },
    {
      accessionNo: '0009000000-26-000002', cik: '9000002', companyName: 'Beta Partners', formType: '13F-HR',
      filedAt: '2026-02-10T10:00:00-05:00', periodOfReport: '2025-12-31',
      holdings: [holding(ticker, 30000, 360000)],
    },
  ];
}

function quoteSummary(symbol) {
  const value = (raw) => ({ raw, fmt: String(raw) });
  return {
    quoteSummary: {
      result: [{
        price: { symbol, regularMarketPrice: value(12.0), marketCap: value(1500000000), currency: 'USD' },
        summaryDetail: { trailingPE: value(18.4), forwardPE: value(15.1), fiftyTwoWeekLow: value(7.5), fiftyTwoWeekHigh: value(14.2) },
        defaultKeyStatistics: { shortPercentOfFloat: value(0.075), shortRatio: value(3.2), heldPercentInstitutions: value(0.61) },
      }],
      error: null,
    },
  };
}

const LLM_VERDICT = {
  signal: 'STARK',
  begruendung: 'Die CFO stockt ihren Bestand um ein Viertel auf <ohne> Verkaufsdruck.',
  pro: ['Kauf durch operative Führungskraft', 'Bestand +25 %'],
  contra: ['Kurs liegt bereits über dem Insiderpreis'],
  datenluecken: [],
};

module.exports = { FILINGS, BROKEN_ACCESSION, streamFiling, history, institutionalHoldings, quoteSummary, LLM_VERDICT };
