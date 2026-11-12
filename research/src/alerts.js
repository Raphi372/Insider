'use strict';

const { decisionsByMessage } = require('./decisions');

const DAY_MS = 86400000;

/**
 * Sucht das jüngste gemeldete Kaufsignal desselben Insiders beim selben
 * Unternehmen, das vor dem Verkauf lag.
 *
 *   scope 'orders'  – nur Signale, zu denen du die Order gesendet hast
 *   scope 'signals' – alle gemeldeten Signale
 */
function findFollowedSignal(signals, events, { issuerCik, insiderCik, filedAt, scope = 'orders', lookbackDays = 365 }) {
  const saleTime = Date.parse(filedAt);
  const sameInsider = signals.filter((entry) => entry.form4
    && String(entry.form4.issuerCik) === String(issuerCik)
    && String(entry.form4.insiderCik) === String(insiderCik));
  if (sameInsider.length === 0) return null; // der Normalfall: zu diesem Insider wurde nie ein Kauf gemeldet

  const decisions = decisionsByMessage(events);
  const candidates = sameInsider
    .map((entry) => ({
      entry,
      time: Date.parse(entry.form4.filedAt),
      orderSent: decisions.get(String(entry.telegramMessageId)) === 'Order gesendet',
    }))
    .filter((c) => c.time < saleTime && saleTime - c.time <= lookbackDays * DAY_MS)
    .filter((c) => scope === 'signals' || c.orderSent)
    .sort((a, b) => b.time - a.time);

  if (candidates.length === 0) return null;
  const { entry, orderSent } = candidates[0];
  return {
    accessionNo: entry.accessionNo,
    filedAt: entry.form4.filedAt,
    shares: entry.form4.purchase.shares,
    value: entry.form4.purchase.value,
    avgPrice: entry.form4.purchase.avgPrice,
    rating: entry.rating || null,
    orderSent,
  };
}

/**
 * Verkaufswarnung: Ein Insider, dessen Kauf gemeldet wurde, verkauft am Markt.
 * Liefert `null`, wenn die Meldung keinen Verkauf enthält, kein passendes
 * Signal im Protokoll steht oder die Warnung abgeschaltet ist (scope 'off').
 */
function buildSellAlert(signal, journal, options = {}) {
  const sale = signal.sale || {};
  if (options.scope === 'off' || !(sale.shares > 0)) return null;

  const followed = findFollowedSignal(journal.readSignals(), journal.readEvents(), {
    issuerCik: signal.issuerCik,
    insiderCik: signal.insiderCik,
    filedAt: signal.filedAt,
    scope: options.scope,
    lookbackDays: options.lookbackDays,
  });
  if (!followed) return null;

  return {
    accessionNo: signal.accessionNo,
    filedAt: signal.filedAt,
    ticker: signal.ticker,
    issuerName: signal.issuerName,
    insiderName: signal.insiderName,
    role: signal.role,
    sale,
    mentions10b51: Boolean(signal.mentions10b51),
    link: signal.link || null,
    followed,
  };
}

module.exports = { findFollowedSignal, buildSellAlert };
