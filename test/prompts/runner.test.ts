import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPromptRunner, replayAllowed } from "../../src/prompts/runner.ts";
import type { PromptRunner } from "../../src/prompts/runner.ts";
import type { PromptEvents, PromptSpec } from "../../src/prompts/types.ts";
import { BOX, STANDING, frame, pose, spec } from "./fixtures.ts";

const STEP = 50; // ms

/** plays video from..to seconds in real time (nowMs = videoTime * 1000 + offset), calling feed each tick */
function play(
  r: PromptRunner,
  from: number,
  to: number,
  feed?: (vt: number, nowMs: number) => void,
  offsetMs = 0,
): PromptEvents {
  const out: PromptEvents = { results: [], requests: [] };
  for (let ms = from * 1000; ms <= to * 1000 + 1e-6; ms += STEP) {
    const vt = ms / 1000;
    const nowMs = ms + offsetMs;
    feed?.(vt, nowMs);
    const e = r.update({ videoTime: vt, nowMs });
    out.results.push(...e.results);
    out.requests.push(...e.requests);
  }
  return out;
}

const centre = (r: PromptRunner) => (_vt: number, nowMs: number) => r.feedGaze({ t: nowMs, point: { x: 500, y: 500 }, valid: true });
const away = (r: PromptRunner) => (_vt: number, nowMs: number) => r.feedGaze({ t: nowMs, point: { x: 50, y: 300 }, valid: true });
const phase = (r: PromptRunner, id = "m1") => r.progress().find((p) => p.spec.markerId === id)!;

const GAZE: PromptSpec = spec({ markerId: "m1", check: "gaze", target: "screen_center", start: 10, end: 15, holdSec: 2 });

