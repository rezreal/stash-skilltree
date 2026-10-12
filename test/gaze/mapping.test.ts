import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyCalibration,
  chromeInsets,
  readWindowGeometry,
  screenToViewport,
  viewportToScreen,
} from "../../src/gaze/mapping.ts";
import { IDENTITY_CALIBRATION } from "../../src/gaze/types.ts";
import type { WindowGeometry } from "../../src/gaze/types.ts";

function geo(over: Partial<WindowGeometry> = {}): WindowGeometry {
  return {
    screenX: 100,
    screenY: 50,
    outerWidth: 1216,
    outerHeight: 900,
    innerWidth: 1200,
    innerHeight: 800,
    devicePixelRatio: 1,
    fullscreen: false,
    ...over,
  };
}

function close(a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-9): void {
  assert.ok(Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

describe("chromeInsets", () => {
  it("splits side borders evenly and puts the rest on top", () => {
    assert.deepEqual(chromeInsets(geo()), { left: 8, top: 92 });
  });
  it("is zero in fullscreen", () => {
    assert.deepEqual(chromeInsets(geo({ fullscreen: true })), { left: 0, top: 0 });
  });
  it("never goes negative", () => {
    assert.deepEqual(chromeInsets(geo({ outerWidth: 1000, outerHeight: 700 })), { left: 0, top: 0 });
  });
});

describe("screenToViewport", () => {
  it("maps a windowed browser with chrome", () => {
    // viewport origin on screen = (100 + 8, 50 + 92)
    close(screenToViewport({ x: 108, y: 142 }, geo()), { x: 0, y: 0 });
    close(screenToViewport({ x: 708, y: 542 }, geo()), { x: 600, y: 400 });
  });

  it("maps fullscreen at the monitor origin", () => {
    const g = geo({ screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1080, innerWidth: 1920, innerHeight: 1080, fullscreen: true });
    close(screenToViewport({ x: 960, y: 540 }, g), { x: 960, y: 540 });
  });

  it("divides device px by devicePixelRatio", () => {
    const g = geo({ screenX: 0, screenY: 0, fullscreen: true, devicePixelRatio: 1.5 });
    close(screenToViewport({ x: 1500, y: 750 }, g), { x: 1000, y: 500 });
  });

  it("adds the tracked monitor's origin", () => {
    // second monitor right of a 1920px primary, window fullscreen on it
    const g = geo({ screenX: 1920, screenY: 0, fullscreen: true });
    close(screenToViewport({ x: 100, y: 200 }, g, { x: 1920, y: 0, width: 2560, height: 1440 }), { x: 100, y: 200 });
  });

  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const fullscreen of [false, true]) {
      it(`round-trips (dpr ${dpr}, ${fullscreen ? "fullscreen" : "windowed"}, second monitor)`, () => {
        const g = geo({ devicePixelRatio: dpr, fullscreen, screenX: 1700, screenY: -8 });
        const screen = { x: 1920 * dpr, y: 0, width: 2560, height: 1440 };
        for (const p of [{ x: 0, y: 0 }, { x: 333.3, y: 77.7 }, { x: 1199, y: 799 }]) {
          close(screenToViewport(viewportToScreen(p, g, screen), g, screen), p);
          close(screenToViewport(viewportToScreen(p, g), g), p);
        }
      });
    }
  }
});

describe("applyCalibration", () => {
  it("identity leaves points alone, affine transforms them", () => {
    assert.deepEqual(applyCalibration({ x: 3, y: 4 }, IDENTITY_CALIBRATION), { x: 3, y: 4 });
    const c = { ...IDENTITY_CALIBRATION, a: 2, b: 1, c: 10, d: 0, e: 0.5, f: -5 };
    assert.deepEqual(applyCalibration({ x: 3, y: 4 }, c), { x: 20, y: -3 });
  });
});

describe("readWindowGeometry", () => {
  it("reads window fields and fullscreen state", () => {
    const win = { screenX: 1, screenY: 2, outerWidth: 3, outerHeight: 4, innerWidth: 5, innerHeight: 6, devicePixelRatio: 0 };
    assert.deepEqual(readWindowGeometry(win, { fullscreenElement: null }), {
      screenX: 1, screenY: 2, outerWidth: 3, outerHeight: 4, innerWidth: 5, innerHeight: 6, devicePixelRatio: 1, fullscreen: false,
    });
    assert.equal(readWindowGeometry(win, { fullscreenElement: {} }).fullscreen, true);
  });
});
