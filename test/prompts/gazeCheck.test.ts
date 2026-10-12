import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGazeTargetCheck } from "../../src/prompts/gazeCheck.ts";
import type { GazeCheckInput, GazeTargetCheck } from "../../src/prompts/gazeCheck.ts";
import type { Region } from "../../src/prompts/types.ts";
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