describe("createPromptRunner", () => {
  it("upcoming -> active -> passed, with the result at window end", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    assert.equal(play(r, 9, 9.95).results.length, 0);
    assert.equal(phase(r).phase, "upcoming");
    const e = play(r, 10, 14.9, centre(r));
    assert.equal(e.results.length, 0);
    assert.equal(phase(r).phase, "active");
    assert.equal(phase(r).progress, 1);
    const end = play(r, 15, 15);
    assert.deepEqual(end, { results: [{ markerId: "m1", passed: true }], requests: [] });
    assert.equal(phase(r).phase, "passed");
  });

  it("failing asks for one replay, then fails for good", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    let e = play(r, 9, 15, away(r));
    assert.deepEqual(e, { results: [], requests: [{ type: "seek", to: 9 }] });
    assert.equal(phase(r).phase, "replaying");
    assert.equal(phase(r).replays, 1);
    // the player seeks back; the window re-runs with a fresh checker
    e = play(r, 9, 15, away(r), 100_000);
    assert.deepEqual(e, { results: [{ markerId: "m1", passed: false }], requests: [] });
    assert.equal(phase(r).phase, "failed");
    assert.equal(phase(r).replays, 1);
  });

  it("can pass on the replay", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    play(r, 9, 15, away(r));
    const e = play(r, 9, 15, centre(r), 100_000);
    assert.deepEqual(e.results, [{ markerId: "m1", passed: true }]);
  });

  it("replays: 0 fails straight away", () => {
    const r = createPromptRunner([GAZE], { replays: 0 });
    r.setVideoBox(BOX);
    assert.deepEqual(play(r, 9, 15, away(r)), { results: [{ markerId: "m1", passed: false }], requests: [] });
  });

  it("long windows only count; a marker's replay tag overrides either way", () => {
    assert.equal(replayAllowed({ start: 10, end: 20 }), true); // exactly 10 s: replays
    assert.equal(replayAllowed({ start: 10, end: 20.5 }), false);
    assert.equal(replayAllowed({ start: 10, end: 300, replay: true }), true);
    assert.equal(replayAllowed({ start: 10, end: 15, replay: false }), false);

    const long = spec({ markerId: "m1", check: "gaze", target: "screen_center", start: 10, end: 25, holdSec: 2 });
    let r = createPromptRunner([long]);
    r.setVideoBox(BOX);
    assert.deepEqual(play(r, 9, 25, away(r)), { results: [{ markerId: "m1", passed: false }], requests: [] });
    assert.equal(phase(r).replays, 0);

    r = createPromptRunner([{ ...long, replay: true }]);
    r.setVideoBox(BOX);
    assert.deepEqual(play(r, 9, 25, away(r)), { results: [], requests: [{ type: "seek", to: 9 }] });

    r = createPromptRunner([{ ...GAZE, replay: false }]);
    r.setVideoBox(BOX);
    assert.deepEqual(play(r, 9, 15, away(r)), { results: [{ markerId: "m1", passed: false }], requests: [] });
  });

  it("seeking back before an active window is not a replay", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    play(r, 10, 11.5, centre(r));
    assert.equal(phase(r).phase, "active");
    play(r, 5, 5); // manual seek back
    assert.equal(phase(r).phase, "upcoming");
    assert.equal(phase(r).replays, 0);
    assert.equal(phase(r).progress, 0);
    const e = play(r, 9, 15, away(r), 50_000);
    assert.deepEqual(e.requests, [{ type: "seek", to: 9 }]); // the replay is still available
  });

  it("jumping over a whole window fails it without a replay", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    play(r, 5, 5);
    const e = r.update({ videoTime: 20, nowMs: 6000 });
    assert.deepEqual(e, { results: [{ markerId: "m1", passed: false }], requests: [] });
    assert.equal(phase(r).phase, "failed");
    assert.equal(phase(r).detail, "skipped");
  });

  it("seeking forward out of an active window evaluates what was collected", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    play(r, 10, 12.5, centre(r));
    const e = r.update({ videoTime: 30, nowMs: 13_000 });
    assert.deepEqual(e.results, [{ markerId: "m1", passed: true }]);
  });

  it("an ignored replay request fails after the grace", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    play(r, 9, 15, away(r));
    assert.equal(play(r, 15.05, 18).results.length, 0);
    assert.deepEqual(play(r, 18.05, 18.2).results, [{ markerId: "m1", passed: false }]);
  });

  it("finish evaluates active windows without a replay and fails replaying ones", () => {
    const a = spec({ markerId: "a", check: "gaze", target: "screen_center", start: 0, end: 5 });
    const b = spec({ markerId: "b", check: "gaze", target: "screen_center", start: 6, end: 20 });
    const c = spec({ markerId: "c", check: "gaze", target: "screen_center", start: 30, end: 35 });
    const r = createPromptRunner([a, b, c]);
    r.setVideoBox(BOX);
    play(r, 0, 5, away(r));
    play(r, 5.05, 7.5, away(r)); // within the replay grace of a
    assert.equal(phase(r, "a").phase, "replaying");
    assert.equal(phase(r, "b").phase, "active");
    const e = r.finish({ nowMs: 11_000 });
    assert.deepEqual(e.requests, []);
    assert.deepEqual(e.results.map((x) => [x.markerId, x.passed]), [["a", false], ["b", false]]);
    assert.equal(phase(r, "c").phase, "upcoming"); // beyond the end of the video: not reported
  });

  it("merges simultaneous replays into one seek to the earliest point", () => {
    const a = spec({ markerId: "a", check: "action", action: "nod", start: 10, end: 15 });
    const b = spec({ markerId: "b", check: "action", action: "still", start: 12, end: 15 });
    const r = createPromptRunner([a, b]);
    const e = play(r, 9, 15);
    assert.deepEqual(e.requests, [{ type: "seek", to: 9 }]);
    assert.equal(phase(r, "a").phase, "replaying");
    assert.equal(phase(r, "b").phase, "replaying");
  });

  it("skips spend specs", () => {
    const r = createPromptRunner([spec({ markerId: "s", check: "spend", title: "10" }), GAZE]);
    assert.deepEqual(r.specs.map((s) => s.markerId), ["m1"]);
  });

  it("routes speech to active repeat checks only", () => {
    const rep = spec({ markerId: "r", check: "repeat", title: "I obey", start: 10, end: 16 });
    const r = createPromptRunner([rep]);
    r.update({ videoTime: 9, nowMs: 9000 });
    r.feedSpeech({ t: 9100, text: "i obey", final: true }); // too early
    r.update({ videoTime: 10, nowMs: 10_000 });
    r.feedSpeech({ t: 9500, text: "i obey", final: true }); // said before the window opened
    assert.equal(phase(r, "r").progress < 1, true);
    r.feedSpeech({ t: 12_000, text: "um i obey", final: true });
    assert.equal(phase(r, "r").progress, 1);
    assert.deepEqual(r.update({ videoTime: 16, nowMs: 16_000 }).results, [{ markerId: "r", passed: true }]);
  });

  it("routes viewer frames to active action checks", () => {
    const act = spec({ markerId: "h", check: "action", action: "hand_raised", start: 10, end: 15 });
    const r = createPromptRunner([act]);
    const e = play(r, 9, 15, (_vt, nowMs) => r.feedViewer({ t: nowMs, facePresent: true, personPresent: true, handRaised: true }));
    assert.deepEqual(e.results, [{ markerId: "h", passed: true }]);
  });

  it("gaze on the video person uses fresh person frames only", () => {
    const eyes = spec({ markerId: "e", check: "gaze", target: "eyes", start: 10, end: 15, holdSec: 2 });
    const eyeY = 218.75 + 562.5 * 0.19;
    const look = (rr: PromptRunner, person: boolean) => (vt: number, nowMs: number) => {
      if (person) rr.feedPerson({ ...frame([pose(STANDING)]), videoTime: vt }, BOX);
      rr.feedGaze({ t: nowMs, point: { x: 500, y: eyeY }, valid: true });
    };
    const r = createPromptRunner([eyes]);
    assert.deepEqual(play(r, 9, 15, look(r, true)).results, [{ markerId: "e", passed: true }]);
    // the only person frame is from long ago: the target can't be located, time doesn't count
    const r2 = createPromptRunner([eyes], { replays: 0 });
    r2.feedPerson({ ...frame([pose(STANDING)]), videoTime: 2 }, BOX);
    assert.equal(r2.regionFor(eyes), undefined);
    assert.deepEqual(play(r2, 9, 15, look(r2, false)).results, [{ markerId: "e", passed: false }]);
    assert.equal(phase(r2, "e").detail, "held 0.0 of 2.0 s");
  });
});

