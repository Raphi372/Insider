'use strict';

// Läuft nach den Szenarien, während der Dienst "journal" (Datenbank und
// Signal-Protokoll) gestoppt ist – siehe run.sh. Ein Ausfall darf kein Signal
// kosten, muss aber auffallen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { streamFiling } = require('./fixtures');
const { JOURNAL, control, emit, waitForMessages, buttons, bridgeConnected } = require('./helpers');

test.before(async () => {
  await bridgeConnected();
  await control('reset', {});
  await assert.rejects(
    fetch(`${JOURNAL}/healthz`, { signal: AbortSignal.timeout(5000) }),
    'für diesen Test muss der Dienst "journal" gestoppt sein',
  );
});

test('Fällt die Datenbank aus, kommt das Signal trotzdem – und der Ausfall wird per Telegram gemeldet', async () => {
  await emit(streamFiling('0001000000-26-000008'));

  const [signal, failure] = await waitForMessages(2, 180000);

  // Die Meldung kommt vollständig an und sagt offen, was sie nicht prüfen konnte.
  assert.match(signal.body.text, /<b>Insiderkauf REJ<\/b> – Signal: <b>STARK<\/b>/);
  assert.match(signal.body.text, /<b>Cluster:<\/b> nicht geprüft – Datenbank nicht erreichbar/);
  assert.equal(buttons(signal)[0].callback_data, 'o|REJ|444|490|10.2|9.38|11.73');

  // Das Signal konnte nicht protokolliert werden – das fällt über den Error Trigger auf.
  assert.match(failure.body.text, /^FEHLER IM WORKFLOW: .+ beim Node Signal_Log\./s);
});
