import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_RAMP_SEC,
  FOCUS_RING_UNIT_MAX_PX,
  focusBlurPx,
  focusEllipse,
  focusLayers,
  focusRamp,
  ringUnit,
  smoothEllipse,
  wantsFocusBlur,
} from "../../src/player/focusBlur.ts";
import { GAZE_TARGETS, type PromptSpec } from "../../src/prompts/types.ts";

const spec = (over: Partial<PromptSpec> = {}): PromptSpec => ({
  markerId: "m1",
  check: "gaze",
  start: 10,
  end: 30,
  title: "",
  target: "eyes",
  holdSec: 2,
  ...over,
});

test("focusBlurPx: default 60 % of 20 px, clamped, 0 = off", () => {
  assert.equal(focusBlurPx(undefined), 12);
  assert.equal(focusBlurPx("x"), 12);
  assert.equal(focusBlurPx(0), 0);
  assert.equal(focusBlurPx("50"), 10);
  assert.equal(focusBlurPx(250), 20);
  assert.equal(focusBlurPx(-3), 0);
});

test("wantsFocusBlur: gaze prompts on a region of the video", () => {
  const on = GAZE_TARGETS.filter((target) => wantsFocusBlur(spec({ target })));
  assert.deepEqual(
    on,
    GAZE_TARGETS.filter((t) => t !== "eyes_closed" && t !== "off_screen"),
  );
  assert.equal(wantsFocusBlur(spec({ target: undefined })), false);
  assert.equal(wantsFocusBlur(spec({ check: "action", target: undefined, action: "eyes_closed" })), false);
  assert.equal(wantsFocusBlur(undefined), false);
});

test("focusRamp: eases from the start to full after the ramp, or at the end of a short window", () => {
  const s = spec();
  assert.equal(focusRamp(s, undefined), 0);
  assert.equal(focusRamp(s, NaN), 0);
  assert.equal(focusRamp(s, 9), 0);
  assert.equal(focusRamp(s, 10), 0);
  assert.equal(focusRamp(s, 10 + FOCUS_RAMP_SEC / 2), 0.5);
  assert.ok(focusRamp(s, 11) < focusRamp(s, 12));
  assert.equal(focusRamp(s, 10 + FOCUS_RAMP_SEC), 1);
  assert.equal(focusRamp(s, 29), 1);
  const short = spec({ start: 10, end: 12 });
  assert.equal(focusRamp(short, 11), 0.5);
  assert.equal(focusRamp(short, 12), 1);
  assert.equal(focusRamp(spec({ start: 5, end: 5 }), 5), 1);
});

test("focusEllipse: ellipse moved into the overlay, polygon through its box's corners, none for outside", () => {
  const origin = { x: 100, y: 50 };
  assert.deepEqual(focusEllipse({ kind: "ellipse", cx: 300, cy: 200, rx: 60, ry: 30 }, origin), { cx: 200, cy: 150, rx: 60, ry: 30 });
  const poly = focusEllipse({ kind: "polygon", points: [{ x: 100, y: 50 }, { x: 300, y: 50 }, { x: 200, y: 150 }] }, origin)!;
  assert.deepEqual({ cx: poly.cx, cy: poly.cy }, { cx: 100, cy: 50 });
  assert.ok(Math.abs(poly.rx - 100 * Math.SQRT2) < 1e-9);
  assert.ok(Math.abs(poly.ry - 50 * Math.SQRT2) < 1e-9);
  // the box's corners lie on the ellipse: the whole polygon stays sharp
  assert.ok(Math.abs((100 / poly.rx) ** 2 + (50 / poly.ry) ** 2 - 1) < 1e-9);
  assert.equal(focusEllipse({ kind: "outside", of: { left: 0, top: 0, right: 10, bottom: 10 } }, origin), undefined);
  assert.equal(focusEllipse({ kind: "polygon", points: [] }, origin), undefined);
  assert.equal(focusEllipse(undefined, origin), undefined);
});

test("smoothEllipse: starts at the region, eases towards it, snaps on a cut", () => {
  const a = { cx: 100, cy: 100, rx: 50, ry: 25 };
  assert.deepEqual(smoothEllipse(undefined, a, 16), a);
  assert.deepEqual(smoothEllipse(a, { ...a, cx: 140 }, 0), a);
  const eased = smoothEllipse(a, { ...a, cx: 140 }, 16);
  assert.ok(eased.cx > 100 && eased.cx < 140);
  const cut = { cx: 600, cy: 100, rx: 50, ry: 25 };
  assert.deepEqual(smoothEllipse(a, cut, 16), cut);
});

test("ringUnit: the region's mean radius, capped for large regions", () => {
  assert.equal(ringUnit({ cx: 0, cy: 0, rx: 80, ry: 20 }), 40);
  assert.equal(ringUnit({ cx: 0, cy: 0, rx: 300, ry: 500 }), FOCUS_RING_UNIT_MAX_PX);
});

test("focusLayers: three rings out from the region's edge, blur growing outwards", () => {
  // unit = sqrt(80 * 20) = 40
  const layers = focusLayers({ cx: 200, cy: 150, rx: 80, ry: 20 }, 12);
  assert.deepEqual(
    layers.map((l) => l.blurPx),
    [3, 6, 12],
  );
  // ring 1: sharp right up to the region (0 units), full from 0.6 units = 24 px out
  assert.equal(layers[0]!.mask, "radial-gradient(ellipse 104px 44px at 200px 150px, transparent 67.6%, #000 100%)");
  // ring 3: from 1.6 units (64 px) to 3.2 units (128 px) out
  assert.equal(layers[2]!.mask, "radial-gradient(ellipse 208px 148px at 200px 150px, transparent 64%, #000 100%)");
  assert.deepEqual(
    focusLayers({ cx: 0, cy: 0, rx: 10, ry: 10 }, 0).map((l) => l.blurPx),
    [0, 0, 0],
  );
});

test("focusLayers: a large region keeps its rings within the capped unit", () => {
  const [, , outer] = focusLayers({ cx: 500, cy: 400, rx: 300, ry: 400 }, 12);
  // 3.2 * 100 px beyond the region, not 3.2 * sqrt(300 * 400)
  assert.match(outer!.mask, /^radial-gradient\(ellipse 620px 720px /);
});
