'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createSecContext, htmlToText, parseFilingIndex, extractItems, keywordWindows, scoreFiling } = require('../src/sec-context');
const { createServer } = require('../src/journal');

// ------------------------------------------------------------ Testdaten im EDGAR-Format

const CIK = '1468929';
const EIGHT_K = '0001493152-26-051238';
const FOLDER = `/Archives/edgar/data/${CIK}/${EIGHT_K.replace(/-/g, '')}`;

function submissions() {
  const rows = [
    // Nach dem Form 4 eingereicht – gehört nicht dazu.
    ['8-K', '2026-11-20', '0001493152-26-060000', 'form8-k.htm', '1.01,3.02'],
    // Das Form 4 selbst.
    ['4', '2026-11-13', '0001493152-26-051920', 'xslF345X06/ownership.xml', ''],
    // Die Platzierung: wesentlicher Vertrag, Anleihe, Ausgabe nicht registrierter Aktien.
    ['8-K', '2026-11-12', EIGHT_K, 'form8-k.htm', '1.01,2.03,3.02,8.01,9.01'],
    // Personalie – kein Bezug zur Finanzierung.
    ['8-K', '2026-10-30', '0001493152-26-049000', 'form8-k.htm', '5.02,9.01'],
    ['10-Q', '2026-11-10', '0001493152-26-050100', 'form10-q.htm', ''],
    // Zu alt für das 30-Tage-Fenster.
    ['8-K', '2026-08-21', '0001493152-26-039708', 'form8-k.htm', '1.01'],
  ];
  return {
    cik: CIK,
    name: 'NEXGEL, INC.',
    filings: { recent: {
      form: rows.map((r) => r[0]),
      filingDate: rows.map((r) => r[1]),
      accessionNumber: rows.map((r) => r[2]),
      primaryDocument: rows.map((r) => r[3]),
      items: rows.map((r) => r[4]),
      primaryDocDescription: rows.map((r) => r[0]),
    } },
  };
}

function indexPage() {
  const row = (seq, description, name, type, size, ix = false) => `
   <tr${seq % 2 ? '' : ' class="blueRow"'}>
      <td scope="row">${seq}</td>
      <td scope="row">${description}</td>
      <td scope="row"><a href="${ix ? '/ix?doc=' : ''}${FOLDER}/${name}">${name}</a>${ix ? '&nbsp;&nbsp;<span style="color: green">iXBRL</span>' : ''}</td>
      <td scope="row">${type}</td>
      <td scope="row">${size}</td>
   </tr>`;
  return `<html><body><div id="formDiv"><table class="tableFile" summary="Document Format Files">
   <tr><th scope="col">Seq</th><th scope="col">Description</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Size</th></tr>
   ${row(1, '8-K', 'form8-k.htm', '8-K', '71234', true)}
   ${row(2, 'EXHIBIT 4.1', 'ex4-1.htm', 'EX-4.1', '120000')}
   ${row(3, 'EXHIBIT 10.1', 'ex10-1.htm', 'EX-10.1', '345678')}
   ${row(4, 'EXHIBIT 99.1', 'ex99-1.htm', 'EX-99.1', '20000')}
   ${row(5, 'GRAPHIC', 'logo.jpg', 'GRAPHIC', '5000')}
   ${row(6, 'XBRL INSTANCE', 'nxgl-20261112_htm.xml', 'XML', '3000')}
   </table></div>
   <table class="tableFile" summary="Data Files"><tr><td>1</td><td>x</td><td><a href="/x.xsd">x.xsd</a></td><td>EX-101.SCH</td><td>1</td></tr></table>
   </body></html>`;
}

const EIGHT_K_HTML = `<html><head><title>8-K</title><style>p{}</style></head><body>
<div style="display:none"><ix:header><ix:hidden>dei:EntityCentralIndexKey 0001468929</ix:hidden></ix:header></div>
<p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</p><p>FORM 8-K</p>
<p><b>Item&nbsp;1.01 Entry into a Material Definitive Agreement.</b></p>
<p>On November 10, 2026, NexGel, Inc. entered into a Securities Purchase Agreement (the &#8220;Purchase Agreement&rdquo;) with certain investors, including Sequence LifeScience, for the sale of 1,000,000 units at a purchase price of $5.50 per unit. Each unit consists of one share of common stock and one warrant with an exercise price of $6.00.</p>
<p>The exercise price resets on the first anniversary of the closing to the lower of $6.00 and the market price, subject to a floor price of $2.00.</p>
<p>The information set forth in Item 3.02 below is incorporated herein by reference.</p>
<p><b>Item 2.03 Creation of a Direct Financial Obligation.</b></p>
<p>The Company amended its convertible note with a principal amount of $3,000,000 to reduce the conversion price from $8.00 to $5.50.</p>
<p><b>Item 3.02 Unregistered Sales of Equity Securities.</b></p>
<p>Under Nasdaq rules, the Company may not issue more than 19.99% of its outstanding shares (the &ldquo;Exchange Cap&rdquo;) without stockholder approval.</p>
<p><b>Item 5.02 Departure of Directors.</b></p><p>Not related.</p>
<p><b>Item 9.01 Financial Statements and Exhibits.</b></p><p>10.1 Securities Purchase Agreement</p>
<p>SIGNATURES</p><p>Pursuant to the requirements ...</p>
</body></html>`;

