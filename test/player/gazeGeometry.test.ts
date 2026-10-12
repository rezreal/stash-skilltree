import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_CALIBRATION, type Calibration, type WindowGeometry } from "../../src/gaze/types.ts";
import { deviceTarget, distancePx, mapGazeSample, monitorSize } from "../../src/player/gazeGeometry.ts";

// fullscreen on a 1920×1080 monitor at dpr 1: screen px = viewport px
const FULL: WindowGeometry = {
  screenX: 0,
  screenY: 0,
  outerWidth: 1920,
  outerHeight: 1080,
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  fullscreen: true,
};

test("mapGazeSample maps valid samples and applies the calibration", () => {
  const shift: Calibration = { ...IDENTITY_CALIBRATION, c: 10, f: -5, points: 9 };
  assert.deepEqual(mapGazeSample({ t: 5, x: 100, y: 200, valid: true }, FULL, IDENTITY_CALIBRATION), {
    t: 5,
    valid: true,
    raw: { x: 100, y: 200 },
    point: { x: 100, y: 200 },
  });
  assert.deepEqual(mapGazeSample({ t: 5, x: 100, y: 200, valid: true }, FULL, shift).point, { x: 110, y: 195 });
  // windowed at dpr 2: the chrome and the scale come out
  const windowed: WindowGeometry = { ...FULL, fullscreen: false, devicePixelRatio: 2, outerHeight: 1080, innerHeight: 1000, outerWidth: 1920, innerWidth: 1920 };
  assert.deepEqual(mapGazeSample({ t: 1, x: 400, y: 400, valid: true }, windowed, IDENTITY_CALIBRATION).raw, { x: 200, y: 120 });
});

test("mapGazeSample drops invalid and non-finite samples", () => {
  assert.deepEqual(mapGazeSample({ t: 7, x: 100, y: 200, valid: false }, FULL, IDENTITY_CALIBRATION), { t: 7, valid: false });
  assert.deepEqual(mapGazeSample({ t: 7, x: Number.NaN, y: 200, valid: true }, FULL, IDENTITY_CALIBRATION), { t: 7, valid: false });
});

test("monitorSize prefers the tracker's screen, else window.screen × dpr", () => {
  assert.deepEqual(monitorSize({ x: 0, y: 0, width: 2560, height: 1440 }, { width: 1280, height: 720 }, 1.5), { width: 2560, height: 1440 });
  assert.deepEqual(monitorSize(undefined, { width: 1280, height: 720 }, 1.5), { width: 1920, height: 1080 });
  assert.deepEqual(monitorSize({ x: 0, y: 0, width: 0, height: 0 }, { width: 1280, height: 720 }, 0), { width: 1280, height: 720 });
});

test("deviceTarget inverts the mapping into [0,1]² of the tracked screen", () => {
  const monitor = { width: 1920, height: 1080 };
  assert.deepEqual(deviceTarget({ x: 960, y: 540 }, FULL, monitor), { x: 0.5, y: 0.5 });
  assert.deepEqual(deviceTarget({ x: 192, y: 108 }, FULL, monitor), { x: 0.1, y: 0.1 });
  // a sample at the returned position maps back onto the target
  const geo: WindowGeometry = { ...FULL, fullscreen: false, screenX: 100, screenY: 50, outerWidth: 1600, innerWidth: 1584, outerHeight: 900, innerHeight: 800, devicePixelRatio: 1.25 };
  const big = { width: 2400, height: 1350 };
  const n = deviceTarget({ x: 300, y: 200 }, geo, big);
  const back = mapGazeSample({ t: 0, x: n.x * big.width, y: n.y * big.height, valid: true }, geo, IDENTITY_CALIBRATION).raw!;
  assert.ok(distancePx(back, { x: 300, y: 200 }) < 1e-6);
  // clamped to the screen
  assert.deepEqual(deviceTarget({ x: -500, y: 5000 }, FULL, monitor), { x: 0, y: 1 });
});
