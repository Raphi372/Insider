#!/bin/sh
# Richtet n8n vor dem Start ein:
#   1. legt die Zugangsdaten aus der .env als verschlüsselte n8n-Credentials an
#      (bei jedem Start – so greifen geänderte Schlüssel nach "docker compose up -d"),
#   2. importiert den Workflow, falls er noch nicht existiert,
#   3. veröffentlicht (aktiviert) ihn.
#
# Ein bereits vorhandener Workflow wird nicht überschrieben, damit Änderungen
# aus der n8n-Oberfläche erhalten bleiben. Neu einspielen:
#   WORKFLOW_IMPORT=force docker compose up n8n-init
set -eu

WORKFLOW_ID="insiderPipeline1"
WORKFLOW_FILE="/opt/insider/workflows/insider-pipeline.json"

missing=""
for name in SEC_API_KEY ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN BRIDGE_SECRET; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then missing="$missing $name"; fi
done
if [ -n "$missing" ]; then
  echo "FEHLER: In der .env fehlen Werte für:$missing" >&2
  exit 1
fi

echo "[init] Lege Zugangsdaten in n8n an ..."
umask 077
CREDENTIALS_FILE="$(mktemp)"
trap 'rm -f "$CREDENTIALS_FILE"' EXIT

# Die IDs sind fest, damit der Workflow die Credentials ohne Handarbeit findet.
node -e '
  const env = process.env;
  process.stdout.write(JSON.stringify([
    { id: "insiderSecApi001", name: "sec-api.io (API-Key)", type: "httpQueryAuth",
      data: { name: "token", value: env.SEC_API_KEY } },
    { id: "insiderAnthropic", name: "Anthropic (API-Key)", type: "anthropicApi",
      data: { apiKey: env.ANTHROPIC_API_KEY, url: env.ANTHROPIC_BASE_URL || "https://api.anthropic.com" } },
    { id: "insiderTelegram1", name: "Telegram Bot", type: "telegramApi",
      data: { accessToken: env.TELEGRAM_BOT_TOKEN, baseUrl: env.TELEGRAM_BASE_URL || "https://api.telegram.org" } },
    { id: "insiderBridge001", name: "Bridge (X-Bridge-Token)", type: "httpHeaderAuth",
      data: { name: "X-Bridge-Token", value: env.BRIDGE_SECRET } },
  ]));
' > "$CREDENTIALS_FILE"
n8n import:credentials --input="$CREDENTIALS_FILE"

if [ "${WORKFLOW_IMPORT:-}" != "force" ] && n8n list:workflow --onlyId | grep -qx "$WORKFLOW_ID"; then
  echo "[init] Workflow ist bereits vorhanden – Import übersprungen."
else
  echo "[init] Importiere Workflow ..."
  n8n import:workflow --input="$WORKFLOW_FILE"
fi

echo "[init] Veröffentliche Workflow ..."
n8n publish:workflow --id="$WORKFLOW_ID"

echo "[init] Fertig."
