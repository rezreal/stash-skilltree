import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EYES_CLOSED_GAZE,
  GAZE_STALE_MS,
  LONG_WINDOW_SEC,
  SUSTAINED_MIN_SHARE,
  combineEyes,
  isSustained,
  shareText,
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

  it("a paused clip asks nothing: open eyes while paused don't count, the state still follows", () => {
    // long window: share-scored
    const c = createGazeTargetCheck(EC({ start: 10, end: 100 }));
    feed(c, 0, 4000, T_CLOSED); // 4 s closed while playing
    // paused at video 15 s: eyes open for 10 s of wall time
    for (let t = 4000; t < 14000; t += STEP) c.push({ t, videoTime: 15, ...T_OPEN });
    assert.equal(c.current(13990), "off", "the state still follows the eyes, so the session stays paused");
    const r = c.result();
    assert.equal(r.share, 1, "paused time is not held against the viewer");
    // eyes close while still paused: the state flips, the session can resume
    for (let t = 14000; t < 14200; t += STEP) c.push({ t, videoTime: 15, ...T_CLOSED });
    assert.equal(c.current(14190), "on");
  });

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

describe("createGazeTargetCheck: long (sustained) windows", () => {
  const T_CLOSED = { gazeValid: false, present: true };
  const T_OPEN = { gaze: { x: 500, y: 500 }, gazeValid: true, present: true };
  const T_UNKNOWN = { gazeValid: false };
  const LONG_EC = spec({ target: "eyes_closed", start: 10, end: 1721, holdSec: 1.5 });
  const LONG_EYES = spec({ target: "eyes", start: 10, end: 100, holdSec: 2 });

  it("constants and the window split", () => {
    assert.equal(LONG_WINDOW_SEC, 10);
    assert.equal(SUSTAINED_MIN_SHARE, 0.75);
    assert.equal(isSustained({ start: 10, end: 20 }), false); // exactly 10 s: still the hold rule
    assert.equal(isSustained({ start: 10, end: 20.5 }), true);
  });

  it("eyes_closed: passes with >= 75% of the evidence time closed, open stretches allowed", () => {
    const c = createGazeTargetCheck(LONG_EC);
    // 80% closed: 8 s closed, 2 s open, five times
    for (let k = 0; k < 5; k++) {
      feed(c, k * 10_000, k * 10_000 + 8000, T_CLOSED);
      feed(c, k * 10_000 + 8000, (k + 1) * 10_000, T_OPEN);
    }
    const r = c.result();
    assert.equal(r.passed, true);
    assert.equal(r.progress, 1);
    assert.ok(Math.abs(r.share! - 0.8) < 0.01, String(r.share));
    assert.match(r.detail, /^eyes closed (79|80)% · need 75%$/);
  });

  it("eyes_closed: fails below 75%, progress = share / 0.75", () => {
    const c = createGazeTargetCheck(LONG_EC);
    for (let k = 0; k < 5; k++) {
      feed(c, k * 10_000, k * 10_000 + 6000, T_CLOSED);
      feed(c, k * 10_000 + 6000, (k + 1) * 10_000, T_OPEN);
    }
    const r = c.result();
    assert.equal(r.passed, false);
    assert.ok(Math.abs(r.share! - 0.6) < 0.01, String(r.share));
    assert.ok(Math.abs(r.progress - 0.8) < 0.02, String(r.progress));
  });

  it("time without evidence neither counts nor is required", () => {
    const c = createGazeTargetCheck(LONG_EC);
    feed(c, 0, 9000, T_CLOSED);
    feed(c, 9000, 10_000, T_OPEN);
    feed(c, 10_000, 60_000, T_UNKNOWN); // 50 s nothing tracked
    const r = c.result();
    assert.equal(r.passed, true);
    assert.ok(Math.abs(r.share! - 0.9) < 0.01, String(r.share));
  });

  it("no evidence at all fails, and a long window needs at least the hold time on target", () => {
    const none = createGazeTargetCheck(LONG_EC);
    feed(none, 0, 30_000, T_UNKNOWN);
    assert.equal(none.result().passed, false);
    assert.equal(none.result().progress, 0);
    assert.equal(none.result().share, undefined);
    assert.equal(none.result().detail, "eyes closed – · need 75%");
    const brief = createGazeTargetCheck(LONG_EC);
    feed(brief, 0, 500, T_CLOSED);
    feed(brief, 500, 30_000, T_UNKNOWN);
    assert.equal(brief.result().share, 1);
    assert.equal(brief.result().passed, false);
    assert.ok(brief.result().progress < 0.4, String(brief.result().progress));
  });

  it("region targets: share of time in the region", () => {
    const pass = createGazeTargetCheck(LONG_EYES);
    feed(pass, 0, 16_000, IN);
    feed(pass, 16_000, 20_000, OUT);
    feed(pass, 20_000, 30_000, LOST); // region unknown: no evidence
    assert.equal(pass.result().passed, true);
    assert.match(pass.result().detail, /^on target (79|80)% · need 75%$/);
    const fail = createGazeTargetCheck(LONG_EYES);
    feed(fail, 0, 10_000, IN);
    feed(fail, 10_000, 20_000, OUT);
    assert.equal(fail.result().passed, false);
    assert.ok(Math.abs(fail.result().share! - 0.5) < 0.01);
  });

  it("short windows keep the continuous hold (an 80% share doesn't pass without a 2 s run)", () => {
    const c = createGazeTargetCheck(spec({ target: "eyes", start: 10, end: 20, holdSec: 2 }));
    for (let k = 0; k < 5; k++) {
      feed(c, k * 2000, k * 2000 + 1600, IN);
      feed(c, k * 2000 + 1600, (k + 1) * 2000, OUT);
    }
    assert.equal(c.result().passed, false);
    assert.equal(c.result().share, undefined);
    assert.match(c.result().detail, /^held 1\.\d of 2\.0 s$/);
  });

  it("shareText floors, so a shown 75% passes", () => {
    assert.equal(shareText("eyes_closed", 0.749), "eyes closed 74% · need 75%");
    assert.equal(shareText("eyes_closed", 0.82), "eyes closed 82% · need 75%");
    assert.equal(shareText("eyes", 0.4), "on target 40% · need 75%");
    assert.equal(shareText("eyes", undefined), "on target – · need 75%");
  });
});

