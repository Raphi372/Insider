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

if [ "$status" -ne 0 ]; then
  echo "--- Test fehlgeschlagen, Logs der Dienste ---"
  compose logs --no-color --tail=150 n8n-init n8n bridge mock || true
fi
exit "$status"