const filler = (words) => Array.from({ length: words }, (_, i) => `word${i % 50}`).join(' ');
const EXHIBIT_HTML = {
  'ex10-1.htm': `<html><body><p>SECURITIES PURCHASE AGREEMENT</p><p>${filler(400)}</p>
    <p>&#8220;Exchange Cap&#8221; means 19.99% of the shares of Common Stock outstanding immediately prior to the date hereof.</p><p>${filler(400)}</p>
    <p>The Closing shall occur on November 12, 2026, subject to the satisfaction of the closing conditions.</p></body></html>`,
  'ex4-1.htm': `<html><body><p>FORM OF WARRANT</p><p>${filler(300)}</p><p>Exercise Price. The exercise price per share shall be $6.00, subject to adjustment.</p></body></html>`,
  'ex99-1.htm': `<html><body><p>NexGel Announces $5.5 Million Private Placement and Planned Merger with Example Bio</p>
    <p>NexGel today announced a private placement priced at-the-market under Nasdaq rules. The merger is intended to combine the companies' hydrogel platforms.</p></body></html>`,
};

/** Nachbildung von data.sec.gov und www.sec.gov; protokolliert jeden Abruf. */
function fakeSec(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, userAgent: options.headers && options.headers['user-agent'] });
    const path = url.replace(/^https:\/\/(data|www)\.sec\.gov/, '');
    const reply = (status, body, type = 'text/html') => ({
      ok: status >= 200 && status < 300, status, headers: new Map([['content-type', type]]),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    if (overrides[path]) return overrides[path](reply, calls.filter((c) => c.url === url).length);
    if (path === `/submissions/CIK000${CIK}.json`) return reply(200, submissions(), 'application/json');
    if (path === `${FOLDER}/${EIGHT_K}-index.htm`) return reply(200, indexPage());
    if (path === `${FOLDER}/form8-k.htm`) return reply(200, EIGHT_K_HTML);
    const name = path.split('/').pop();
    if (path.startsWith(FOLDER) && EXHIBIT_HTML[name]) return reply(200, EXHIBIT_HTML[name]);
    return reply(404, 'Not Found');
  };
  return { calls, fetchImpl };
}

const REQUEST = { issuerCik: CIK, accessionNo: '0001493152-26-051920', filedAt: '2026-11-13T16:05:00-05:00', transactionDate: '2026-11-10' };
const CONTACT = 'Insider Pipeline test@example.com';

// ------------------------------------------------------------ Bausteine

test('htmlToText entfernt Kopf, Skripte und XBRL-Daten und löst Entitäten auf', () => {
  const text = htmlToText(EIGHT_K_HTML);
  assert.ok(text.startsWith('UNITED STATES SECURITIES'), text.slice(0, 60));
  assert.ok(!text.includes('EntityCentralIndexKey'));
  assert.ok(!text.includes('p{}'));
  assert.match(text, /\nItem 1\.01 Entry into a Material Definitive Agreement\./);
  assert.match(text, /the “Purchase Agreement”\)/);
  assert.equal(htmlToText('a&nbsp;b &amp; c &#x2019; &unknown; &#0;'), 'a b & c ’ &unknown;');
});

test('parseFilingIndex liest die Dokumententabelle samt iXBRL-Verweisen', () => {
  const docs = parseFilingIndex(indexPage(), 'https://www.sec.gov');
  assert.deepEqual(docs.map((d) => [d.seq, d.type, d.name]), [
    [1, '8-K', 'form8-k.htm'], [2, 'EX-4.1', 'ex4-1.htm'], [3, 'EX-10.1', 'ex10-1.htm'],
    [4, 'EX-99.1', 'ex99-1.htm'], [5, 'GRAPHIC', 'logo.jpg'], [6, 'XML', 'nxgl-20261112_htm.xml'],
  ]);
  assert.equal(docs[0].url, `https://www.sec.gov${FOLDER}/form8-k.htm`, 'der Viewer-Präfix /ix?doc= fällt weg');
  assert.equal(docs[2].size, 345678);
  assert.equal(parseFilingIndex(indexPage(), 'http://mock:8080/secarchives')[0].url, `http://mock:8080/secarchives${FOLDER}/form8-k.htm`);
  assert.deepEqual(parseFilingIndex('<html>kein Index</html>', 'x'), []);
});