describe("createGazeTargetCheck: current moment", () => {
  const face = (l: number): ViewerFrame => ({ t: 0, facePresent: true, personPresent: true, eyeBlinkLeft: l, eyeBlinkRight: l });

  it("eyes_closed: closed = on, open = off, nothing = unknown, stale = unknown", () => {
    const c = createGazeTargetCheck(spec({ target: "eyes_closed", start: 10, end: 100 }));
    assert.equal(c.current(0), "unknown");
    c.push({ t: 1000, videoTime: 11, gazeValid: false, present: true });
    assert.equal(c.current(1100), "on");
    c.push({ t: 1200, videoTime: 11.2, gaze: { x: 1, y: 1 }, gazeValid: true, present: true });
    assert.equal(c.current(1250), "off");
    // webcam closed, tracker open: open wins
    c.pushViewer({ ...face(0.9), t: 1260 });
    assert.equal(c.current(1300), "off");
    // tracker stale: the webcam decides
    assert.equal(c.current(1200 + EYES_CLOSED_GAZE.staleMs + 10), "on");
    assert.equal(c.current(5000), "unknown");
    c.push({ t: 6000, videoTime: 16, gazeValid: false }); // presence unknown
    assert.equal(c.current(6000), "unknown");
  });

  it("region targets: in = on, out or eyes lost = off, no region or stale = unknown", () => {
    const c = createGazeTargetCheck(spec({ target: "eyes", start: 10, end: 100 }));
    assert.equal(c.current(0), "unknown");
    c.push({ t: 0, videoTime: 10, ...IN });
    assert.equal(c.current(50), "on");
    c.push({ t: 100, videoTime: 10.1, ...OUT });
    assert.equal(c.current(150), "off");
    c.push({ t: 200, videoTime: 10.2, ...BLINK });
    assert.equal(c.current(250), "off");
    c.push({ t: 300, videoTime: 10.3, ...LOST });
    assert.equal(c.current(350), "unknown");
    c.push({ t: 400, videoTime: 10.4, ...OUT });
    assert.equal(c.current(400 + GAZE_STALE_MS + 1), "unknown");
    // outside the window
    c.push({ t: 500, videoTime: 200, ...OUT });
    assert.equal(c.current(500), "unknown");
  });

  it("idle: a superseded prompt counts the time as no evidence", () => {
    const c = createGazeTargetCheck(spec({ target: "eyes", start: 10, end: 100 }));
    feed(c, 0, 8000, IN);
    for (let t = 8000; t < 60_000; t += STEP) c.idle(t);
    assert.equal(c.current(60_000), "unknown");
    assert.equal(c.result().passed, true);
    assert.ok(c.result().share! > 0.99);
    const ec = createGazeTargetCheck(spec({ target: "eyes_closed", start: 10, end: 100 }));
    ec.pushViewer({ ...face(0.1), t: 0 });
    for (let t = 0; t < 30_000; t += STEP) ec.idle(t);
    assert.equal(ec.result().share, undefined);
    assert.equal(ec.current(30_000), "unknown");
  });
});
