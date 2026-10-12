import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EYES_CLOSED_GAZE,
  combineEyes,
  createGazeTargetCheck,
  eyesClosedHoldSec,
  trackerEyes,
  webcamEyes,
} from "../../src/prompts/gazeCheck.ts";
import type { GazeCheckInput, GazeTargetCheck } from "../../src/prompts/gazeCheck.ts";
import type { Region, ViewerFrame } from "../../src/prompts/types.ts";
import { spec } from "./fixtures.ts";

const REGION: Region = { kind: "ellipse", cx: 500, cy: 500, rx: 50, ry: 50 };
const IN = { gaze: { x: 500, y: 500 }, gazeValid: true, region: REGION };
const OUT = { gaze: { x: 800, y: 500 }, gazeValid: true, region: REGION };
const BLINK = { gazeValid: false, region: REGION };
const LOST = { gaze: { x: 500, y: 500 }, gazeValid: true }; // region undefined
const STEP = 20;

/** samples every STEP ms in [from, to); videoTime = 10 s + t */
function feed(c: GazeTargetCheck, from: number, to: number, s: Omit<GazeCheckInput, "t" | "videoTime">): void {
  for (let t = from; t < to; t += STEP) c.push({ t, videoTime: 10 + t / 1000, ...s });
}

describe("createGazeTargetCheck", () => {
  it("passes after a continuous hold of holdSec", () => {
    const c = createGazeTargetCheck(spec({ holdSec: 2 }));
    feed(c, 0, 1500, IN);
    assert.equal(c.result().passed, false);
    assert.ok(Math.abs(c.result().progress - 0.74) < 0.02);
    feed(c, 1500, 2100, IN);
    assert.equal(c.result().passed, true);
    assert.equal(c.result().progress, 1);
    // stays passed
    feed(c, 2100, 3000, OUT);
    assert.equal(c.result().passed, true);
  });

  it("tolerates brief exits (< 300 ms) without counting them", () => {
    const c = createGazeTargetCheck(spec({ holdSec: 2 }));
    feed(c, 0, 1000, IN);
    feed(c, 1000, 1200, OUT); // 200 ms saccade
    feed(c, 1200, 1300, BLINK); // 100 ms blink... total exit 300 ms
    feed(c, 1300, 2300, IN);
    assert.equal(c.result().passed, false); // only ~2000 ms of in-time, minus the last interval
    feed(c, 2300, 2360, IN);
    assert.equal(c.result().passed, true);
  });

  it("a long exit resets the hold", () => {
    const c = createGazeTargetCheck(spec({ holdSec: 2 }));
    feed(c, 0, 1500, IN);
    feed(c, 1500, 1900, OUT); // 400 ms
    feed(c, 1900, 3400, IN);
    assert.equal(c.result().passed, false);
    assert.ok(c.result().progress < 0.8);
    feed(c, 3400, 4000, IN);
    assert.equal(c.result().passed, true);
  });

  it("time without a region neither counts nor resets", () => {
    const c = createGazeTargetCheck(spec({ holdSec: 2 }));
    feed(c, 0, 1000, IN);
    feed(c, 1000, 3000, LOST);
    const mid = c.result();
    assert.equal(mid.passed, false);
    assert.ok(mid.progress > 0.49 && mid.progress < 0.52, String(mid.progress));
    feed(c, 3000, 4040, IN);
    assert.equal(c.result().passed, true);
  });

  it("ignores samples outside the spec window", () => {
    const c = createGazeTargetCheck(spec({ start: 10, end: 15, holdSec: 2 }));
    for (let t = 0; t < 3000; t += STEP) c.push({ t, videoTime: 5 + t / 1000, ...IN });
    assert.equal(c.result().progress, 0);
  });

  it("stalls only count up to the max gap", () => {
    const c = createGazeTargetCheck(spec({ holdSec: 2 }));
    c.push({ t: 0, videoTime: 10, ...IN });
    c.push({ t: 5000, videoTime: 14.9, ...IN });
    assert.equal(c.result().passed, false);
    assert.equal(c.result().detail, "held 0.3 of 2.0 s");
  });

  it("reset clears everything", () => {
    const c = createGazeTargetCheck(spec({ holdSec: 1 }));
    feed(c, 0, 1100, IN);
    assert.equal(c.result().passed, true);
    c.reset();
    assert.equal(c.result().passed, false);
    assert.equal(c.result().progress, 0);
  });
});

