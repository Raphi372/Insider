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
  // Kauf, während Finnhub drosselt (HTTP 429) -> Yahoo springt ein.
  '0001000000-26-000014': form4({ accessionNo: '0001000000-26-000014', ticker: 'FBCK', issuerCik: '1000014', transactions: purchaseLots() }),
  // Kauf, zu dem Finnhub kein Unternehmensprofil hat -> Marktkapitalisierung aus der Aktienzahl der SEC.
  '0001000000-26-000015': form4({ accessionNo: '0001000000-26-000015', ticker: 'CALC', issuerCik: '1000015', transactions: purchaseLots() }),
  // Units aus einer Privatplatzierung: Aktien in Tabelle I, die Warrants in Tabelle II.
  // Der Kurs liegt weit unter dem Insiderpreis -> kein Order-Vorschlag.
  '0001000000-26-000016': {
    ...form4({
      accessionNo: '0001000000-26-000016', ticker: 'PIPX', issuerCik: '1000016',
      transactions: [transaction({ code: 'P', shares: 100000, price: 5.0, after: 100000 })],
      footnotes: [
        { id: 'F1', text: 'Represents units purchased from the Issuer in a private placement pursuant to a Securities Purchase Agreement dated November 6, 2026. Each unit consists of one share of common stock and one warrant to purchase one share of common stock.' },
        { id: 'F2', text: 'The warrants are exercisable immediately and expire on November 9, 2031.' },
      ],
    }),
    derivativeTable: { transactions: [{
      securityTitle: 'Warrants (right to buy)', conversionOrExercisePrice: 6.0, transactionDate: '2026-11-09',
      coding: { formType: '4', code: 'P', equitySwapInvolved: false },
      amounts: { shares: 100000, pricePerShare: 0, acquiredDisposedCode: 'A' },
      exerciseDate: '2026-11-09', expirationDate: '2031-11-09',
      underlyingSecurity: { title: 'Common Stock', shares: 100000 },
      postTransactionAmounts: { sharesOwnedFollowingTransaction: 100000 },
      ownershipNature: { directOrIndirectOwnership: 'D' },
    }] },
  },
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

// PRCY ist die teure Aktie der Testdaten (um 900 $), PIPX notiert weit unter dem
// Platzierungspreis von 5 $, alle anderen kosten um 10 $.
const basePrice = (symbol) => ({ PRCY: 900, PIPX: 3.5 }[symbol] || 10);

// Zeitpunkt aller Testkurse: 10.11.2026, 16:00 Uhr New York = 22:00 Uhr Berlin.
const QUOTE_TIME = Date.parse('2026-11-10T21:00:00Z') / 1000;

/** Finnhub /quote. Unbekannte Symbole beantwortet Finnhub mit lauter Nullen. */
function finnhubQuote(symbol) {
  if (symbol === 'NOQUOTE') return { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 };
  const price = basePrice(symbol) * 1.2;
  return { c: price, d: price * 0.01, dp: 1.0101, h: price * 1.02, l: price * 0.98, o: price * 0.99, pc: price * 0.99, t: QUOTE_TIME };
}

/** Finnhub /stock/profile2: Marktkapitalisierung und Aktienzahl in Millionen. Ohne Profil kommt {}. */
function finnhubProfile(symbol) {
  if (symbol === 'CALC') return {};
  return {
    country: 'US', currency: 'USD', exchange: 'NASDAQ NMS - GLOBAL MARKET', finnhubIndustry: 'Technology', ipo: '2010-06-29',
    logo: '', marketCapitalization: 1500, name: `${symbol} Corp`, phone: '', shareOutstanding: 125, ticker: symbol, weburl: '',
  };
}

/** Finnhub /stock/metric?metric=all (gekürzt auf die Felder, die der Workflow liest, plus Beiwerk). */
function finnhubMetric(symbol) {
  return {
    metric: { '10DayAverageTradingVolume': 0.21, '52WeekHigh': 14.2, '52WeekLow': 7.5, '52WeekLowDate': '2026-04-08', beta: 1.1, marketCapitalization: 1500, peTTM: 18.4 },
    metricType: 'all',
    series: { annual: { currentRatio: [{ period: '2025-12-31', v: 1.5 }] }, quarterly: {} },
    symbol,
  };
}

/** SEC companyconcept: ausstehende Aktien laut Deckblatt der Berichte. Nur für CALC hinterlegt. */
function secShares(cik) {
  if (cik !== '0001000015') return null;
  const fact = (end, val, form, filed, extra = {}) => ({ end, val, accn: '0001000015-26-000001', fy: 2026, fp: 'Q3', form, filed, ...extra });
  return {
    cik: 1000015,
    taxonomy: 'dei',
    tag: 'EntityCommonStockSharesOutstanding',
    label: 'Entity Common Stock, Shares Outstanding',
    entityName: 'CALC Corp',
    units: {
      shares: [
        fact('2026-06-30', 118000000, '10-Q', '2026-08-05', { frame: 'CY2026Q2I' }),
        fact('2026-09-30', 120000000, '10-Q', '2026-11-04', { frame: 'CY2026Q3I' }),
        // Jünger, aber kein Quartals- oder Jahresbericht – zählt nicht.
        fact('2026-10-15', 999, 'S-1', '2026-10-20'),
      ],
    },
  };
}

