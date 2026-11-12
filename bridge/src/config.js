'use strict';

const REQUIRED = ['SEC_API_KEY', 'BRIDGE_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

function trimSlashes(url) {
  return String(url).replace(/\/+$/, '');
}

/**
 * Liest die Konfiguration aus Umgebungsvariablen.
 * Wirft einen Fehler mit allen fehlenden Pflichtvariablen auf einmal,
 * damit man die .env nicht Variable für Variable nachbessern muss.
 */
function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((name) => !String(env[name] || '').trim());
  if (missing.length > 0) {
    throw new Error(`Fehlende Umgebungsvariablen: ${missing.join(', ')} (siehe .env.example)`);
  }

  const formTypes = String(env.FORM_TYPES || '4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    secApiKey: env.SEC_API_KEY.trim(),
    secStreamUrl: trimSlashes(env.SEC_STREAM_URL || 'wss://stream.sec-api.io'),
    secApiBaseUrl: trimSlashes(env.SEC_API_BASE_URL || 'https://api.sec-api.io'),
    minPurchaseValueUsd: Number(env.MIN_PURCHASE_VALUE_USD || 25000),
    formTypes,
    n8nWebhookBaseUrl: trimSlashes(env.N8N_WEBHOOK_BASE_URL || 'http://n8n:5678/webhook'),
    bridgeSecret: env.BRIDGE_SECRET.trim(),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN.trim(),
    telegramChatId: env.TELEGRAM_CHAT_ID.trim(),
    telegramBaseUrl: trimSlashes(env.TELEGRAM_BASE_URL || 'https://api.telegram.org'),
  };
}

module.exports = { loadConfig };
