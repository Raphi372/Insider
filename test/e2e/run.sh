#!/bin/sh
# End-to-End-Test: startet n8n, Bridge und einen Mock aller externen Dienste
# in Docker und spielt die Szenarien aus scenarios.test.js durch.
# Es werden keine echten Zugangsdaten gebraucht und keine echten APIs aufgerufen.
#
# Mit KEEP=1 bleibt der Stack danach stehen (n8n unter http://localhost:5678),
# z. B. um eine fehlgeschlagene Ausführung in der Oberfläche anzusehen.
set -eu
cd "$(dirname "$0")/../.."

# Compose bevorzugt Variablen aus der Shell vor denen aus der env-Datei. Damit
# ein exportierter ANTHROPIC_API_KEY o. Ä. nicht in den Test gerät, gelten hier
# ausdrücklich die Testwerte.
set -a
. test/e2e/e2e.env
set +a

compose() {
  docker compose -p insider-e2e --env-file test/e2e/e2e.env \
    -f docker-compose.yml -f test/e2e/docker-compose.e2e.yml "$@"
}

cleanup() {
  if [ "${KEEP:-}" != "1" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
compose down -v --remove-orphans >/dev/null 2>&1 || true

# E2E_UP_FLAGS=--no-build überspringt den Build, wenn die Images schon existieren.
status=0
compose up -d ${E2E_UP_FLAGS:---build} n8n bridge mock || status=$?
if [ "$status" -eq 0 ]; then compose run --rm e2e || status=$?; fi

# Auswertung und Backtest laufen im selben Stack gegen die Mock-Daten.
expect() { # expect "<Ausgabe>" "<erwarteter Text>"
  if ! printf '%s\n' "$1" | grep -q -- "$2"; then
    echo "FEHLT in der Ausgabe: $2"
    status=1
  fi
}
if [ "$status" -eq 0 ]; then
  echo "--- research report ---"
  report=$(compose run --rm research report) || status=$?
  printf '%s\n' "$report"
  expect "$report" "4 Signale protokolliert, 4 mit Kursdaten"
  expect "$report" "| STARK "
  expect "$report" "| Order gesendet "
fi
if [ "$status" -eq 0 ]; then
  echo "--- research backtest ---"
  backtest=$(compose run --rm research backtest --from 2026-11-01 --to 2026-11-30 --lookback-years 0) || status=$?
  printf '%s\n' "$backtest" | head -40
  expect "$backtest" "Insiderkäufe im Zeitraum (alle Größen): 6"
  expect "$backtest" "auswertbar: 5"
  expect "$backtest" "| 20 Handelstage "
fi

if [ "$status" -ne 0 ]; then
  echo "--- Test fehlgeschlagen, Logs der Dienste ---"
  compose logs --no-color --tail=150 n8n-init n8n bridge mock || true
fi
exit "$status"
