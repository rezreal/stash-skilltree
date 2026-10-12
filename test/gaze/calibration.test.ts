import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calibrationPoints,
  collectFixation,
  fitCalibration,
  parseCalibration,
  serializeCalibration,
} from "../../src/gaze/calibration.ts";
import { applyCalibration } from "../../src/gaze/mapping.ts";
import { IDENTITY_CALIBRATION } from "../../src/gaze/types.ts";
import type { Calibration, ViewportPoint } from "../../src/gaze/types.ts";

/** deterministic pseudo-random in [-1, 1] */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
}

const NOW = "2026-10-12T10:00:00.000Z";

describe("fitCalibration", () => {
  it("recovers a known affine from noisy points", () => {
    // measured = inverse of truth applied to targets, plus noise
    const truth: Calibration = { a: 1.05, b: 0.02, c: -30, d: -0.01, e: 0.97, f: 12, createdAt: "", errorPx: 0, points: 0 };
    const r = rng(7);
    const pairs = calibrationPoints(1600, 900).map((target) => {
      // invert truth: solve [a b; d e] m = target - [c f]
      const det = truth.a * truth.e - truth.b * truth.d;
      const u = target.x - truth.c, v = target.y - truth.f;
      const m = { x: (truth.e * u - truth.b * v) / det + r() * 3, y: (-truth.d * u + truth.a * v) / det + r() * 3 };
      return { measured: m, target };
    });
    const c = fitCalibration(pairs, NOW);
    assert.equal(c.points, 9);
    assert.equal(c.createdAt, NOW);
    assert.ok(Math.abs(c.a - truth.a) < 0.01, `a ${c.a}`);
    assert.ok(Math.abs(c.b - truth.b) < 0.01, `b ${c.b}`);
    assert.ok(Math.abs(c.d - truth.d) < 0.01, `d ${c.d}`);
    assert.ok(Math.abs(c.e - truth.e) < 0.01, `e ${c.e}`);
    // the offset is checked through a mapped point (c/f trade off with a/b)
    const p = applyCalibration({ x: 800, y: 450 }, c);
    const q = applyCalibration({ x: 800, y: 450 }, truth);
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 3);
    assert.ok(c.errorPx > 0 && c.errorPx < 5, `errorPx ${c.errorPx}`);
  });

  it("is exact without noise", () => {
    const pairs = calibrationPoints(1000, 500, 5).map((t) => ({ measured: { x: t.x / 2 + 10, y: t.y + 20 }, target: t }));
    const c = fitCalibration(pairs, NOW);
    assert.ok(Math.abs(c.a - 2) < 1e-9 && Math.abs(c.e - 1) < 1e-9);
    assert.ok(Math.abs(c.c + 20) < 1e-9 && Math.abs(c.f + 20) < 1e-9);
    assert.ok(c.errorPx < 1e-9);
  });

  it("falls back to translation with 2 points", () => {
    const c = fitCalibration([
      { measured: { x: 10, y: 10 }, target: { x: 20, y: 5 } },
      { measured: { x: 100, y: 50 }, target: { x: 112, y: 43 } },
    ], NOW);
    assert.equal(c.a, 1);
    assert.equal(c.b, 0);
    assert.equal(c.d, 0);
    assert.equal(c.e, 1);
    assert.equal(c.c, 11);
    assert.equal(c.f, -6);
    assert.equal(c.points, 2);
    // residuals are (-1,1) and (1,-1)
    assert.ok(Math.abs(c.errorPx - Math.SQRT2) < 1e-9);
  });

  it("falls back to translation for collinear points", () => {
    const pairs = [0, 1, 2, 3].map((i) => ({ measured: { x: i * 100, y: i * 100 }, target: { x: i * 100 + 5, y: i * 100 + 5 } }));
    const c = fitCalibration(pairs, NOW);
    assert.equal(c.a, 1);
    assert.equal(c.e, 1);
    assert.equal(c.c, 5);
    assert.equal(c.f, 5);
  });

  it("returns identity without points and ignores non-finite ones", () => {
    assert.deepEqual(fitCalibration([], NOW), { ...IDENTITY_CALIBRATION, createdAt: NOW });
    const c = fitCalibration([{ measured: { x: NaN, y: 0 }, target: { x: 0, y: 0 } }, { measured: { x: 0, y: 0 }, target: { x: 3, y: 4 } }], NOW);
    assert.equal(c.points, 1);
    assert.equal(c.c, 3);
    assert.equal(c.f, 4);
  });
});

describe("calibrationPoints", () => {
  it("puts the centre first and keeps 10% insets", () => {
    const p9 = calibrationPoints(1000, 500);
    assert.equal(p9.length, 9);
    assert.deepEqual(p9[0], { x: 500, y: 250 });
    for (const p of p9) {
      assert.ok(p.x >= 100 && p.x <= 900 && p.y >= 50 && p.y <= 450);
    }
    assert.equal(new Set(p9.map((p) => `${p.x},${p.y}`)).size, 9);
    const p5 = calibrationPoints(1000, 500, 5);
    assert.deepEqual(p5, p9.slice(0, 5));
  });
});

describe("collectFixation", () => {
  const around = (cx: number, cy: number, n: number, jitter: number, seed = 3): ViewportPoint[] => {
    const r = rng(seed);
    return Array.from({ length: n }, () => ({ x: cx + r() * jitter, y: cy + r() * jitter }));
  };

  it("returns the median, robust to outliers", () => {
    const s = [...around(300, 200, 20, 5), { x: 2000, y: -500 }, { x: NaN, y: 1 }, { x: -900, y: 900 }];
    const p = collectFixation(s);
    assert.ok(p !== undefined);
    assert.ok(Math.hypot(p.x - 300, p.y - 200) < 3);
  });

  it("rejects a wide spread and too few samples", () => {
    assert.equal(collectFixation(around(300, 200, 30, 200)), undefined);
    assert.equal(collectFixation(around(300, 200, 3, 1)), undefined);
    assert.ok(collectFixation(around(300, 200, 3, 1), { minSamples: 3 }) !== undefined);
    assert.equal(collectFixation(around(300, 200, 30, 20), { maxSpreadPx: 2 }), undefined);
  });
});

describe("serialize/parse", () => {
  it("round-trips", () => {
    const c: Calibration = { a: 1.1, b: 0.1, c: -3, d: 0, e: 0.9, f: 4, createdAt: NOW, errorPx: 12.5, points: 9 };
    assert.deepEqual(parseCalibration(serializeCalibration(c)), c);
  });

  it("returns undefined on garbage", () => {
    for (const raw of [null, undefined, "", "nope", "null", "[]", "42", '{"a":1}',
      JSON.stringify({ a: 1, b: 0, c: 0, d: 0, e: 1, f: "0", createdAt: "", errorPx: 0, points: 0 }),
      JSON.stringify({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, createdAt: 5, errorPx: 0, points: 0 }),
      JSON.stringify({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, createdAt: "", errorPx: -1, points: 0 }),
      JSON.stringify({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0, createdAt: "", errorPx: 0, points: 1.5 }),
    ]) {
      assert.equal(parseCalibration(raw), undefined, String(raw));
    }
  });
});
