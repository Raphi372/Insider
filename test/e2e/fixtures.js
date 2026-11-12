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

const CFO = { isDirector: false, isOfficer: true, officerTitle: 'Chief Financial Officer', isTenPercentOwner: false, isOther: false };

function form4({
  accessionNo, ticker, issuerCik, insiderCik = '2000001', insiderName = 'Doe Jane', relationship = CFO, transactions,
  filedAt = '2026-11-10T16:31:02-05:00', footnotes = [{ id: 'F1', text: 'Purchase in the open market.' }],
}) {
  return {
    id: `id-${accessionNo}`,
    accessionNo,
    filedAt,
    schemaVersion: 'X0508',
    documentType: '4',
    periodOfReport: '2026-11-09',
    notSubjectToSection16: false,
    issuer: { cik: issuerCik, name: `${ticker} Corp <Test & Co>`, tradingSymbol: ticker },
    reportingOwner: { cik: insiderCik, name: insiderName, relationship },
    nonDerivativeTable: { transactions },
    footnotes,
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
  // Zu kleiner Kaufwert (500 × 30 $ = 15.000 $) -> verworfen.
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
  // Kauf für die Tests "IBKR lehnt die Order ab" und "Datenbank fällt aus".
  '0001000000-26-000008': form4({ accessionNo: '0001000000-26-000008', ticker: 'REJ', issuerCik: '1000008', transactions: purchaseLots() }),
  // Ein zweiter Insider kauft ACME am Tag darauf -> Cluster mit dem Standardfall.
  '0001000000-26-000009': form4({
    accessionNo: '0001000000-26-000009', ticker: 'ACME', issuerCik: '1000001', filedAt: '2026-11-11T09:15:00-05:00',
    insiderCik: '2000002', insiderName: 'Roe Richard',
    relationship: { isDirector: true, isOfficer: false, isTenPercentOwner: false, isOther: false },
    transactions: [transaction({ code: 'P', shares: 4000, price: 10.25, after: 4000, date: '2026-11-10' })],
  }),
  // Die Käuferin aus dem Standardfall verkauft wieder -> Verkaufswarnung.
  '0001000000-26-000010': form4({
    accessionNo: '0001000000-26-000010', ticker: 'ACME', issuerCik: '1000001', filedAt: '2026-11-12T16:40:00-05:00',
    transactions: [transaction({ code: 'S', shares: 6000, price: 12.5, after: 19000, date: '2026-11-11', acquired: 'D' })],
    footnotes: [{ id: 'F1', text: 'The sale was effected pursuant to a Rule 10b5-1 trading plan.' }],
  }),
  // Wenige teure Aktien: 300 × 900 $ = 270.000 $ -> Signal. Eine Grenze nach Stückzahl hätte es verworfen.
  '0001000000-26-000011': form4({
    accessionNo: '0001000000-26-000011', ticker: 'PRCY', issuerCik: '1000011',
    transactions: [transaction({ code: 'P', shares: 300, price: 900, after: 1300 })],
  }),
  // Viele billige Aktien: 5.000 × 2 $ = 10.000 $ -> verworfen.
  '0001000000-26-000012': form4({
    accessionNo: '0001000000-26-000012', ticker: 'CHEP', issuerCik: '1000012',
    transactions: [transaction({ code: 'P', shares: 5000, price: 2, after: 5000 })],
  }),
  // Verkauf nach einem gemeldeten Kauf (DOWN), zu dem keine Order gesendet wurde -> keine Warnung.
  '0001000000-26-000013': form4({
    accessionNo: '0001000000-26-000013', ticker: 'DOWN', issuerCik: '1000006', filedAt: '2026-11-13T10:00:00-05:00',
    transactions: [transaction({ code: 'S', shares: 1000, price: 13, after: 24000, date: '2026-11-12', acquired: 'D' })],
  }),
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
function history(issuerCik, insiderCik = '2000001') {
  const current = Object.values(FILINGS).find((f) => f.issuer.cik === issuerCik && f.reportingOwner.cik === insiderCik);
  const ticker = current ? current.issuer.tradingSymbol : 'XXXX';
  return [
    ...(current ? [current] : []),
    form4({
      accessionNo: `0001000000-25-9${issuerCik.slice(-5)}`, ticker, issuerCik, insiderCik, filedAt: '2025-05-02T17:00:00-04:00',
      transactions: [transaction({ code: 'P', shares: 4000, price: 8.0, after: 24000, date: '2025-05-01' })],
    }),
    form4({
      accessionNo: `0001000000-24-9${issuerCik.slice(-5)}`, ticker, issuerCik, insiderCik, filedAt: '2024-03-12T17:00:00-04:00',
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

// PRCY ist die teure Aktie der Testdaten (um 900 $), alle anderen kosten um 10 $.
const basePrice = (symbol) => (symbol === 'PRCY' ? 900 : 10);

function quoteSummary(symbol) {
  const value = (raw) => ({ raw, fmt: String(raw) });
  return {
    quoteSummary: {
      result: [{
        price: { symbol, regularMarketPrice: value(basePrice(symbol) * 1.2), marketCap: value(1500000000), currency: 'USD' },
        summaryDetail: { trailingPE: value(18.4), forwardPE: value(15.1), fiftyTwoWeekLow: value(7.5), fiftyTwoWeekHigh: value(14.2) },
        defaultKeyStatistics: { shortPercentOfFloat: value(0.075), shortRatio: value(3.2), heldPercentInstitutions: value(0.61) },
      }],
      error: null,
    },
  };
}

/**
 * Tageskurse im Format der Yahoo-Chart-API: Werktage von Juni 2026 bis März 2027.
 * Aktien steigen täglich um 0,2 % ihres Ausgangskurses (0,02 $ bei 10 $), der Index (SPY) um 0,10 $.
 */
function chart(symbol) {
  const timestamps = [];
  const prices = [];
  const day = new Date('2026-06-01T14:30:00Z'); // 9:30 Uhr New York
  while (day.toISOString().slice(0, 10) <= '2027-03-31') {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      const i = prices.length;
      timestamps.push(day.getTime() / 1000);
      prices.push(symbol === 'SPY' ? 500 + 0.1 * i : basePrice(symbol) * (1 + 0.002 * i));
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return {
    chart: {
      result: [{
        meta: { symbol, currency: 'USD', gmtoffset: -18000, exchangeTimezoneName: 'America/New_York', dataGranularity: '1d' },
        timestamp: timestamps,
        indicators: {
          quote: [{
            open: prices,
            high: prices.map((p) => p * 1.01),
            low: prices.map((p) => p * 0.99),
            close: prices.map((p) => p * 1.001),
            volume: prices.map(() => 200000),
          }],
        },
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

module.exports = { FILINGS, BROKEN_ACCESSION, streamFiling, history, institutionalHoldings, quoteSummary, chart, LLM_VERDICT };
