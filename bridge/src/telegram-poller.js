'use strict';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Holt Button-Klicks (callback_query) per Long Polling von Telegram ab.
 *
 * Der Telegram-Trigger von n8n braucht eine aus dem Internet erreichbare
 * HTTPS-Adresse. Ein lokal laufendes n8n hat die nicht – Long Polling
 * funktioniert dagegen auch hinter NAT und ohne Tunnel.
 */
class TelegramPoller {
  constructor(options) {
    const {
      baseUrl,
      token,
      chatId,
      onCallback,
      log,
      fetchImpl = fetch,
      sleep = defaultSleep,
      longPollSeconds = 50,
      minBackoffMs = 2000,
      maxBackoffMs = 60000,
    } = options;

    this.baseUrl = baseUrl;
    this.token = token;
    this.chatId = String(chatId);
    this.onCallback = onCallback;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.longPollSeconds = longPollSeconds;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;

    this.offset = 0;
    this.stopped = false;
    this.abortController = null;
  }

  async api(method, body, timeoutMs = 15000) {
    this.abortController = new AbortController();
    const timeout = setTimeout(() => this.abortController.abort(), timeoutMs);
    try {
      // Der Bot-Token steht im Pfad – die URL wird deshalb nie geloggt.
      const response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.ok === false) {
        const err = new Error(`Telegram ${method}: ${json.description || `HTTP ${response.status}`}`);
        err.status = response.status;
        throw err;
      }
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async start() {
    this.stopped = false;
    let backoffMs = this.minBackoffMs;
    this.log.info('Telegram-Polling für Button-Klicks gestartet');

    while (!this.stopped) {
      try {
        const updates = await this.api(
          'getUpdates',
          { offset: this.offset, timeout: this.longPollSeconds, allowed_updates: ['callback_query'] },
          (this.longPollSeconds + 10) * 1000,
        );
        backoffMs = this.minBackoffMs;

        for (const update of updates || []) {
          // Offset zuerst erhöhen: Ein Update, dessen Verarbeitung scheitert,
          // darf die Schleife nicht dauerhaft blockieren.
          this.offset = update.update_id + 1;
          if (update.callback_query) await this._handleCallback(update);
        }
      } catch (err) {
        if (this.stopped) break;
        let hint = '';
        if (err.status === 409) hint = ' – für diesen Bot ist ein Webhook gesetzt oder ein zweiter Prozess pollt bereits';
        if (err.status === 401 || err.status === 404) hint = ' – TELEGRAM_BOT_TOKEN prüfen';
        this.log.warn(`${err.message}${hint}; neuer Versuch in ${backoffMs} ms`);
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.abortController) this.abortController.abort();
  }

  async _handleCallback(update) {
    const query = update.callback_query;
    const fromId = String(query.from && query.from.id);

    try {
      if (fromId !== this.chatId) {
        this.log.warn(`Button-Klick von fremder Telegram-ID ${fromId} abgelehnt`);
        await this.api('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'Nicht berechtigt.',
          show_alert: true,
        });
        return;
      }

      const result = await this.onCallback(update);

      if (!result.ok) {
        this.log.error(`Button-Klick konnte nicht an n8n übergeben werden (${result.error})`);
        await this.api('answerCallbackQuery', {
          callback_query_id: query.id,
          text: 'n8n ist gerade nicht erreichbar. Bitte gleich noch einmal tippen.',
          show_alert: true,
        });
        return;
      }

      await this.api('answerCallbackQuery', { callback_query_id: query.id, text: 'Wird verarbeitet …' });

      // Buttons entfernen, damit dieselbe Order nicht zweimal ausgelöst wird.
      if (query.message && query.message.chat) {
        await this.api('editMessageReplyMarkup', {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [] },
        });
      }
    } catch (err) {
      this.log.warn(`Button-Klick ${query.id}: ${err.message}`);
    }
  }
}

module.exports = { TelegramPoller };
