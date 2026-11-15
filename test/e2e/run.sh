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

expect() { # expect "<Ausgabe>" "<erwarteter Text oder Muster>"
  if ! printf '%s\n' "$1" | grep -q -- "$2"; then
    echo "FEHLT in der Ausgabe: $2"
    status=1
  fi
}

# Stand der Datenbank nach den Szenarien: vierzehn Meldungen aus dem Stream.
if [ "$status" -eq 0 ]; then
  echo "--- research stats ---"
  stats=$(compose run --rm research stats) || status=$?
  printf '%s\n' "$stats"
  expect "$stats" "Meldungen (Form 4): *14$"
  expect "$stats" "mit Käufen (Code P): *10$"
  expect "$stats" "mit Verkäufen (Code S): *3$"
  expect "$stats" "14 aus dem Stream, 0 nachgeladen"
fi

# Ausfall der Datenbank: Der Dienst wird gestoppt, die Pipeline muss weiterlaufen.
if [ "$status" -eq 0 ]; then
  echo "--- Ausfall der Datenbank ---"
  compose stop journal
  compose run --rm --no-deps e2e node --test /e2e/outage.test.js || status=$?
  compose start journal
fi

# Nachladen: Die elf Käufe der Testdaten kommen über sec-api (Mock); zehn sind
# schon gespeichert, der elfte ist der Kauf aus dem Ausfall-Test.
if [ "$status" -eq 0 ]; then
  echo "--- research backfill ---"
  backfill=$(compose run --rm research backfill --days 30 --to 2026-11-30) || status=$?
  printf '%s\n' "$backfill"
  expect "$backfill" "11 Insiderkäufe von 2026-10-31 bis 2026-11-30 geladen, davon 1 neu in der Datenbank"
  stats=$(compose run --rm research stats) || status=$?
  printf '%s\n' "$stats"
  expect "$stats" "Meldungen (Form 4): *15$"
  expect "$stats" "14 aus dem Stream, 1 nachgeladen"
fi

# Auswertung und Backtest laufen im selben Stack gegen die Mock-Daten.
if [ "$status" -eq 0 ]; then
  echo "--- research report ---"
  report=$(compose run --rm research report) || status=$?
  printf '%s\n' "$report"
  expect "$report" "8 Signale protokolliert, 8 mit Kursdaten"
  expect "$report" "| STARK "
  expect "$report" "| Order gesendet "
  expect "$report" "| Cluster (mehrere Insider) "
  expect "$report" "| Einzelkauf "
fi
if [ "$status" -eq 0 ]; then
  echo "--- research backtest ---"
  backtest=$(compose run --rm research backtest --from 2026-11-01 --to 2026-11-30 --lookback-years 0) || status=$?
  printf '%s\n' "$backtest" | head -40
  expect "$backtest" "Offenmarktkauf (Code P), Kaufwert ab 25.000 "
  expect "$backtest" "Insiderkäufe im Zeitraum (alle Größen): 11"
  expect "$backtest" "davon über dem Filter: 9"
  expect "$backtest" "auswertbar: 9"
  expect "$backtest" "| 20 Handelstage "
fi

# Ohne Finnhub-Schlüssel muss alles laufen wie bisher (nur Yahoo). Dafür startet
# n8n mit leerem Schlüssel neu; die Bridge und die übrigen Dienste laufen weiter.
if [ "$status" -eq 0 ]; then
  echo "--- ohne Finnhub-Schlüssel ---"
  FINNHUB_API_KEY=""
  export FINNHUB_API_KEY
  compose up -d n8n || status=$?
  if [ "$status" -eq 0 ]; then compose run --rm --no-deps e2e node --test --test-concurrency=1 /e2e/nokey.test.js || status=$?; fi
fi

if [ "$status" -ne 0 ]; then
  echo "--- Test fehlgeschlagen, Logs der Dienste ---"
  compose logs --no-color --tail=150 n8n-init n8n bridge mock journal || true
fi
exit "$status"
