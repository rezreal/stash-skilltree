import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calibrate,
  createDriftTracker,
  isNoTarget,
  linearPosition,
  parseTrackCalibration,
  serializeTrackCalibration,
  toPosition,
} from "../../src/track/calibration.ts";
import type { TrackCalibration } from "../../src/track/types.ts";
import { rng } from "./fixtures.ts";

const NOW = "2026-10-12T10:00:00.000Z";

describe("calibration", () => {
  it("maps raw readings to 0..100 in either orientation", () => {
    const near = calibrate(120, 40, NOW); // distance shrinks going in
    assert.equal(toPosition(120, near), 0);
    assert.equal(toPosition(40, near), 100);
    assert.equal(toPosition(80, near), 50);
    assert.equal(toPosition(200, near), 0);
    assert.equal(toPosition(0, near), 0); // 0 = no echo: out, not in
    assert.equal(linearPosition(140, near), -25);
    const far = calibrate(10, 90, NOW);
    assert.equal(toPosition(30, far), 25);
    assert.equal(far.drift, 0);
    assert.equal(far.createdAt, NOW);
  });

  it("reads a lost target as fully out, not fully in", () => {
    // mouthpiece in = closer = smaller reading: rest 60 mm, deepest 20 mm
    const cal = calibrate(60, 20, "2026-01-01T00:00:00Z");
    assert.equal(toPosition(20, cal), 100);
    assert.equal(toPosition(15, cal), 100, "a little past the deepest point is still fully in");
    assert.equal(toPosition(0, cal), 0, "0 = no echo when backed off");
    assert.equal(isNoTarget(0, cal), true);
    assert.equal(toPosition(80, cal), 0, "further out than rest");
    // the other orientation: larger = deeper, sensor reports its maximum when lost
    const up = calibrate(100, 400, "2026-01-01T00:00:00Z");
    assert.equal(toPosition(400, up), 100);
    assert.equal(toPosition(8190, up), 0, "far past the deepest point is a lost target");
    assert.equal(isNoTarget(500, up), false, "within the margin it is a deep push");
  });

  it("subtracts the drift", () => {
    const cal: TrackCalibration = { ...calibrate(0, 100, NOW), drift: 5 };
    assert.equal(toPosition(5, cal), 0);
    assert.ok(Math.abs(toPosition(55, cal) - 50) < 1e-9);
    assert.equal(toPosition(2, cal), 0);
  });

  it("rejects equal or broken readings", () => {
    assert.throws(() => calibrate(50, 50, NOW), RangeError);
    assert.throws(() => calibrate(Number.NaN, 50, NOW), RangeError);
  });

  it("round-trips through storage and rejects garbage", () => {
    const cal: TrackCalibration = { ...calibrate(120, 40, NOW), drift: -3.5 };
    assert.deepEqual(parseTrackCalibration(serializeTrackCalibration(cal)), cal);
    assert.equal(parseTrackCalibration(null), undefined);
    assert.equal(parseTrackCalibration("{nope"), undefined);
    assert.equal(parseTrackCalibration("[]"), undefined);
    assert.equal(parseTrackCalibration(JSON.stringify({ rawAtZero: 5, rawAtFull: 5 })), undefined);
    assert.deepEqual(parseTrackCalibration(JSON.stringify({ rawAtZero: 1, rawAtFull: 2 })), { rawAtZero: 1, rawAtFull: 2, drift: 0, createdAt: "" });
  });
});

describe("drift tracker", () => {
  const base = calibrate(0, 100, NOW); // raw == linear position

  /** feeds `ms` of readings at 20 Hz while idle (expected 0) */
  function feed(cal: TrackCalibration, raw: (i: number) => number, ms: number, idle = true) {
    const expected = idle ? 0 : undefined;
    const t0 = 0;
    const d = createDriftTracker();
    let c = cal;
    for (let i = 0, t = t0; t <= t0 + ms; i++, t += 50) c = d.push(raw(i), t, c, expected);
    return c;
  }

  it("moves the drift towards a stable offset while idle", () => {
    const c = feed(base, () => 6, 20_000);
    assert.ok(Math.abs(c.drift - 6) < 0.1, `drift ${c.drift}`);
    assert.ok(toPosition(6, c) < 0.1);
  });

  it("is slow: little correction after a short stable stretch", () => {
    const c = feed(base, () => 6, 1500);
    assert.ok(c.drift > 0 && c.drift < 2, `drift ${c.drift}`);
  });

  it("is bounded", () => {
    const c = feed(base, () => 40, 60_000);
    assert.ok(c.drift > 14.9 && c.drift <= 15, `drift ${c.drift}`);
    const neg = feed({ ...base }, () => -30, 60_000);
    assert.ok(neg.drift < -14.9 && neg.drift >= -15, `drift ${neg.drift}`);
  });

  it("ignores an unstable reading", () => {
    const r = rng(3);
    const c = feed(base, () => 6 + (r() * 2 - 1) * 10, 20_000);
    assert.equal(c, base);
  });

  it("does nothing outside idle sections", () => {
    assert.equal(feed(base, () => 6, 20_000, false), base);
  });

  it("corrects towards where the user should be, not 0", () => {
    const d = createDriftTracker();
    let c = base;
    for (let t = 0; t <= 20_000; t += 50) c = d.push(7, t, c, 3);
    assert.ok(Math.abs(c.drift - 4) < 0.1, `drift ${c.drift}`);
  });

  it("restarts the stability window after a gap", () => {
    const d = createDriftTracker();
    let c = base;
    for (let t = 0; t <= 900; t += 50) c = d.push(6, t, c, 0);
    for (let t = 2000; t <= 2900; t += 50) c = d.push(6, t, c, 0);
    assert.equal(c.drift, 0);
  });
});