describe("createPromptRunner: gaze eyes_closed", () => {
  const EC: PromptSpec = spec({ markerId: "ec", check: "gaze", target: "eyes_closed", start: 10, end: 15, holdSec: 2 });
  const ACT: PromptSpec = spec({ markerId: "act", check: "action", action: "eyes_closed", start: 10, end: 15, holdSec: 2 });

  it("tracker presence without gaze passes it (no video box or person needed)", () => {
    const r = createPromptRunner([EC]);
    const e = play(r, 9, 15, (_vt, nowMs) => r.feedGaze({ t: nowMs, valid: false, present: true }));
    assert.deepEqual(e.results, [{ markerId: "ec", passed: true }]);
  });

  it("without presence a lost gaze is no evidence", () => {
    const r = createPromptRunner([EC], { replays: 0 });
    const e = play(r, 9, 15, (_vt, nowMs) => r.feedGaze({ t: nowMs, valid: false }));
    assert.deepEqual(e.results, [{ markerId: "ec", passed: false }]);
    assert.equal(phase(r, "ec").progress, 0);
  });

  it("webcam frames reach active eyes_closed gaze checks and action checks", () => {
    const r = createPromptRunner([EC, ACT]);
    const e = play(r, 9, 15, (_vt, nowMs) =>
      r.feedViewer({ t: nowMs, facePresent: true, personPresent: true, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.8 }),
    );
    assert.deepEqual(
      e.results.map((x) => x.markerId).sort(),
      ["act", "ec"],
    );
    assert.ok(e.results.every((x) => x.passed));
  });

  it("webcam frames don't reach other gaze targets", () => {
    const r = createPromptRunner([GAZE], { replays: 0 });
    r.setVideoBox(BOX);
    const e = play(r, 9, 15, (_vt, nowMs) =>
      r.feedViewer({ t: nowMs, facePresent: true, personPresent: true, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }),
    );
    assert.deepEqual(e.results, [{ markerId: "m1", passed: false }]);
  });

  it("an open-eyes signal from either source blocks it", () => {
    const r = createPromptRunner([EC], { replays: 0 });
    const e = play(r, 9, 15, (_vt, nowMs) => {
      r.feedViewer({ t: nowMs, facePresent: true, personPresent: true, eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 });
      r.feedGaze({ t: nowMs, valid: false, present: true });
    });
    assert.deepEqual(e.results, [{ markerId: "ec", passed: false }]);
  });

  it("has no region", () => {
    const r = createPromptRunner([EC]);
    r.setVideoBox(BOX);
    r.feedPerson(frame([pose(STANDING)], { videoTime: 12 }), BOX);
    play(r, 12, 12);
    assert.equal(r.regionFor(EC), undefined);
  });
});

