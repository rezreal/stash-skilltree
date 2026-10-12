import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_RAMP_SEC,
  FOCUS_RING_UNIT_MAX_PX,
  focusBlurPx,
  blurAt,
  FOCUS_CANVAS_MAX_PX,
  FOCUS_REACH,
  focusCanvasSize,
  FOCUS_PULSE_BLUR,
  FOCUS_PULSE_REACH,
  FOCUS_PULSE_SEC,
  focusPulse,
  focusEllipse,
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

test("blurAt: sharp inside the region, growing past its edge to full at the reach", () => {
  const e = { cx: 200, cy: 150, rx: 80, ry: 20 };
  const unit = ringUnit(e); // 40
  assert.equal(blurAt(e, unit, 12, 200, 150), 0);
  assert.equal(blurAt(e, unit, 12, 270, 150), 0);
  // along x: past the edge by half the reach (0.5 * 3.2 * 40 = 64 px) -> half the blur
  assert.ok(Math.abs(blurAt(e, unit, 12, 200 + 80 + 64, 150) - 6) < 1e-9);
  // along y the edge is closer: the same distance past it gives the same blur
  assert.ok(Math.abs(blurAt(e, unit, 12, 200, 150 + 20 + 64) - 6) < 1e-9);
  assert.equal(blurAt(e, unit, 12, 200 + 80 + FOCUS_REACH * 40, 150), 12);
  assert.equal(blurAt(e, unit, 12, 2000, 1500), 12);
  assert.ok(blurAt(e, unit, 12, 300, 150) < blurAt(e, unit, 12, 320, 150));
});

test("focusCanvasSize: device pixels, capped for huge screens", () => {
  assert.deepEqual(focusCanvasSize(1280, 720, 1), { width: 1280, height: 720, scale: 1 });
  assert.deepEqual(focusCanvasSize(1280, 720, 2), { width: 2560, height: 1440, scale: 2 });
  const big = focusCanvasSize(1920, 1080, 2);
  assert.equal(big.width, FOCUS_CANVAS_MAX_PX);
  assert.equal(big.height, 1440);
  assert.equal(focusCanvasSize(800, 600, 0).scale, 1);
});

test("focusPulse: strong and close at the start, soft and far half a breath in, back after a full one", () => {
  const ms = FOCUS_PULSE_SEC * 1000;
  assert.deepEqual(focusPulse(0), { reach: 1, blur: 1 });
  const half = focusPulse(ms / 2);
  assert.ok(Math.abs(half.reach - (1 + FOCUS_PULSE_REACH)) < 1e-9);
  assert.ok(Math.abs(half.blur - (1 - FOCUS_PULSE_BLUR)) < 1e-9);
  const quarter = focusPulse(ms / 4);
  assert.ok(Math.abs(quarter.reach - (1 + FOCUS_PULSE_REACH / 2)) < 1e-9);
  const full = focusPulse(ms);
  assert.ok(Math.abs(full.reach - 1) < 1e-9 && Math.abs(full.blur - 1) < 1e-9);
  assert.deepEqual(focusPulse(ms / 2, true), { reach: 1, blur: 1 });
  assert.deepEqual(focusPulse(NaN), { reach: 1, blur: 1 });
});

test("blurAt: a wider reach softens the same spot", () => {
  const e = { cx: 0, cy: 0, rx: 40, ry: 40 };
  const near = blurAt(e, 40, 12, 140, 0);
  const wide = blurAt(e, 40, 12, 140, 0, FOCUS_REACH * (1 + FOCUS_PULSE_REACH));
  assert.ok(wide < near);
});
