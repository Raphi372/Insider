'use strict';

/** Erzeugt Tageskerzen für aufeinanderfolgende Werktage ab `start`. */
function makeBars(start, count, priceAt = () => 100, spread = 0.01) {
  const bars = [];
  const day = new Date(`${start}T00:00:00Z`);
  while (bars.length < count) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      const i = bars.length;
      const price = priceAt(i);
      bars.push({
        date: day.toISOString().slice(0, 10),
        open: price,
        high: price * (1 + spread),
        low: price * (1 - spread),
        close: price,
        volume: 100000,
      });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return bars;
}

/** Eine Kerze mit frei wählbaren Werten; fehlende Angaben folgen dem Eröffnungskurs. */
function bar(date, open, { high = open, low = open, close = open, volume = 100000 } = {}) {
  return { date, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume };
}

function signal(overrides = {}) {
  return {
    accessionNo: '0001000000-24-000001',
    filedAt: '2024-03-04T17:30:00-05:00',
    ticker: 'ACME',
    tickerValid: true,
    issuerName: 'ACME Corp',
    issuerCik: '1',
    insiderName: 'Doe Jane',
    insiderCik: '100',
    role: 'Officer (Chief Financial Officer)',
    isOfficer: true,
    isDirector: false,
    isTenPercentOwner: false,
    ...overrides,
    purchase: {
      lots: 1, shares: 5000, value: 500000, avgPrice: 100, firstDate: '2024-03-01', lastDate: '2024-03-01',
      sharesOwnedBefore: 20000, sharesOwnedAfter: 25000, holdingsIncreasePct: 25,
      ...(overrides.purchase || {}),
    },
  };
}

const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] || null, getSetCookie: () => headers['set-cookie'] || [] },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  arrayBuffer: async () => new ArrayBuffer(0),
});

module.exports = { makeBars, bar, signal, jsonResponse };
