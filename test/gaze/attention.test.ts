import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGazeAttention, insideRect, smoothPoint } from "../../src/gaze/attention.ts";
import type { GazeAttention } from "../../src/gaze/attention.ts";
import type { GazeAttentionSample } from "../../src/gaze/types.ts";

const VIDEO = { left: 100, top: 100, right: 900, bottom: 550 };
const IN = { x: 500, y: 300 };
const OUT = { x: 1500, y: 300 };
const STEP = 16; // ~60 Hz

/** pushes samples every STEP ms in [from, to) */
function feed(att: GazeAttention, from: number, to: number, f: (t: number) => Omit<GazeAttentionSample, "t">): void {
  for (let t = from; t < to; t += STEP) att.push({ t, ...f(t) });
}
const look = (point: { x: number; y: number }) => () => ({ point, valid: true });
const closed = () => ({ valid: false });

describe("insideRect", () => {
  it("counts the margin and edges as inside", () => {
    assert.equal(insideRect({ x: 100, y: 100 }, VIDEO), true);
    assert.equal(insideRect({ x: 50, y: 300 }, VIDEO), false);
    assert.equal(insideRect({ x: 50, y: 300 }, VIDEO, 50), true);
    assert.equal(insideRect({ x: 949, y: 600 }, VIDEO, 50), true);
    assert.equal(insideRect({ x: 951, y: 300 }, VIDEO, 50), false);
  });
});

describe("createGazeAttention", () => {
  it("attends while looking inside", () => {
    const att = createGazeAttention();
    feed(att, 0, 1000, look(IN));
    const r = att.attending(VIDEO, 1000);
    assert.deepEqual(r, { attending: true, reason: "inside", insideShare: 1 });
  });

  it("does not attend while looking outside", () => {
    const att = createGazeAttention();
    feed(att, 0, 1000, look(OUT));
    const r = att.attending(VIDEO, 1000);
    assert.equal(r.attending, false);
    assert.equal(r.reason, "outside");
    assert.equal(r.insideShare, 0);
  });

  it("decides by the share inside the window", () => {
    const att = createGazeAttention({ windowMs: 600, minInsideShare: 0.6 });
    // last 600ms: 400ms inside, then 200ms outside -> share 2/3
    feed(att, 0, 800, look(IN));
    feed(att, 800, 1000, look(OUT));
    const r = att.attending(VIDEO, 1000);
    assert.ok(Math.abs(r.insideShare - 2 / 3) < 0.03, String(r.insideShare));
    assert.equal(r.attending, true);
    // later, more outside
    feed(att, 1000, 1200, look(OUT));
    assert.equal(att.attending(VIDEO, 1200).attending, false);
  });

  it("uses the margin", () => {
    const near = { x: 950, y: 300 }; // 50px right of the video
    const att = createGazeAttention({ marginPx: 80 });
    feed(att, 0, 1000, look(near));
    assert.equal(att.attending(VIDEO, 1000).attending, true);
    const strict = createGazeAttention({ marginPx: 20 });
    feed(strict, 0, 1000, look(near));
    assert.equal(strict.attending(VIDEO, 1000).attending, false);
  });

  it("ignores blinks shorter than blinkMs", () => {
    const att = createGazeAttention({ blinkMs: 350 });
    feed(att, 0, 700, look(IN));
    feed(att, 700, 900, closed); // 200ms blink, finished
    feed(att, 900, 1000, look(IN));
    const r = att.attending(VIDEO, 1000);
    assert.deepEqual(r, { attending: true, reason: "inside", insideShare: 1 });
  });

  it("reports an ongoing short gap as blink, keeping the state before it", () => {
    const att = createGazeAttention({ blinkMs: 350 });
    feed(att, 0, 800, look(IN));
    feed(att, 800, 1000, closed);
    const r = att.attending(VIDEO, 1000);
    assert.equal(r.reason, "blink");
    assert.equal(r.attending, true);
    assert.equal(r.insideShare, 1);
  });

  it("a blink while looking away stays away", () => {
    const att = createGazeAttention({ blinkMs: 350 });
    feed(att, 0, 700, look(OUT));
    feed(att, 700, 900, closed);
    feed(att, 900, 1000, look(OUT));
    assert.equal(att.attending(VIDEO, 1000).attending, false);
  });

  it("invalid longer than blinkMs is no-gaze", () => {
    const att = createGazeAttention({ blinkMs: 350 });
    feed(att, 0, 500, look(IN));
    feed(att, 500, 1000, closed); // 500ms ongoing
    const r = att.attending(VIDEO, 1000);
    assert.equal(r.reason, "no-gaze");
    assert.equal(r.attending, false);
  });

  it("a finished long invalid stretch counts against the share", () => {
    const att = createGazeAttention({ blinkMs: 350, windowMs: 600 });
    feed(att, 0, 400, look(IN));
    feed(att, 400, 850, closed); // 450ms, finished
    feed(att, 850, 1000, look(IN));
    const r = att.attending(VIDEO, 1000);
    assert.equal(r.reason, "outside");
    assert.equal(r.attending, false);
    assert.ok(r.insideShare < 0.4);
  });

  it("is stale without samples for staleMs, and before any sample", () => {
    const att = createGazeAttention({ staleMs: 1500 });
    assert.deepEqual(att.attending(VIDEO, 0), { attending: false, reason: "stale", insideShare: 0 });
    feed(att, 0, 1000, look(IN));
    assert.equal(att.attending(VIDEO, 2400).reason, "inside");
    assert.deepEqual(att.attending(VIDEO, 2600), { attending: false, reason: "stale", insideShare: 0 });
    att.reset();
    assert.equal(att.attending(VIDEO, 1000).reason, "stale");
  });

  it("treats valid samples without a point as invalid and ignores future samples", () => {
    const att = createGazeAttention();
    feed(att, 0, 1000, look(IN));
    feed(att, 1000, 1500, () => ({ valid: true }));
    assert.equal(att.attending(VIDEO, 1500).reason, "no-gaze");
    assert.equal(att.attending(VIDEO, 999).reason, "inside");
  });

  it("keeps the buffer bounded", () => {
    const att = createGazeAttention();
    feed(att, 0, 600_000, look(IN));
    assert.equal(att.attending(VIDEO, 600_000).attending, true);
  });
});

describe("smoothPoint", () => {
  it("starts at the first point and moves toward the next by time", () => {
    assert.deepEqual(smoothPoint(undefined, { x: 5, y: 6 }, 16), { x: 5, y: 6 });
    const p = smoothPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 60, { tauMs: 60 });
    assert.ok(Math.abs(p.x - 100 * (1 - Math.exp(-1))) < 1e-9);
    assert.deepEqual(smoothPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 0), { x: 0, y: 0 });
  });

  it("is frame-rate independent", () => {
    let a = { x: 0, y: 0 };
    for (let i = 0; i < 6; i++) a = smoothPoint(a, { x: 100, y: 0 }, 10);
    const b = smoothPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 60);
    assert.ok(Math.abs(a.x - b.x) < 1e-9);
  });

  it("snaps on saccades", () => {
    assert.deepEqual(smoothPoint({ x: 0, y: 0 }, { x: 1000, y: 0 }, 16), { x: 1000, y: 0 });
  });
});
