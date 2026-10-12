import { test } from "node:test";
import assert from "node:assert/strict";
import { createFlashLimiter, snapFlashIntensity } from "../../src/player/flash.ts";

test("limiter: at most 3 flashes per second", () => {
  const l = createFlashLimiter({ maxPerSecond: 3 });
  const allowed = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900].filter((t) => l.allow(t));
  assert.deepEqual(allowed, [0, 100, 200]);
});

test("limiter: sliding window, not fixed buckets", () => {
  const l = createFlashLimiter({ maxPerSecond: 3 });
  assert.equal(l.allow(900), true);
  assert.equal(l.allow(950), true);
  assert.equal(l.allow(999), true);
  assert.equal(l.allow(1001), false); // a fixed 1000 ms bucket would allow this
  assert.equal(l.allow(1899), false); // 900 still inside (1899 - 900 < 1000)
  assert.equal(l.allow(1900), true); // 900 left the window
  assert.equal(l.allow(1940), false);
  assert.equal(l.allow(1950), true);
});

test("limiter: any 1-second window holds at most 3 allowed flashes", () => {
  const l = createFlashLimiter();
  const allowed: number[] = [];
  for (let t = 0; t < 10_000; t += 37) if (l.allow(t)) allowed.push(t);
  for (let i = 3; i < allowed.length; i++) assert.ok(allowed[i] - allowed[i - 3] >= 1000);
  assert.ok(allowed.length >= 27);
});

test("limiter: reset and a custom cap", () => {
  const l = createFlashLimiter({ maxPerSecond: 1 });
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(500), false);
  l.reset();
  assert.equal(l.allow(600), true);
});

test("snapFlashIntensity: default 60 %, clamped, 0 = off", () => {
  assert.equal(snapFlashIntensity(undefined), 0.6);
  assert.equal(snapFlashIntensity(""), 0.6);
  assert.equal(snapFlashIntensity("abc"), 0.6);
  assert.equal(snapFlashIntensity(0), 0);
  assert.equal(snapFlashIntensity(25), 0.25);
  assert.equal(snapFlashIntensity("80"), 0.8);
  assert.equal(snapFlashIntensity(250), 1);
  assert.equal(snapFlashIntensity(-5), 0);
});
