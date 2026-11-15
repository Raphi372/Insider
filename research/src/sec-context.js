'use strict';

/**
 * Holt zu einem Form 4 die zugehörigen SEC-Dokumente des Unternehmens (8-K,
 * Prospekte, Fusionsunterlagen) und liefert daraus kurze, relevante Auszüge –
 * etwa die Bedingungen einer Privatplatzierung, das Exchange Cap oder die
 * Wandlungsbedingungen einer Anleihe.
 *
 * Quelle ist EDGAR direkt (kostenlos, kein Abruf bei sec-api.io):
 *   data.sec.gov/submissions/CIK##########.json   Verzeichnis aller Filings
 *   www.sec.gov/Archives/edgar/data/...            Filing-Index und Dokumente
 *
 * Die SEC verlangt für Dokumentabrufe eine Kennung mit Kontaktadresse im
 * User-Agent (Name und E-Mail). Fehlt die E-Mail, werden nur die Filings
 * gelistet und die Antwort nennt den Grund.
 */

const DEFAULTS = {
  dataBaseUrl: 'https://data.sec.gov',
  archivesBaseUrl: 'https://www.sec.gov',
  windowDays: 30,
  maxFilings: 3,
  maxExhibitsPerFiling: 4,
  maxDocuments: 8,
  maxExcerptChars: 30000,
  requestTimeoutMs: 8000,
  deadlineMs: 20000,
  // Höchstens etwa sieben Abrufe pro Sekunde – die SEC erlaubt zehn.
  minIntervalMs: 150,
  cacheTtlMs: 6 * 3600 * 1000,
  listTtlMs: 15 * 60 * 1000,
  maxCacheEntries: 40,
  maxDocumentBytes: 5 * 1024 * 1024,
};

// Welche Filings zu einer Kapitalmaßnahme gehören. Bei 8-Ks zählen die Items:
// 1.01 wesentlicher Vertrag, 2.01 Übernahme, 2.03 Finanzverbindlichkeit,
// 3.02 Ausgabe nicht registrierter Aktien, 3.03 Änderung von Aktionärsrechten,
// 8.01 sonstige Ereignisse.
const ITEM_WEIGHTS = { '1.01': 6, '2.01': 4, '2.03': 5, '3.02': 10, '3.03': 2, '8.01': 2 };
const MERGER_FORMS = ['425', 'S-4', 'S-4/A', 'DEFM14A', 'PREM14A', 'DEFA14A'];
const REGISTRATION_FORMS = ['S-1', 'S-1/A', 'S-3', 'S-3/A'];
const PROXY_FORMS = ['DEF 14A', 'PRE 14A'];

function scoreFiling(filing) {
  const form = String(filing.form || '').toUpperCase();
  if (form === '8-K' || form === '8-K/A') return filing.items.reduce((sum, item) => sum + (ITEM_WEIGHTS[item] || 0), 0);
  if (MERGER_FORMS.includes(form)) return 7;
  if (/^424B[1-8]$/.test(form)) return 4;
  if (REGISTRATION_FORMS.includes(form) || PROXY_FORMS.includes(form)) return 3;
  return 0;
}

// Begriffe, um die herum Auszüge aus langen Verträgen geschnitten werden.
// Zuerst die aussagekräftigen, danach – falls noch Platz ist – allgemeinere.
const KEYWORDS_STRONG = /exchange cap|19\.99|(stockholder|shareholder) approval|exercise price|conversion price|anniversary|\breset\b|floor price|purchase price|per unit|gross proceeds|merger|business combination|beneficial ownership limitation/gi;
const KEYWORDS_WEAK = /closing date|closing conditions|maturity date|principal amount|shares of common stock outstanding|outstanding shares|pre-funded|\bwarrants?\b/gi;

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…', sect: '§', middot: '·', bull: '•', reg: '®', trade: '™', copy: '©',
};

