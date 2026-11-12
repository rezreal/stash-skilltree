import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNudgeTimer,
  gainFromMismatch,
  GAIN_EVENT,
  gazeNotFollowed,
  NUDGE_EVENT,
  onUnlessOff,
  sendToyGain,
  sendToyNudge,
} from "../../src/integrations/toysync.ts";

test("full on target, fading to off, script alone when nothing is judged", () => {
  assert.equal(gainFromMismatch(0), 1);
  assert.equal(gainFromMismatch(1), 0);
  assert.equal(gainFromMismatch(0.5), 0.5);
  assert.equal(gainFromMismatch(0.33), 0.65);
  assert.equal(gainFromMismatch(undefined), 1);
});

test("dispatches gain and nudge events with our source", () => {
  const seen: { type: string; detail: unknown }[] = [];
  const target = { dispatchEvent: (e: Event) => (seen.push({ type: e.type, detail: (e as CustomEvent).detail }), true) };
  sendToyGain(0.4, target);
  sendToyGain(null, target);
  sendToyNudge("gaze", target);
  assert.deepEqual(seen, [
    { type: GAIN_EVENT, detail: { source: "skilltree", gain: 0.4 } },
    { type: GAIN_EVENT, detail: { source: "skilltree", gain: null } },
    { type: NUDGE_EVENT, detail: { source: "skilltree", reason: "gaze" } },
  ]);
});

test("settings are on unless turned off", () => {
  assert.equal(onUnlessOff(undefined), true);
  assert.equal(onUnlessOff(false), false);
  assert.equal(onUnlessOff("false"), false);
});

test("nudge timer: after 1 s off, then every 5 s, starting over when back", () => {
  const t = createNudgeTimer(1000, 5000);
  assert.equal(t.update(true, 0), false);
  assert.equal(t.update(true, 900), false);
  assert.equal(t.update(true, 1000), true);
  assert.equal(t.update(true, 3000), false);
  assert.equal(t.update(true, 6000), true);
  assert.equal(t.update(false, 6500), false);
  assert.equal(t.update(true, 7000), false, "a new episode waits again");
  assert.equal(t.update(true, 8000), true);
});

test("gaze nudges only on real evidence", () => {
  const gaze = { attending: false, source: "gaze" as const, trackerDown: false };
  assert.equal(gazeNotFollowed({ reading: gaze }), true);
  assert.equal(gazeNotFollowed({ reading: { ...gaze, attending: true } }), false);
  assert.equal(gazeNotFollowed({ reading: { ...gaze, source: "fallback" } }), false, "focus/activity never nudges");
  assert.equal(gazeNotFollowed({ reading: { ...gaze, trackerDown: true } }), false);
  assert.equal(gazeNotFollowed({ reading: { ...gaze, background: true } }), false);
  // a gaze prompt decides while it runs: "off" is evidence, "unknown" is not
  assert.equal(gazeNotFollowed({ reading: { ...gaze, attending: true }, prompt: { state: "off" } }), true);
  assert.equal(gazeNotFollowed({ reading: gaze, prompt: { state: "unknown" } }), false);
  assert.equal(gazeNotFollowed({ reading: gaze, prompt: { state: "on" } }), false);
});
