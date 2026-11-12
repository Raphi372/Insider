'use strict';

/** Was nach der Telegram-Nachricht geschah, je Nachricht (Schlüssel: Telegram-Nachrichten-ID). */
function decisionsByMessage(events) {
  const rank = { 'Order gesendet': 3, 'Order abgelehnt': 2, verworfen: 1 };
  const decisions = new Map();
  for (const event of events) {
    let decision = null;
    if (event.action === 'order') decision = event.placed ? 'Order gesendet' : 'Order abgelehnt';
    if (event.action === 'discard') decision = 'verworfen';
    if (!decision || event.telegramMessageId === null || event.telegramMessageId === undefined) continue;
    const key = String(event.telegramMessageId);
    if ((rank[decision] || 0) > (rank[decisions.get(key)] || 0)) decisions.set(key, decision);
  }
  return decisions;
}

module.exports = { decisionsByMessage };