describe("createGazeTargetCheck: eyes_closed", () => {
  const EC = (over: Parameters<typeof spec>[0] = {}) => spec({ target: "eyes_closed", holdSec: 2, ...over });
  /** tracker: present without gaze = closed */
  const T_CLOSED = { gazeValid: false, present: true };
  const T_OPEN = { gaze: { x: 500, y: 500 }, gazeValid: true, present: true };
  const T_GONE = { gazeValid: false, present: false };
  const T_UNKNOWN = { gazeValid: false }; // presence unknown
  const face = (l: number, r = l): Omit<ViewerFrame, "t"> => ({ facePresent: true, personPresent: true, eyeBlinkLeft: l, eyeBlinkRight: r });
  const NO_FACE: Omit<ViewerFrame, "t"> = { facePresent: false, personPresent: false };
  const cam = (c: GazeTargetCheck, from: number, to: number, f: Omit<ViewerFrame, "t">, step = 50): void => {
    for (let t = from; t < to; t += step) c.pushViewer({ t, ...f });
  };

  it("hold is min(holdSec, 1.5 s)", () => {
    assert.equal(eyesClosedHoldSec(2), 1.5);
    assert.equal(eyesClosedHoldSec(1), 1);
    assert.equal(EYES_CLOSED_GAZE.maxHoldSec, 1.5);
    const short = createGazeTargetCheck(EC({ holdSec: 1 }));
    feed(short, 0, 1000, T_CLOSED);
    assert.equal(short.result().passed, false);
    feed(short, 1000, 1040, T_CLOSED);
    assert.equal(short.result().passed, true);
  });

  it("tracker only: present without gaze counts as closed", () => {
    const c = createGazeTargetCheck(EC());
    feed(c, 0, 1400, T_CLOSED);
    assert.equal(c.result().passed, false);
    assert.equal(c.result().detail, "eyes closed 1.4 of 1.5 s");
    feed(c, 1400, 1540, T_CLOSED);
    assert.equal(c.result().passed, true);
  });

  it("tracker only: valid gaze (eyes open) resets the hold, a stray sample doesn't", () => {
    const c = createGazeTargetCheck(EC());
    feed(c, 0, 1000, T_CLOSED);
    feed(c, 1000, 1100, T_OPEN); // 100 ms flicker: forgiven
    feed(c, 1100, 1400, T_CLOSED);
    assert.ok(c.result().progress > 0.85, String(c.result().progress));
    feed(c, 1400, 1700, T_OPEN); // eyes opened
    feed(c, 1700, 2900, T_CLOSED);
    assert.equal(c.result().passed, false);
    feed(c, 2900, 3300, T_CLOSED);
    assert.equal(c.result().passed, true);
  });

  it("webcam only: both blink scores >= 0.5 count as closed, <= 0.3 as open", () => {
    const c = createGazeTargetCheck(EC());
    cam(c, 0, 1000, face(0.8, 0.7));
    cam(c, 1000, 1500, face(0.1)); // open
    cam(c, 1500, 2600, face(0.9));
    assert.equal(c.result().passed, false);
    cam(c, 2600, 3100, face(0.9));
    assert.equal(c.result().passed, true);
  });

  it("webcam only: a wink (one eye open) is not closed", () => {
    const c = createGazeTargetCheck(EC());
    cam(c, 0, 3000, face(0.9, 0.1));
    assert.equal(c.result().progress, 0);
  });

  it("conflicting evidence: an explicit open from either source wins", () => {
    // tracker closed, webcam open
    const a = createGazeTargetCheck(EC());
    for (let t = 0; t < 3000; t += 20) {
      if (t % 60 === 0) a.pushViewer({ t, ...face(0.1) });
      a.push({ t, videoTime: 10 + t / 1000, ...T_CLOSED });
    }
    assert.equal(a.result().progress, 0);
    // tracker open, webcam closed
    const b = createGazeTargetCheck(EC());
    for (let t = 0; t < 3000; t += 20) {
      if (t % 60 === 0) b.pushViewer({ t, ...face(0.9) });
      b.push({ t, videoTime: 10 + t / 1000, ...T_OPEN });
    }
    assert.equal(b.result().progress, 0);
  });

  it("either source can confirm closed when the other has no evidence", () => {
    // tracker lost the person (closed eyes look like absence to some trackers); the webcam sees closed eyes
    const a = createGazeTargetCheck(EC());
    for (let t = 0; t < 1600; t += 20) {
      a.push({ t, videoTime: 10 + t / 1000, ...T_GONE });
      if (t % 60 === 0) a.pushViewer({ t: t + 5, ...face(0.9) });
    }
    assert.equal(a.result().passed, true);
    // webcam scores in between (no evidence); the tracker says closed
    const b = createGazeTargetCheck(EC());
    for (let t = 0; t < 1600; t += 20) {
      b.push({ t, videoTime: 10 + t / 1000, ...T_CLOSED });
      if (t % 60 === 0) b.pushViewer({ t: t + 5, ...face(0.4) });
    }
    assert.equal(b.result().passed, true);
  });

  it("moments without evidence neither count nor reset", () => {
    const c = createGazeTargetCheck(EC());
    feed(c, 0, 1000, T_CLOSED);
    // tracker: not present / unknown, webcam: no face
    for (let t = 1000; t < 3000; t += 20) {
      c.push({ t, videoTime: 10 + t / 1000, ...(t < 2000 ? T_GONE : T_UNKNOWN) });
      if (t % 60 === 0) c.pushViewer({ t: t + 5, ...NO_FACE });
    }
    const mid = c.result();
    assert.equal(mid.passed, false);
    assert.ok(mid.progress > 0.6 && mid.progress < 0.7, String(mid.progress));
    feed(c, 3000, 3540, T_CLOSED);
    assert.equal(c.result().passed, true);
  });

  it("stale evidence of a source that stopped is ignored", () => {
    const c = createGazeTargetCheck(EC());
    c.pushViewer({ t: 0, ...face(0.1) }); // open, then the webcam stops
    feed(c, 0, 1000, T_CLOSED);
    // the open frame covered only the first staleMs
    const held = c.result().progress * 1500;
    const expected = 1000 - EYES_CLOSED_GAZE.staleMs - 40; // closed from the first sample after staleMs to the last
    assert.ok(Math.abs(held - expected) < 1, String(held));
  });

  it("ignores tracker samples outside the window; region targets ignore webcam frames", () => {
    const c = createGazeTargetCheck(EC({ start: 10, end: 15 }));
    for (let t = 0; t < 3000; t += STEP) c.push({ t, videoTime: 5 + t / 1000, ...T_CLOSED });
    assert.equal(c.result().progress, 0);
    const r = createGazeTargetCheck(spec({ target: "eyes", holdSec: 1 }));
    for (let t = 0; t < 3000; t += 50) r.pushViewer({ t, ...face(0.9) });
    assert.equal(r.result().progress, 0);
  });

  it("evidence pieces", () => {
    assert.equal(trackerEyes({ gazeValid: true }), "open");
    assert.equal(trackerEyes({ gazeValid: false, present: true }), "closed");
    assert.equal(trackerEyes({ gazeValid: false, present: false }), "unknown");
    assert.equal(trackerEyes({ gazeValid: false }), "unknown");
    assert.equal(webcamEyes({ t: 0, ...face(0.5) }), "closed");
    assert.equal(webcamEyes({ t: 0, ...face(0.3, 0.9) }), "open");
    assert.equal(webcamEyes({ t: 0, ...face(0.4) }), "unknown");
    assert.equal(webcamEyes({ t: 0, facePresent: true, personPresent: true }), "unknown");
    assert.equal(webcamEyes({ t: 0, ...NO_FACE, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }), "unknown");
    assert.equal(combineEyes("closed", "open"), "out");
    assert.equal(combineEyes("unknown", "closed"), "in");
    assert.equal(combineEyes("unknown", "unknown"), "unknown");
  });

  it("reset clears the hold and the evidence", () => {
    const c = createGazeTargetCheck(EC({ holdSec: 1 }));
    feed(c, 0, 1100, T_CLOSED);
    assert.equal(c.result().passed, true);
    c.reset();
    assert.equal(c.result().progress, 0);
  });
});