describe("createPromptRunner: currentGaze and overlapping gaze prompts", () => {
  const EYES: PromptSpec = spec({ markerId: "ey", check: "gaze", target: "screen_center", start: 2, end: 552, holdSec: 2 });
  const EC: PromptSpec = spec({ markerId: "ec", check: "gaze", target: "eyes_closed", start: 10, end: 1721, holdSec: 1.5 });

  it("undefined without an active gaze prompt; the state of the active one otherwise", () => {
    const r = createPromptRunner([GAZE]);
    r.setVideoBox(BOX);
    play(r, 9, 9.5, centre(r));
    assert.equal(r.currentGaze(9500), undefined);
    play(r, 10, 11, centre(r));
    assert.deepEqual(r.currentGaze(11_000), { state: "on", spec: GAZE });
    play(r, 11.05, 12, away(r));
    assert.equal(r.currentGaze(12_000)?.state, "off");
    // no samples for a while: unknown
    assert.equal(r.currentGaze(13_000)?.state, "unknown");
    play(r, 15, 15);
    assert.equal(r.currentGaze(15_000), undefined);
  });

  it("the later prompt leads; the earlier one counts the overlap as no evidence", () => {
    const r = createPromptRunner([EYES, EC]);
    r.setVideoBox(BOX);
    // 2..10 s: looking at the centre (the screen_center prompt alone)
    play(r, 2, 9.95, centre(r));
    assert.equal(r.currentGaze(9950)?.spec.markerId, "ey");
    // 10..60 s: eyes closed (the tracker sees the viewer, no gaze)
    play(r, 10, 60, (_vt, nowMs) => r.feedGaze({ t: nowMs, valid: false, present: true }));
    assert.deepEqual(r.currentGaze(60_000), { state: "on", spec: EC });
    const ey = phase(r, "ey");
    assert.equal(ey.phase, "active");
    // the eyes-closed stretch didn't count against the earlier prompt
    assert.ok(ey.share! > 0.99, String(ey.share));
    assert.equal(ey.progress, 1);
    assert.equal(phase(r, "ec").progress, 1);
  });

  it("progress carries the share of long windows", () => {
    const r = createPromptRunner([EC]);
    play(r, 10, 30, (vt, nowMs) =>
      r.feedGaze(vt < 25 ? { t: nowMs, valid: false, present: true } : { t: nowMs, point: { x: 1, y: 1 }, valid: true, present: true }),
    );
    const p = phase(r, "ec");
    assert.ok(Math.abs(p.share! - 0.75) < 0.02, String(p.share));
    assert.match(p.detail!, /^eyes closed \d+% · need 75%$/);
  });
});
