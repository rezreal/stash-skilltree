import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createActionCheck } from "../../src/prompts/actionCheck.ts";
import {
  calibrateStroke,
  createStrokeTracker,
  FRAMING_HINTS,
  parseStrokeCalibration,
  strokeFraming,
  wristRel,
  type PoseSample,
} from "../../src/prompts/stroke.ts";
import type { NormPoint } from "../../src/prompts/types.ts";
import { pose, spec } from "./fixtures.ts";

// seated, facing a 4:3 webcam: shoulders 0.2 apart (shoulder width 0.267), hip midpoint (0.5, 0.7)
type Over = Parameters<typeof pose>[0];
const SEATED: Over = {
  nose: [0.5, 0.15],
  leftShoulder: [0.6, 0.3],
  rightShoulder: [0.4, 0.3],
  leftHip: [0.58, 0.7],
  rightHip: [0.42, 0.7],
  leftWrist: [0.62, 0.75],
  rightWrist: [0.5, 0.72],
};
const at = (over: Over = {}): NormPoint[] => pose({ ...SEATED, ...over });
/** the right wrist stroking: +-amp (normalized frame height) around y 0.72 at hz */
const stroke = (t: number, hz = 2, amp = 0.04): NormPoint[] => at({ rightWrist: [0.5, 0.72 + amp * Math.sin((2 * Math.PI * hz * t) / 1000)] });
const STEP = 66; // 15 Hz, the action rate

function samples(from: number, to: number, f: (t: number) => NormPoint[]): PoseSample[] {
  const out: PoseSample[] = [];
  for (let t = from; t < to; t += STEP) out.push({ t, pose: f(t), aspect: 4 / 3 });
  return out;
}

describe("framing and body-relative wrists", () => {
  it("names the first thing missing", () => {
    assert.deepEqual(strokeFraming(undefined), { ok: false, hint: FRAMING_HINTS.notInView });
    assert.equal(strokeFraming(at({ leftShoulder: [0.6, 0.3, 0.1] })).hint, FRAMING_HINTS.shoulders);
    assert.equal(strokeFraming(at({ leftHip: [0.58, 0.7, 0.1] })).hint, FRAMING_HINTS.hips);
    assert.equal(strokeFraming(at({ leftWrist: [0.6, 0.7, 0.1], rightWrist: [0.5, 0.7, 0.1] })).hint, FRAMING_HINTS.hands);
    assert.deepEqual(strokeFraming(at()), { ok: true });
  });

  it("places a wrist relative to the hips, in shoulder widths", () => {
    const p = wristRel(at({ rightWrist: [0.5, 0.7 + 0.2667 / 2] }), "right")!;
    assert.ok(Math.abs(p.x) < 1e-3 && Math.abs(p.y - 0.5) < 1e-3, JSON.stringify(p));
    assert.equal(wristRel(at({ leftHip: [0.58, 0.7, 0.1] }), "right"), undefined);
  });
});

describe("createStrokeTracker", () => {
  it("stroking holds while swings keep coming, and stops after a pause", () => {
    const tr = createStrokeTracker();
    const states: string[] = [];
    for (let t = 0; t < 2000; t += STEP) states.push(tr.push(t, stroke(t)));
    assert.equal(states[states.length - 1], "in");
    assert.ok(states.slice(-10).every((s) => s === "in"));
    const rate = tr.ratePerMin(2000)!;
    assert.ok(Math.abs(rate - 120) < 20, `rate ${rate}`);
    let s = "";
    for (let t = 2000; t < 3500; t += STEP) s = tr.push(t, at());
    assert.equal(s, "out", "1.5 s without a swing");
  });

  it("a hand moving outside the lap zone isn't stroking", () => {
    const tr = createStrokeTracker();
    let s = "";
    // waving at face height
    for (let t = 0; t < 2000; t += STEP) s = tr.push(t, at({ rightWrist: [0.5, 0.2 + 0.04 * Math.sin((2 * Math.PI * 2 * t) / 1000)], leftWrist: [0.62, 0.75] }));
    assert.equal(s, "out");
  });

  it("small jitter is no stroke", () => {
    const tr = createStrokeTracker();
    let s = "";
    for (let t = 0; t < 3000; t += STEP) s = tr.push(t, stroke(t, 3, 0.005));
    assert.equal(s, "out");
  });

  it("unknown with a framing hint when the lap isn't in view", () => {
    const tr = createStrokeTracker();
    assert.equal(tr.push(0, at({ leftHip: [0.58, 0.7, 0.1], rightHip: [0.42, 0.7, 0.1] })), "unknown");
    assert.equal(tr.hint, FRAMING_HINTS.hips);
    assert.equal(tr.push(66, at()), "out");
    assert.equal(tr.hint, undefined);
  });

  it("a calibration watches only its hand", () => {
    const tr = createStrokeTracker({ v: 1, hand: "left", cx: 0.45, cy: 0.19, amplitude: 0.3, rateHz: 2, savedAt: "" });
    let s = "";
    for (let t = 0; t < 2000; t += STEP) s = tr.push(t, stroke(t)); // the right hand strokes
    assert.equal(s, "out");
  });
});

