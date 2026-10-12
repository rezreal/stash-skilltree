import { test } from "node:test";
import assert from "node:assert/strict";
import type { GazeStatus } from "../../src/gaze/types.ts";
import {
  INITIAL_READING,
  OFF_HINT,
  TOBII_HINT,
  attentionSourceLabel,
  chooseAttention,
  gazeChipView,
  gazeSensorView,
  gazeSettings,
  graceText,
  pauseReasonText,
  presenceText,
  rateText,
  sameReading,
  sourceTitle,
  type AttentionReading,
} from "../../src/player/gazeView.ts";

const gazeReading = (reason: AttentionReading["reason"], attending = false): AttentionReading => ({
  attending,
  source: "gaze",
  reason,
  insideShare: 0,
  trackerDown: false,
});

test("gazeSettings accepts off, tobii and mouse; anything else is off", () => {
  assert.deepEqual(gazeSettings({}), { source: "off" });
  assert.deepEqual(gazeSettings({ gazeSource: "tobii" }), { source: "tobii" });
  assert.deepEqual(gazeSettings({ gazeSource: " Mouse " }), { source: "mouse" });
  assert.deepEqual(gazeSettings({ gazeSource: "websocket" }), { source: "off" });
  assert.deepEqual(gazeSettings({ gazeSource: "webxr" }), { source: "off" });
  assert.deepEqual(gazeSettings({ gazeSource: 3 }), { source: "off" });
});

test("sourceTitle names the source", () => {
  assert.equal(sourceTitle("tobii"), "Eye tracker (Tobii)");
  assert.equal(sourceTitle("mouse"), "Mouse as gaze (testing)");
});

test("chooseAttention: gaze decides while connected, the fallback otherwise", () => {
  const verdict = { attending: false, reason: "outside" as const, insideShare: 0.2 };
  assert.deepEqual(chooseAttention({ selected: true, connection: "connected", gaze: verdict, fallback: true }), {
    attending: false,
    source: "gaze",
    reason: "outside",
    insideShare: 0.2,
    trackerDown: false,
  });
  // lost mid-session: the fallback stands in and the panel says so
  assert.deepEqual(chooseAttention({ selected: true, connection: "disconnected", fallback: true }), {
    attending: true,
    source: "fallback",
    trackerDown: true,
  });
  assert.deepEqual(chooseAttention({ selected: true, connection: "error", gaze: verdict, fallback: false }), {
    attending: false,
    source: "fallback",
    trackerDown: true,
  });
  // off
  assert.deepEqual(chooseAttention({ selected: false, fallback: true }), { attending: true, source: "fallback", trackerDown: false });
  // connected but no target element yet
  assert.equal(chooseAttention({ selected: true, connection: "connected", fallback: false }).source, "fallback");
});

test("sameReading ignores insideShare", () => {
  assert.equal(sameReading({ ...gazeReading("inside", true), insideShare: 0.9 }, { ...gazeReading("inside", true), insideShare: 0.7 }), true);
  assert.equal(sameReading(gazeReading("inside", true), gazeReading("outside", true)), false);
  assert.equal(sameReading(INITIAL_READING, { ...INITIAL_READING, trackerDown: true }), false);
});

test("pause and grace texts say why", () => {
  assert.equal(pauseReasonText(gazeReading("outside")).title, "Paused: you looked away");
  assert.equal(pauseReasonText(gazeReading("no-gaze")).title, "Paused: eyes not tracked");
  assert.equal(pauseReasonText(gazeReading("blink")).title, "Paused: eyes not tracked");
  assert.equal(pauseReasonText(gazeReading("stale")).title, "Paused: tracker stalled");
  assert.deepEqual(pauseReasonText(INITIAL_READING), {
    title: "Paused: you looked away",
    hint: "Come back to the video to continue.",
  });
  assert.equal(graceText(gazeReading("outside")), "Look back at the video");
  assert.equal(graceText(gazeReading("no-gaze")), "Eyes not tracked");
  assert.equal(graceText(gazeReading("stale")), "Eye tracker stalled");
  assert.equal(graceText(INITIAL_READING), "Look back at the video");
});

