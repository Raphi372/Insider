'use strict';

// Läuft am Ende von run.sh, nachdem n8n ohne FINNHUB_API_KEY neu gestartet
// wurde. Ohne Schlüssel muss alles laufen wie vor der Einführung von Finnhub:
// Der Workflow fragt nur Yahoo Finance ab.

const test = require('node:test');
const assert = require('node:assert/strict');
const { streamFiling } = require('./fixtures');
const { control, requests, journal, waitFor, waitForMessages, webhook, bridgeConnected } = require('./helpers');

// Direkt an den Webhook: Die Bridge kennt diese Filings schon und würde sie als
// Duplikat verwerfen. Nach dem Neustart antwortet n8n erst mit 404, bis der
// Workflow wieder aktiv ist.
const submit = (accessionNo) => waitFor(`n8n nimmt ${accessionNo} an`, async () => {
  try { return (await webhook('sec-filing', streamFiling(accessionNo))).status === 200; } catch (err) { return false; }
}, 180000);

const loggedSources = (accessionNo, firstReason) => waitFor(`Protokolleintrag ${accessionNo} ohne Finnhub`, async () => {
  const entry = (await journal('signals')).find((signal) => signal.accessionNo === accessionNo);
  return entry && entry.marketSources && entry.marketSources[0].reason === firstReason ? entry.marketSources : null;
});

test.before(bridgeConnected);
test.beforeEach(() => control('reset', {}));

test('Ohne Finnhub-Schlüssel fragt der Workflow nur Yahoo ab', async () => {
  await submit('0001000000-26-000014');

  const [message] = await waitForMessages(1, 90000);
  assert.match(message.body.text, /<b>Insiderkauf FBCK<\/b>/);
  assert.match(message.body.text, /<b>Markt:<\/b> Kurs 12,00 \$ \(\+17,6 % ggü\. Insiderpreis\) · Marktkap\. 1,50 Mrd\. \$ · Yahoo, 10\.11\. 22:00\n/);

  assert.equal((await requests('finnhub')).length, 0, 'ohne Schlüssel kein Abruf bei Finnhub');
  assert.deepEqual(
    (await requests('yahoo')).map((r) => r.path),
    ['/yahoo-cookie', '/yahoo/v1/test/getcrumb', '/yahoo/v10/finance/quoteSummary/FBCK'],
  );
  assert.deepEqual(await loggedSources('0001000000-26-000014', 'kein Schlüssel'), [
    { source: 'Finnhub', ok: false, reason: 'kein Schlüssel' },
    { source: 'Yahoo', ok: true, reason: null },
  ]);
});

test('Ohne Schlüssel und mit blockiertem Yahoo nennt die Meldung beide Gründe', async () => {
  await control('behavior', { yahooDown: true });
  await submit('0001000000-26-000015');

  const [message] = await waitForMessages(1, 90000);
  assert.match(message.body.text, /<b>Insiderkauf CALC<\/b>/);
  assert.match(message.body.text, /<b>Markt:<\/b> Marktdaten nicht verfügbar \(Finnhub: kein Schlüssel · Yahoo: HTTP 503\)\n/);
  assert.equal((await requests('finnhub')).length, 0);
  assert.equal((await requests('secdata')).length, 0);
});
