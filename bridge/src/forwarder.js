'use strict';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sendet JSON per POST an einen n8n-Webhook.
 *
 * Wiederholt bei Netzwerkfehlern, 5xx und 404 (n8n startet noch bzw. der
 * Workflow ist noch nicht veröffentlicht). Andere 4xx-Antworten – z. B. 403
 * bei falschem BRIDGE_SECRET – werden nicht wiederholt, weil ein erneuter
 * Versuch daran nichts ändert.
 *
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
async function postJson(url, payload, options = {}) {
  const {
    headers = {},
    attempts = 5,
    baseDelayMs = 1000,
    timeoutMs = 15000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    log,
  } = options;

  let last = { ok: false, status: 0, error: 'nicht versucht' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Body verwerfen, damit die Verbindung wiederverwendet werden kann.
      await response.arrayBuffer().catch(() => undefined);

      if (response.ok) return { ok: true, status: response.status };

      last = { ok: false, status: response.status, error: `HTTP ${response.status}` };
      const retryable = response.status >= 500 || response.status === 404;
      if (!retryable) return last;
    } catch (err) {
      last = { ok: false, status: 0, error: err.message };
    }

    if (attempt < attempts) {
      const delay = baseDelayMs * 2 ** (attempt - 1);
      if (log) log.warn(`Weiterleitung an n8n fehlgeschlagen (${last.error}), Versuch ${attempt}/${attempts} – neuer Versuch in ${delay} ms`);
      await sleep(delay);
    }
  }

  return last;
}

module.exports = { postJson };