test("gazeChipView: off, connected (calibrated or not), disconnected, error", () => {
  assert.deepEqual(gazeChipView({ source: "off" }, undefined, false), {
    label: "Eye tracker off",
    tone: "muted",
    action: "hint",
    canConnect: false,
    hint: OFF_HINT,
  });
  const connected: GazeStatus = { kind: "tobii", connection: "connected" };
  assert.deepEqual(gazeChipView({ source: "tobii" }, connected, true), {
    label: "Eye tracker connected",
    tone: "blue",
    action: "calibrate",
    canConnect: false,
  });
  const uncal = gazeChipView({ source: "tobii" }, connected, false);
  assert.equal(uncal.label, "Eye tracker connected · calibrate");
  assert.equal(uncal.tone, "orange");

  const down = gazeChipView({ source: "tobii" }, { kind: "tobii", connection: "disconnected" }, false);
  assert.equal(down.label, "Eye tracker disconnected");
  assert.equal(down.action, "hint");
  assert.equal(down.canConnect, true);
  assert.equal(down.hint, TOBII_HINT);
  assert.match(TOBII_HINT, /Tobii Service and Tobii Experience/);
  assert.match(TOBII_HINT, /Chrome or Edge/);

  const err = gazeChipView({ source: "tobii" }, { kind: "tobii", connection: "error", message: "No eye tracker chosen." }, false);
  assert.equal(err.tone, "red");
  assert.equal(err.hint, `No eye tracker chosen. ${TOBII_HINT}`);

  const connecting = gazeChipView({ source: "tobii" }, { kind: "tobii", connection: "connecting" }, false);
  assert.equal(connecting.label, "Eye tracker connecting…");
  assert.equal(connecting.canConnect, false);

  assert.equal(gazeChipView({ source: "mouse" }, { kind: "mouse", connection: "connected" }, true).label, "Mouse gaze connected");
});

test("sensor rows: connection, rate, presence, last verdict", () => {
  assert.equal(rateText(61.6), "62 Hz");
  assert.equal(rateText(undefined), "—");
  assert.equal(presenceText({ present: true, tracking: true }), "present");
  assert.equal(presenceText({ present: false }), "no one in front");
  assert.equal(presenceText({ present: true, tracking: false }), "eyes not found");
  assert.equal(presenceText({}), "—");

  const status: GazeStatus = { kind: "tobii", connection: "connected", present: true, tracking: true, rate: 89.7 };
  assert.deepEqual(gazeSensorView(status, gazeReading("inside", true)), {
    title: "Eye tracker (Tobii)",
    connection: "connected",
    connectionTone: "blue",
    rate: "90 Hz",
    presence: "present",
    reason: "on the video",
  });
  assert.equal(gazeSensorView(status, gazeReading("inside", true), 30).rate, "30 Hz");
  const lost = gazeSensorView({ kind: "tobii", connection: "disconnected", message: "The eye tracker was unplugged." }, INITIAL_READING);
  assert.equal(lost.connection, "disconnected · The eye tracker was unplugged.");
  assert.equal(lost.connectionTone, "orange");
  assert.equal(lost.rate, "—");
  assert.equal(lost.reason, "—");
});

test("attentionSourceLabel", () => {
  assert.equal(attentionSourceLabel(gazeReading("inside", true)), "Attention: eye tracker");
  assert.equal(attentionSourceLabel(INITIAL_READING), "Attention: fallback (focus + activity)");
  assert.equal(attentionSourceLabel({ ...INITIAL_READING, trackerDown: true }), "Attention: fallback · tracker not connected");
});

test("with gaze, a hidden or unfocused window doesn't count unless fullscreen", () => {
  const gaze = { attending: true, reason: "inside" as const, insideShare: 1 };
  const base = { selected: true, connection: "connected" as const, gaze, fallback: true };
  const front = chooseAttention({ ...base, page: { visible: true, focused: true, fullscreen: false } });
  assert.equal(front.attending, true);
  assert.equal(front.background, undefined);
  const behind = chooseAttention({ ...base, page: { visible: true, focused: false, fullscreen: false } });
  assert.equal(behind.attending, false);
  assert.equal(behind.background, true);
  assert.match(pauseReasonText(behind).title, /background/);
  assert.match(graceText(behind), /background/);
  assert.equal(chooseAttention({ ...base, page: { visible: false, focused: true, fullscreen: true } }).attending, false, "hidden tab");
  assert.equal(chooseAttention({ ...base, page: { visible: true, focused: false, fullscreen: true } }).attending, true, "fullscreen");
});