/** Macht aus einem HTML-Dokument der SEC lesbaren Text. */
function htmlToText(html) {
  return String(html || '')
    // Inline-XBRL: Der Kopf enthält nur maschinenlesbare Daten.
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|center)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (match, code) => safeChar(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => safeChar(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => (ENTITIES[name.toLowerCase()] === undefined ? match : ENTITIES[name.toLowerCase()]))
    .replace(/[ \t\r\f\v  -​]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function safeChar(code) {
  // Einzelne Surrogate (aus fehlerhaften Entitäten) wären kein gültiges Unicode – die API lehnte sie ab.
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
  return code === 160 ? ' ' : String.fromCodePoint(code);
}

/** Liest die Dokumententabelle eines Filing-Index (…-index.htm). */
function parseFilingIndex(html, archivesBaseUrl) {
  const source = String(html || '');
  const table = (source.match(/<table\b(?=[^>]*Document Format Files)[^>]*>([\s\S]*?)<\/table>/i)
    || source.match(/<table\b[^>]*class="tableFile"[^>]*>([\s\S]*?)<\/table>/i) || [])[1] || '';
  const documents = [];
  for (const row of table.split(/<tr\b[^>]*>/i).slice(1)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 4) continue;
    const href = (cells[2].match(/href="([^"]+)"/i) || [])[1];
    if (!href) continue;
    // iXBRL-Dokumente verlinkt EDGAR über den Viewer: /ix?doc=/Archives/...
    let path = href.replace(/^\/ix\?doc=/i, '');
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    if (!path.startsWith('/')) continue;
    documents.push({
      seq: Number(htmlToText(cells[0])) || documents.length + 1,
      description: htmlToText(cells[1]).slice(0, 120),
      type: htmlToText(cells[3]).toUpperCase(),
      name: path.split('/').pop(),
      url: `${archivesBaseUrl}${path}`,
      size: cells[4] === undefined ? null : (Number(htmlToText(cells[4]).replace(/\D/g, '')) || null),
    });
  }
  return documents;
}

/**
 * Schneidet aus dem Text eines 8-K die gewünschten Items heraus. Überschriften
 * stehen am Zeilenanfang; Verweise im Fließtext ("siehe Item 1.01") nicht.
 */
function extractItems(text, wanted, maxPerItem = 6000) {
  const headings = [...String(text).matchAll(/(?:^|\n)\s*Item\s*(\d{1,2}\.\d{2})\b/gi)]
    .map((match) => ({ item: match[1], start: match.index + (match[0].startsWith('\n') ? 1 : 0) }));
  const signature = String(text).search(/\nSIGNATURES?\b/);
  const sections = [];
  headings.forEach((heading, i) => {
    if (!wanted.includes(heading.item)) return;
    let end = i + 1 < headings.length ? headings[i + 1].start : text.length;
    if (signature > heading.start && signature < end) end = signature;
    const body = text.slice(heading.start, end).trim();
    if (body.length > 20) sections.push({ item: heading.item, text: body.length > maxPerItem ? `${body.slice(0, maxPerItem).trimEnd()} […gekürzt]` : body });
  });
  return sections;
}

/**
 * Ausschnitte um Schlüsselbegriffe mit Obergrenze. Nahe Treffer werden zu einem
 * Abschnitt verbunden, aber nie über `maxSpan` hinaus – sonst würde ein dicht
 * beschriebener Vertrag zu einem einzigen Block, der nicht mehr ins Limit passt.
 * Abschnitte mit starken Begriffen haben Vorrang; ausgegeben wird in der
 * Reihenfolge des Dokuments.
 */
function keywordWindows(text, maxChars, radius = 500, maxSpan = 2400) {
  const source = String(text);
  const hits = [];
  for (const [pattern, strong] of [[KEYWORDS_STRONG, true], [KEYWORDS_WEAK, false]]) {
    for (const match of source.matchAll(pattern)) {
      hits.push({ start: Math.max(0, match.index - radius), end: Math.min(source.length, match.index + match[0].length + radius), strong });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const spans = [];
  for (const hit of hits) {
    const last = spans[spans.length - 1];
    if (last && hit.start <= last.end) {
      if (Math.max(last.end, hit.end) - last.start <= maxSpan) {
        last.end = Math.max(last.end, hit.end);
        last.strong = last.strong || hit.strong;
        continue;
      }
      // Zu lang: neuer Abschnitt ohne Überlappung.
      if (hit.end <= last.end) {
        last.strong = last.strong || hit.strong;
        continue;
      }
      spans.push({ start: last.end, end: hit.end, strong: hit.strong });
      continue;
    }
    spans.push({ ...hit });
  }
  const chosen = [];
  let used = 0;
  let truncated = false;
  for (const group of [spans.filter((s) => s.strong), spans.filter((s) => !s.strong)]) {
    for (const span of group) {
      const length = span.end - span.start;
      if (used + length > maxChars) {
        truncated = true;
        continue;
      }
      chosen.push(span);
      used += length + 5;
    }
  }
  chosen.sort((a, b) => a.start - b.start);
  return {
    text: chosen.map((s) => source.slice(s.start, s.end).replace(/\n/g, ' ').trim()).filter(Boolean).join(' […] '),
    truncated,
  };
}

const pad = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');
const dayOf = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : null);
const addDays = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

function exhibitRank(type) {
  if (/^EX-10\b/.test(type)) return 1; // Kaufvertrag (Securities Purchase Agreement)
  if (/^EX-4\b/.test(type)) return 2; // Warrant, Anleihe
  if (/^EX-99\b/.test(type)) return 3; // Pressemitteilung
  if (/^EX-2\b/.test(type)) return 4; // Fusionsvertrag
  return 0;
}

function createSecContext(options = {}) {
  const settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && v !== '')) };
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const log = options.log || (() => {});
  const userAgent = String(settings.userAgent || 'insider-pipeline/1.0').trim();
  // Die SEC verlangt eine Kontaktadresse – ohne E-Mail keine Dokumente.
  const hasContact = /\S+@\S+\.\S+/.test(userAgent);
  const dataBaseUrl = String(settings.dataBaseUrl).replace(/\/+$/, '');
  const archivesBaseUrl = String(settings.archivesBaseUrl).replace(/\/+$/, '');

  const cache = new Map();
  const remember = (key, value) => {
    cache.set(key, { at: now(), value });
    while (cache.size > settings.maxCacheEntries) cache.delete(cache.keys().next().value);
    return value;
  };
  const recall = (key, ttl) => {
    const hit = cache.get(key);
    return hit && now() - hit.at < ttl ? hit.value : undefined;
  };

  let lastRequestAt = 0;
  let requests = 0;
  /** Ein Abruf mit Zeitlimit; bei 429 oder 5xx genau ein zweiter Versuch nach einer Pause. */
  async function get(url) {
    for (let attempt = 1; ; attempt += 1) {
      const wait = lastRequestAt + settings.minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      requests += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
      let response;
      try {
        response = await fetchImpl(url, { headers: { 'user-agent': userAgent, accept: '*/*' }, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        const reason = err.name === 'AbortError' ? 'Zeitüberschreitung' : 'nicht erreichbar';
        if (attempt === 1 && reason === 'nicht erreichbar') {
          await sleep(1000);
          continue;
        }
        throw Object.assign(new Error(reason), { reason });
      }
      try {
        if ((response.status === 429 || response.status >= 500) && attempt === 1) {
          await sleep(1000);
          continue;
        }
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { reason: `HTTP ${response.status}`, status: response.status });
        return await response.text();
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Alle Filings des Unternehmens laut data.sec.gov (die jüngsten rund 1.000). */
  async function listFilings(cik) {
    const url = `${dataBaseUrl}/submissions/CIK${pad(cik)}.json`;
    const cached = recall(url, settings.listTtlMs);
    if (cached) return cached;
    const recent = ((JSON.parse(await get(url)).filings || {}).recent) || {};
    const forms = recent.form || [];
    const filings = forms.map((form, i) => ({
      form: String(form || ''),
      filingDate: dayOf((recent.filingDate || [])[i]),
      accessionNo: String((recent.accessionNumber || [])[i] || ''),
      primaryDocument: String((recent.primaryDocument || [])[i] || ''),
      description: String((recent.primaryDocDescription || [])[i] || '').slice(0, 80),
      items: String((recent.items || [])[i] || '').split(',').map((item) => item.trim()).filter(Boolean),
    })).filter((f) => f.filingDate && /^\d{10}-\d{2}-\d{6}$/.test(f.accessionNo));
    return remember(url, filings);
  }

  // Zwischengespeichert werden nur überschaubare Texte – ein mehrere Megabyte
  // großer Prospekt würde den Speicher des kleinen Dienstes füllen.
  async function fetchText(url) {
    const cached = recall(url, settings.cacheTtlMs);
    if (cached !== undefined) return cached;
    const text = htmlToText(await get(url));
    return text.length <= 1024 * 1024 ? remember(url, text) : text;
  }

  /**
   * Sucht die Filings der `windowDays` Tage vor dem Form 4 und liefert Auszüge.
   * @param {{issuerCik: string, filedAt?: string, transactionDate?: string, accessionNo?: string}} request
   */
  async function lookup(request = {}) {
    const started = now();
    const notes = [];
    const cik = String(request.issuerCik || '').replace(/\D/g, '');
    const filedDay = dayOf(request.filedAt) || new Date(now()).toISOString().slice(0, 10);
    const tradeDay = dayOf(request.transactionDate);
    const from = addDays(tradeDay && tradeDay < filedDay ? tradeDay : filedDay, -settings.windowDays);
    const result = { ok: false, configured: hasContact, window: { from, to: filedDay }, filings: [], notes };
    if (!cik) {
      notes.push('keine CIK des Unternehmens');
      return result;
    }

    let all;
    try {
      all = await listFilings(cik);
    } catch (err) {
      notes.push(`SEC-Verzeichnis: ${err.reason || err.message}`);
      return result;
    }
    result.ok = true;

    const candidates = all
      .filter((f) => f.filingDate >= from && f.filingDate <= filedDay && f.accessionNo !== request.accessionNo)
      .map((f) => ({ ...f, score: scoreFiling(f) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score || b.filingDate.localeCompare(a.filingDate))
      .slice(0, settings.maxFilings);
    if (candidates.length === 0) {
      notes.push(`kein passendes Filing zwischen ${from} und ${filedDay}`);
      return result;
    }

    let budget = settings.maxExcerptChars;
    let documentsRead = 0;
    for (const filing of candidates) {
      const folder = `${archivesBaseUrl}/Archives/edgar/data/${Number(cik)}/${filing.accessionNo.replace(/-/g, '')}`;
      const entry = {
        form: filing.form,
        filingDate: filing.filingDate,
        accessionNo: filing.accessionNo,
        items: filing.items,
        indexUrl: `${folder}/${filing.accessionNo}-index.htm`,
        documents: [],
      };
      result.filings.push(entry);
      if (!hasContact) continue;
      if (now() - started > settings.deadlineMs) {
        notes.push('Zeitlimit erreicht – weitere Dokumente nicht abgerufen');
        break;
      }

      let listed = recall(entry.indexUrl, settings.cacheTtlMs);
      try {
        if (!listed) listed = remember(entry.indexUrl, parseFilingIndex(await get(entry.indexUrl), archivesBaseUrl));
      } catch (err) {
        notes.push(`${filing.form} vom ${filing.filingDate}: Index ${err.reason || err.message}`);
        continue;
      }
      const isEightK = /^8-K/i.test(filing.form);
      const readable = listed.filter((d) => /\.(htm|html|txt)$/i.test(d.name));
      const primary = readable.find((d) => d.type === filing.form.toUpperCase())
        || readable.find((d) => d.name === filing.primaryDocument) || readable[0];
      const exhibits = isEightK
        ? readable.filter((d) => d !== primary && exhibitRank(d.type) > 0)
          .sort((a, b) => exhibitRank(a.type) - exhibitRank(b.type) || a.seq - b.seq)
          .slice(0, settings.maxExhibitsPerFiling)
        : [];

      for (const doc of [primary, ...exhibits].filter(Boolean)) {
        if (documentsRead >= settings.maxDocuments || budget <= 500) break;
        if (now() - started > settings.deadlineMs) {
          notes.push('Zeitlimit erreicht – weitere Dokumente nicht abgerufen');
          break;
        }
        if (doc.size && doc.size > settings.maxDocumentBytes) {
          notes.push(`${doc.type} (${filing.form} vom ${filing.filingDate}) übersprungen: ${Math.round(doc.size / 1048576)} MB`);
          continue;
        }
        let text;
        try {
          text = await fetchText(doc.url);
        } catch (err) {
          notes.push(`${doc.type} (${filing.form} vom ${filing.filingDate}): ${err.reason || err.message}`);
          continue;
        }
        documentsRead += 1;

        let excerpt;
        let truncated = false;
        if (doc === primary && isEightK) {
          const items = extractItems(text, Object.keys(ITEM_WEIGHTS));
          excerpt = items.map((section) => section.text).join('\n\n');
          if (!excerpt) ({ text: excerpt, truncated } = keywordWindows(text, Math.min(budget, 8000)));
        } else if (/^EX-99\b/.test(doc.type)) {
          // Pressemitteilung: Der Anfang fasst den Deal zusammen.
          const head = text.slice(0, 2500);
          const windows = keywordWindows(text.slice(2500), Math.min(budget, 3500));
          excerpt = [head, windows.text].filter(Boolean).join(' […] ');
          truncated = windows.truncated || text.length > 2500 + windows.text.length;
        } else {
          ({ text: excerpt, truncated } = keywordWindows(text, Math.min(budget, 6000)));
        }
        if (excerpt.length > budget) {
          excerpt = `${excerpt.slice(0, budget).trimEnd()} […gekürzt]`;
          truncated = true;
        }
        budget -= excerpt.length;
        entry.documents.push({ type: doc.type, description: doc.description, url: doc.url, chars: text.length, excerpt, truncated });
      }
    }

    if (!hasContact) {
      notes.push('Dokumente nicht abgerufen: SEC_USER_AGENT enthält keine E-Mail-Adresse (die SEC verlangt Name und E-Mail)');
    }
    log(`SEC-Kontext CIK ${cik}: ${result.filings.length} Filings, ${documentsRead} Dokumente, ${requests} Abrufe insgesamt`);
    return result;
  }

  return { lookup, hasContact, stats: () => ({ requests, cached: cache.size }) };
}

module.exports = { createSecContext, htmlToText, parseFilingIndex, extractItems, keywordWindows, scoreFiling };