describe("calibrateStroke", () => {
  const rest = samples(5000, 8000, () => at());

  it("picks the stroking hand, its centre, size and rate", () => {
    const r = calibrateStroke(samples(0, 5000, (t) => stroke(t, 1.5)), rest, "2026-11-12T00:00:00Z");
    assert.ok(r.ok, r.ok ? "" : r.problem);
    const c = r.calibration;
    assert.equal(c.hand, "right");
    assert.ok(Math.abs(c.rateHz - 1.5) < 0.3, `rate ${c.rateHz}`);
    assert.ok(c.amplitude > 0.2 && c.amplitude < 0.32, `amplitude ${c.amplitude}`);
    assert.ok(Math.abs(c.cx) < 0.05 && Math.abs(c.cy - 0.075) < 0.05, `centre ${c.cx}, ${c.cy}`);
    // and the tracker recognizes the same stroke with it
    const tr = createStrokeTracker(c);
    let s = "";
    for (let t = 0; t < 3000; t += STEP) s = tr.push(t, stroke(t, 1.5));
    assert.equal(s, "in");
  });

  it("says why it can't calibrate", () => {
    const noHips = (t: number) => pose({ ...SEATED, leftHip: [0.58, 0.7, 0.1], rightHip: [0.42, 0.7, 0.1], rightWrist: [0.5, 0.72 + 0.04 * Math.sin(t / 100)] });
    const cases: [PoseSample[], PoseSample[], RegExp][] = [
      [samples(0, 5000, noHips), rest, /didn't see your hand/],
      [samples(0, 5000, (t) => stroke(t, 1.5, 0.008)), rest, /No clear up-and-down/],
      [samples(0, 5000, (t) => stroke(t, 0.2)), rest, /too slow/],
      [samples(0, 5000, (t) => stroke(t, 1.5)), samples(5000, 8000, (t) => stroke(t, 1.5)), /moved almost as much while resting/],
      [samples(0, 300, (t) => stroke(t)), rest, /Too few camera frames/],
    ];
    for (const [s, r, re] of cases) {
      const out = calibrateStroke(s, r, "");
      assert.equal(out.ok, false);
      assert.match(out.ok ? "" : out.problem, re);
    }
  });

  it("round-trips through storage text and rejects junk", () => {
    const r = calibrateStroke(samples(0, 5000, (t) => stroke(t, 1.5)), rest, "x");
    assert.ok(r.ok);
    assert.deepEqual(parseStrokeCalibration(JSON.stringify(r.calibration)), r.calibration);
    for (const bad of [undefined, "", "{", '{"v":2}', '{"v":1,"hand":"up","cx":0,"cy":0,"amplitude":1,"rateHz":1}', '{"v":1,"hand":"left","cx":0,"cy":0,"amplitude":0,"rateHz":1}']) {
      assert.equal(parseStrokeCalibration(bad), undefined, String(bad));
    }
  });
});

describe("stroking / hands_off action checks", () => {
  const feed = (c: ReturnType<typeof createActionCheck>, from: number, to: number, f: (t: number) => NormPoint[], facePresent = true) => {
    for (let t = from; t < to; t += STEP) c.push({ t, facePresent, personPresent: true, pose: f(t), aspect: 4 / 3 });
  };

  it("stroking passes after the hold, without needing the face", () => {
    const c = createActionCheck(spec({ check: "action", action: "stroking", holdSec: 2 }));
    feed(c, 0, 1500, (t) => stroke(t), false);
    assert.equal(c.result().passed, false);
    feed(c, 1500, 3500, (t) => stroke(t), false);
    assert.equal(c.result().passed, true);
  });

  it("hands_off passes while not stroking, and fails a long window spent stroking", () => {
    const c = createActionCheck(spec({ check: "action", action: "hands_off", holdSec: 2 }));
    feed(c, 0, 2500, () => at());
    assert.equal(c.result().passed, true);
    const long = createActionCheck(spec({ check: "action", action: "hands_off", holdSec: 2, start: 0, end: 30 }));
    feed(long, 0, 30_000, (t) => stroke(t));
    assert.equal(long.result().passed, false);
  });

  it("explains a lap out of view", () => {
    const c = createActionCheck(spec({ check: "action", action: "stroking", holdSec: 2 }));
    feed(c, 0, 1500, () => at({ leftHip: [0.58, 0.7, 0.1], rightHip: [0.42, 0.7, 0.1] }));
    assert.equal(c.result().passed, false);
    assert.equal(c.result().hint, FRAMING_HINTS.hips);
  });
});
