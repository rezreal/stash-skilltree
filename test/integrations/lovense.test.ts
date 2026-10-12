import { test } from "node:test";
import assert from "node:assert/strict";
import { gainFromMismatch, LOVENSE_GAIN_EVENT, lovenseGateEnabled, sendLovenseGain } from "../../src/integrations/lovense.ts";

test("full on target, fading to off, script alone when nothing is judged", () => {
  assert.equal(gainFromMismatch(0), 1);
  assert.equal(gainFromMismatch(1), 0);
  assert.equal(gainFromMismatch(0.5), 0.5);
  assert.equal(gainFromMismatch(0.33), 0.65);
  assert.equal(gainFromMismatch(undefined), 1);
  assert.equal(gainFromMismatch(3), 0);
});

test("dispatches the gain event with our source", () => {
  const seen: { type: string; detail: unknown }[] = [];
  sendLovenseGain(0.4, { dispatchEvent: (e) => (seen.push({ type: e.type, detail: (e as CustomEvent).detail }), true) });
  sendLovenseGain(null, { dispatchEvent: (e) => (seen.push({ type: e.type, detail: (e as CustomEvent).detail }), true) });
  assert.deepEqual(seen, [
    { type: LOVENSE_GAIN_EVENT, detail: { source: "skilltree", gain: 0.4 } },
    { type: LOVENSE_GAIN_EVENT, detail: { source: "skilltree", gain: null } },
  ]);
});

test("the gate setting is on unless turned off", () => {
  assert.equal(lovenseGateEnabled(undefined), true);
  assert.equal(lovenseGateEnabled(true), true);
  assert.equal(lovenseGateEnabled(false), false);
  assert.equal(lovenseGateEnabled("false"), false);
});