function quoteSummary(symbol) {
  const value = (raw) => ({ raw, fmt: String(raw) });
  return {
    quoteSummary: {
      result: [{
        price: { symbol, regularMarketPrice: value(basePrice(symbol) * 1.2), regularMarketTime: QUOTE_TIME, marketCap: value(1500000000), currency: 'USD' },
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

// ------------------------------------------- SEC: Verzeichnis und Dokumente (EDGAR)

// Das 8-K zur Privatplatzierung von PIPX, eingereicht drei Tage vor dem Form 4.
const PIPE_FILING = { cik: '1000016', accessionNo: '0001000016-26-000020', filingDate: '2026-11-06' };
const PIPE_FOLDER = `/Archives/edgar/data/${PIPE_FILING.cik}/${PIPE_FILING.accessionNo.replace(/-/g, '')}`;

/** data.sec.gov/submissions: Verzeichnis der Filings (gekürzt). Nur für PIPX hinterlegt. */
function secSubmissions(cik) {
  if (cik !== '0001000016') return null;
  const rows = [
    ['4', '2026-11-10', '0001000000-26-000016', 'xslF345X06/ownership.xml', ''],
    ['10-Q', '2026-11-09', '0001000016-26-000019', 'form10-q.htm', ''],
    ['8-K', PIPE_FILING.filingDate, PIPE_FILING.accessionNo, 'form8-k.htm', '1.01,3.02,9.01'],
    ['8-K', '2026-10-20', '0001000016-26-000015', 'form8-k.htm', '5.02,9.01'],
  ];
  return {
    cik: '1000016', name: 'PIPX Corp', tickers: ['PIPX'],
    filings: { recent: {
      accessionNumber: rows.map((r) => r[2]), filingDate: rows.map((r) => r[1]), form: rows.map((r) => r[0]),
      primaryDocument: rows.map((r) => r[3]), items: rows.map((r) => r[4]), primaryDocDescription: rows.map((r) => r[0]),
    } },
  };
}

const filler = (n) => Array.from({ length: n }, (_, i) => `clause${i % 40}`).join(' ');
const PIPE_DOCUMENTS = {
  'form8-k.htm': ['8-K', '8-K', `<html><body><div style="display:none"><ix:header>dei:EntityCentralIndexKey 0001000016</ix:header></div>
    <p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</p><p>FORM 8-K</p>
    <p><b>Item&nbsp;1.01 Entry into a Material Definitive Agreement.</b></p>
    <p>On November 6, 2026, PIPX Corp entered into a Securities Purchase Agreement with certain investors, including members of management, for the sale of 2,000,000 units at a purchase price of $5.00 per unit in a private placement. Each unit consists of one share of common stock and one warrant to purchase one share of common stock at an exercise price of $6.00 per share. The warrants expire five years after issuance.</p>
    <p>On the first anniversary of the closing, the exercise price of the warrants resets to the lower of $6.00 and the average market price, subject to a floor price of $2.50.</p>
    <p><b>Item 3.02 Unregistered Sales of Equity Securities.</b></p>
    <p>The Company had 10,000,000 shares of common stock outstanding before the offering. Under Nasdaq rules, the Company may not issue more than 19.99% of its outstanding shares (the &#8220;Exchange Cap&#8221;) upon exercise of the warrants without stockholder approval, which the Company will seek at its next annual meeting.</p>
    <p><b>Item 9.01 Financial Statements and Exhibits.</b></p><p>10.1 Securities Purchase Agreement</p>
    <p>SIGNATURES</p><p>Pursuant to the requirements of the Securities Exchange Act of 1934 ...</p></body></html>`],
  'ex10-1.htm': ['EX-10.1', 'SECURITIES PURCHASE AGREEMENT', `<html><body><p>SECURITIES PURCHASE AGREEMENT</p><p>${filler(500)}</p>
    <p>&#8220;Exchange Cap&#8221; shall mean 19.99% of the shares of Common Stock outstanding on the date of this Agreement.</p><p>${filler(500)}</p></body></html>`],
  'ex4-1.htm': ['EX-4.1', 'FORM OF WARRANT', `<html><body><p>FORM OF COMMON STOCK PURCHASE WARRANT</p><p>${filler(300)}</p>
    <p>Exercise Price. The exercise price per share of Common Stock under this Warrant shall be $6.00, subject to adjustment hereunder.</p></body></html>`],
  'ex99-1.htm': ['EX-99.1', 'PRESS RELEASE', `<html><body><p>PIPX Corp Announces $10 Million Private Placement</p>
    <p>The proceeds will fund the planned merger with Gamma Labs, which is expected to close in the second quarter of 2027.</p></body></html>`],
  'logo.jpg': ['GRAPHIC', 'GRAPHIC', 'binary'],
};

/** www.sec.gov/Archives: Filing-Index und Dokumente, wie EDGAR sie ausliefert. */
function secArchive(path) {
  if (path === `${PIPE_FOLDER}/${PIPE_FILING.accessionNo}-index.htm`) {
    const rows = Object.entries(PIPE_DOCUMENTS).map(([name, [type, description]], i) => `
      <tr${i % 2 ? ' class="blueRow"' : ''}>
        <td scope="row">${i + 1}</td>
        <td scope="row">${description}</td>
        <td scope="row"><a href="${i === 0 ? '/ix?doc=' : ''}${PIPE_FOLDER}/${name}">${name}</a></td>
        <td scope="row">${type}</td>
        <td scope="row">${12000 + i}</td>
      </tr>`).join('');
    return `<html><body><table class="tableFile" summary="Document Format Files">
      <tr><th scope="col">Seq</th><th scope="col">Description</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Size</th></tr>${rows}
      </table></body></html>`;
  }
  const name = path.startsWith(`${PIPE_FOLDER}/`) ? path.slice(PIPE_FOLDER.length + 1) : null;
  return name && PIPE_DOCUMENTS[name] ? PIPE_DOCUMENTS[name][2] : null;
}

// Was das Modell aus den Auszügen überträgt: [Feld, Wert, wörtliches Zitat].
// Zwei Angaben sind mit Absicht falsch belegt; der Workflow muss sie verwerfen.
const EXTRACTION = [
  ['angebotsart', 'private placement', 'for the sale of 2,000,000 units at a purchase price of $5.00 per unit in a private placement'],
  ['preisJeEinheit', '5', 'a purchase price of $5.00 per unit'],
  ['einheit', 'one share and one warrant', 'Each unit consists of one share of common stock and one warrant to purchase one share of common stock'],
  ['aktienImAngebot', '2000000', 'for the sale of 2,000,000 units'],
  ['warrantsImAngebot', '2500000', 'Each unit consists of one share of common stock and one warrant'], // Zahl steht nicht im Zitat
  ['warrantAusuebungspreis', '6', 'at an exercise price of $6.00 per share'],
  ['warrantVerfall', '5', 'The warrants expire five years after issuance'],
  ['closingDatum', '2026-11-09', 'The closing occurred on November 9, 2026'], // steht in keinem Dokument
  ['resetBedingung', 'resets on the first anniversary to the lower of $6.00 and the average market price', 'the exercise price of the warrants resets to the lower of $6.00 and the average market price'],
  ['resetUntergrenze', '2.5', 'subject to a floor price of $2.50'],
  ['exchangeCapProzent', '19.99', 'may not issue more than 19.99% of its outstanding shares'],
  ['hvZustimmung', 'stockholder approval at the next annual meeting', 'without stockholder approval, which the Company will seek at its next annual meeting'],
  ['aktienVorher', '10000000', 'The Company had 10,000,000 shares of common stock outstanding before the offering'],
  ['bruttoerloes', '10000000', 'PIPX Corp Announces $10 Million Private Placement'],
  ['fusionPartner', 'Gamma Labs', 'the planned merger with Gamma Labs'],
  ['fusionZweck', 'proceeds fund the merger', 'The proceeds will fund the planned merger with Gamma Labs'],
  ['fusionZeitplan', 'second quarter of 2027', 'expected to close in the second quarter of 2027'],
];

/**
 * Antwort auf die Auslese-Anfrage: alle Felder des Schemas, belegte mit der
 * Nummer des Dokuments, in dem das Zitat steht – wie es das Modell tun soll.
 */
function extractionAnswer(body) {
  const content = String(((body.messages || [])[0] || {}).content || '');
  const documents = [...content.matchAll(/<dokument nr="(\d+)"[^>]*>\n([\s\S]*?)\n<\/dokument>/g)].map((m) => ({ nr: Number(m[1]), text: m[2] }));
  const answer = Object.fromEntries(Object.keys(body.output_config.format.schema.properties)
    .map((key) => [key, { gefunden: false, wert: '', zitat: '', dokument: 0 }]));
  for (const [key, wert, zitat] of EXTRACTION) {
    const doc = documents.find((d) => d.text.includes(zitat));
    answer[key] = { gefunden: true, wert, zitat, dokument: doc ? doc.nr : 1 };
  }
  return answer;
}

const LLM_VERDICT = {
  signal: 'STARK',
  begruendung: 'Die CFO stockt ihren Bestand um ein Viertel auf <ohne> Verkaufsdruck.',
  pro: ['Kauf durch operative Führungskraft', 'Bestand +25 %'],
  contra: ['Kurs liegt bereits über dem Insiderpreis'],
  datenluecken: [],
};

module.exports = {
  FILINGS, BROKEN_ACCESSION, streamFiling, history, institutionalHoldings, quoteSummary, chart, LLM_VERDICT,
  finnhubQuote, finnhubProfile, finnhubMetric, secShares, secSubmissions, secArchive, extractionAnswer, PIPE_FILING,
};