test('extractItems schneidet die gewünschten Items heraus und ignoriert Verweise im Fließtext', () => {
  const sections = extractItems(htmlToText(EIGHT_K_HTML), ['1.01', '2.03', '3.02']);
  assert.deepEqual(sections.map((s) => s.item), ['1.01', '2.03', '3.02']);
  assert.match(sections[0].text, /\$5\.50 per unit/);
  assert.match(sections[0].text, /incorporated herein by reference\.$/, 'der Verweis auf Item 3.02 beendet den Abschnitt nicht');
  assert.match(sections[2].text, /Exchange Cap/);
  assert.ok(!sections[2].text.includes('Departure'), 'endet vor dem nächsten Item');
  assert.equal(extractItems('Item 1.01 Kurz.\nSIGNATURES\nx', ['1.01'], 5).length, 0, 'zu kurze Abschnitte zählen nicht');
});

test('keywordWindows bevorzugt starke Begriffe, hält das Limit und die Reihenfolge des Dokuments', () => {
  const text = `${filler(200)} closing date ${filler(200)} Exchange Cap means 19.99% ${filler(200)} exercise price $6.00 ${filler(200)}`;
  const { text: excerpt, truncated } = keywordWindows(text, 1000, 200);
  assert.ok(excerpt.length <= 1000 + 10, `${excerpt.length} Zeichen`);
  assert.ok(excerpt.indexOf('Exchange Cap') < excerpt.indexOf('exercise price'));
  assert.ok(!excerpt.includes('closing date'), 'schwacher Begriff fliegt zuerst raus');
  assert.equal(truncated, true);

  // Ein dicht beschriebener Vertrag wird nicht zu einem einzigen, zu großen Block.
  const dense = Array.from({ length: 60 }, () => 'The exercise price and the purchase price are adjusted.').join(' ');
  const result = keywordWindows(dense, 3000, 300);
  assert.ok(result.text.length > 1000 && result.text.length <= 3010, `${result.text.length} Zeichen`);
});

test('scoreFiling gewichtet 8-K-Items und Fusionsunterlagen', () => {
  assert.equal(scoreFiling({ form: '8-K', items: ['1.01', '3.02', '9.01'] }), 16);
  assert.equal(scoreFiling({ form: '8-K', items: ['5.02', '9.01'] }), 0);
  assert.equal(scoreFiling({ form: 'S-4', items: [] }), 7);
  assert.equal(scoreFiling({ form: '424B5', items: [] }), 4);
  assert.equal(scoreFiling({ form: '10-Q', items: [] }), 0);
});

// ------------------------------------------------------------ Abruf

