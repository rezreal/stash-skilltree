import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calloutMode, edgePoint, insideRect, placeCallout, relativeTo } from "../../src/session/gazeCallout.ts";

const viewport = { width: 1000, height: 800 };
const player = { left: 100, top: 100, right: 740, bottom: 460 };

describe("calloutMode", () => {
  it("fixed when looking elsewhere on the page", () => {
    assert.equal(calloutMode({ point: { x: 900, y: 700 }, valid: true, viewport, target: player, fullscreen: false }), "fixed");
  });
  it("falls back for invalid, off-screen or missing gaze, or gaze on the player", () => {
    const base = { valid: true, viewport, target: player, fullscreen: false };
    assert.equal(calloutMode({ ...base, point: { x: 900, y: 700 }, valid: false }), undefined);
    assert.equal(calloutMode({ ...base, point: undefined }), undefined);
    assert.equal(calloutMode({ ...base, point: { x: Number.NaN, y: 3 } }), undefined);
    assert.equal(calloutMode({ ...base, point: { x: -5, y: 300 } }), undefined);
    assert.equal(calloutMode({ ...base, point: { x: 300, y: 900 } }), undefined);
    assert.equal(calloutMode({ ...base, point: { x: 300, y: 300 } }), undefined);
    assert.equal(calloutMode({ ...base, point: { x: 900, y: 700 }, target: null }), undefined);
  });
  it("overlay in fullscreen", () => {
    const full = { left: 0, top: 0, right: 1000, bottom: 800 };
    assert.equal(calloutMode({ point: { x: 20, y: 20 }, valid: true, viewport, target: full, fullscreen: true }), "overlay");
  });
});

describe("placeCallout", () => {
  const bounds = { left: 0, top: 0, right: 1000, bottom: 800 };
  const size = { width: 280, height: 84 };

  it("centres the box on the gaze point", () => {
    const p = placeCallout({ point: { x: 500, y: 600 }, target: player, bounds, size });
    assert.equal(p.left, 360);
    assert.equal(p.top, 558);
  });

  it("clamps to the bounds with a margin", () => {
    const tl = placeCallout({ point: { x: 2, y: 3 }, target: player, bounds, size });
    assert.deepEqual([tl.left, tl.top], [8, 8]);
    const br = placeCallout({ point: { x: 999, y: 799 }, target: player, bounds, size, margin: 10 });
    assert.deepEqual([br.left, br.top], [1000 - 10 - 280, 800 - 10 - 84]);
  });

  it("sticks to the top-left margin when the box is larger than the bounds", () => {
    const tiny = { left: 50, top: 50, right: 200, bottom: 100 };
    const p = placeCallout({ point: { x: 120, y: 70 }, target: player, bounds: tiny, size });
    assert.deepEqual([p.left, p.top], [58, 58]);
  });

  it("aims the arrow at the target's centre", () => {
    // player centre (420, 280)
    assert.equal(placeCallout({ point: { x: 900, y: 280 }, target: player, bounds, size }).angleDeg, 180);
    assert.equal(placeCallout({ point: { x: 420, y: 700 }, target: player, bounds, size }).angleDeg, -90);
    assert.equal(placeCallout({ point: { x: 20, y: 280 }, target: player, bounds, size }).angleDeg, 0);
    assert.equal(placeCallout({ point: { x: 420, y: 20 }, target: player, bounds, size }).angleDeg, 90);
    const diag = placeCallout({ point: { x: 820, y: 680 }, target: player, bounds, size });
    assert.ok(Math.abs(diag.angleDeg - -135) < 1e-9);
  });

  it("puts the arrow on the edge facing the target", () => {
    const left = placeCallout({ point: { x: 900, y: 280 }, target: player, bounds, size });
    assert.deepEqual([left.arrowX, left.arrowY], [0, 42]);
    const up = placeCallout({ point: { x: 420, y: 700 }, target: player, bounds, size });
    assert.deepEqual([up.arrowX, up.arrowY], [140, 0]);
  });
});

describe("helpers", () => {
  it("edgePoint leaves through the nearer side", () => {
    assert.deepEqual(edgePoint({ width: 200, height: 100 }, 0), { x: 200, y: 50 });
    assert.deepEqual(edgePoint({ width: 200, height: 100 }, 90), { x: 100, y: 100 });
    assert.deepEqual(edgePoint({ width: 200, height: 100 }, 45), { x: 150, y: 100 });
  });
  it("insideRect includes the edges; relativeTo shifts", () => {
    assert.equal(insideRect({ x: 100, y: 460 }, player), true);
    assert.equal(insideRect({ x: 99, y: 200 }, player), false);
    assert.deepEqual(relativeTo(player, { left: 100, top: 50 }), { left: 0, top: 50, right: 640, bottom: 410 });
  });
});