test('lookup findet den passenden 8-K und liefert Auszüge aus Vertrag, Warrant und Pressemitteilung', async () => {
  const sec = fakeSec();
  const sleeps = [];
  const context = createSecContext({ userAgent: CONTACT, fetchImpl: sec.fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  const result = await context.lookup(REQUEST);

  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.deepEqual(result.window, { from: '2026-10-11', to: '2026-11-13' });
  assert.deepEqual(result.filings.map((f) => [f.form, f.filingDate, f.items.join(',')]), [['8-K', '2026-11-12', '1.01,2.03,3.02,8.01,9.01']],
    'ohne spätere, ältere und themenfremde Filings');
  const [filing] = result.filings;
  assert.equal(filing.indexUrl, `https://www.sec.gov${FOLDER}/${EIGHT_K}-index.htm`);
  assert.deepEqual(filing.documents.map((d) => d.type), ['8-K', 'EX-10.1', 'EX-4.1', 'EX-99.1'], 'Kaufvertrag vor Warrant vor Pressemitteilung');

  const [main, spa, warrant, press] = filing.documents;
  assert.match(main.excerpt, /^Item 1\.01 Entry into a Material Definitive Agreement\./);
  assert.match(main.excerpt, /Item 3\.02 Unregistered Sales[\s\S]*Exchange Cap/);
  assert.ok(!main.excerpt.includes('Departure of Directors'), 'Item 5.02 gehört nicht dazu');
  assert.match(spa.excerpt, /“Exchange Cap” means 19\.99%/);
  assert.ok(spa.excerpt.length < htmlToText(EXHIBIT_HTML['ex10-1.htm']).length, 'nur Ausschnitte, nicht der ganze Vertrag');
  assert.match(warrant.excerpt, /exercise price per share shall be \$6\.00/);
  assert.match(press.excerpt, /^NexGel Announces \$5\.5 Million Private Placement and Planned Merger/);
  assert.deepEqual(result.notes, []);

  // Jeder Abruf trägt die Kennung mit Kontaktadresse; zwischen den Abrufen liegt eine Pause.
  assert.ok(sec.calls.every((c) => c.userAgent === CONTACT));
  assert.equal(sec.calls.length, 6, 'Verzeichnis, Index und vier Dokumente');
  assert.ok(sleeps.length >= 5 && sleeps.every((ms) => ms <= 150));

  // Ein zweites Form 4 derselben Platzierung (anderer Insider) kommt aus dem Zwischenspeicher.
  const again = await context.lookup({ ...REQUEST, accessionNo: '0001493152-26-051919' });
  assert.equal(sec.calls.length, 6, 'Verzeichnis, Index und Dokumente nicht erneut geladen');
  assert.deepEqual(again.filings[0].documents.map((d) => d.excerpt), filing.documents.map((d) => d.excerpt));
});

test('lookup ohne E-Mail im User-Agent listet nur die Filings und nennt den Grund', async () => {
  const sec = fakeSec();
  const result = await createSecContext({ userAgent: 'insider-pipeline/1.0', fetchImpl: sec.fetchImpl, sleep: async () => {} }).lookup(REQUEST);
  assert.equal(result.configured, false);
  assert.deepEqual(result.filings.map((f) => [f.form, f.documents.length]), [['8-K', 0]]);
  assert.deepEqual(sec.calls.map((c) => c.url), [`https://data.sec.gov/submissions/CIK000${CIK}.json`], 'kein Abruf bei www.sec.gov');
  assert.match(result.notes.join(' '), /SEC_USER_AGENT enthält keine E-Mail-Adresse/);
});

test('lookup: Fehler bei Index oder Dokument stehen in den Hinweisen, 503 wird genau einmal wiederholt', async () => {
  const sec = fakeSec({
    [`/submissions/CIK000${CIK}.json`]: (reply, attempt) => (attempt === 1 ? reply(503, 'busy') : reply(200, submissions(), 'application/json')),
    [`${FOLDER}/ex10-1.htm`]: (reply) => reply(403, 'Undeclared Automated Tool'),
  });
  const result = await createSecContext({ userAgent: CONTACT, fetchImpl: sec.fetchImpl, sleep: async () => {} }).lookup(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(sec.calls.filter((c) => c.url.includes('/submissions/')).length, 2);
  assert.deepEqual(result.filings[0].documents.map((d) => d.type), ['8-K', 'EX-4.1', 'EX-99.1']);
  assert.deepEqual(result.notes, ['EX-10.1 (8-K vom 2026-11-12): HTTP 403']);

  const missing = fakeSec({ [`/submissions/CIK000${CIK}.json`]: (reply) => reply(404, 'NoSuchKey') });
  const failed = await createSecContext({ userAgent: CONTACT, fetchImpl: missing.fetchImpl, sleep: async () => {} }).lookup(REQUEST);
  assert.deepEqual([failed.ok, failed.filings, failed.notes], [false, [], ['SEC-Verzeichnis: HTTP 404']]);

  const none = await createSecContext({ userAgent: CONTACT, fetchImpl: fakeSec().fetchImpl, sleep: async () => {} })
    .lookup({ ...REQUEST, filedAt: '2026-10-01T10:00:00-04:00', transactionDate: '2026-09-30' });
  assert.deepEqual([none.ok, none.filings.length, none.notes], [true, 0, ['kein passendes Filing zwischen 2026-08-31 und 2026-10-01']]);

  const noCik = await createSecContext({ fetchImpl: fakeSec().fetchImpl }).lookup({});
  assert.deepEqual([noCik.ok, noCik.notes], [false, ['keine CIK des Unternehmens']]);
});

test('lookup bricht nach dem Zeitlimit ab und meldet das', async () => {
  let clock = 0;
  const sec = fakeSec();
  const slow = async (url, options) => {
    clock += 6000;
    return sec.fetchImpl(url, options);
  };
  const result = await createSecContext({ userAgent: CONTACT, fetchImpl: slow, sleep: async () => {}, now: () => clock, deadlineMs: 20000 }).lookup(REQUEST);
  assert.ok(result.filings[0].documents.length < 4);
  assert.match(result.notes.join(' '), /Zeitlimit erreicht/);
});

test('POST /sec-context reicht die Anfrage an den SEC-Abruf weiter', async (t) => {
  const seen = [];
  const secContext = { lookup: async (request) => { seen.push(request); return { ok: true, filings: [], notes: [] }; } };
  const journal = { readSignals: () => [], readEvents: () => [] };
  const server = createServer(journal, () => {}, { secContext });
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/sec-context`, { method: 'POST', body: JSON.stringify(REQUEST) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, filings: [], notes: [] });
  assert.deepEqual(seen, [REQUEST]);

  const bare = createServer(journal, () => {}, {});
  bare.listen(0);
  await once(bare, 'listening');
  t.after(() => bare.close());
  const missing = await fetch(`http://127.0.0.1:${bare.address().port}/sec-context`, { method: 'POST', body: '{}' });
  assert.equal(missing.status, 503);
});
