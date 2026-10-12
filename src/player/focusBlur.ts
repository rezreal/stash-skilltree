// Focus blur: while a gaze prompt targets a region of the video (eyes, face,
// hands, chest, ...), the picture around that region blurs, more the further
// from it and more the longer the window runs; the region stays sharp. Pure:
// the setting, the ramp over the window, the region as an ellipse and its
// smoothing, the canvas size, and the blur at a point (what the shader in
// focusShader.ts computes per pixel).
//
// The blur grows from 0 at the region's edge to full strength FOCUS_REACH
// ring units out; the unit is the region's size, capped so a large region
// (chest, legs) still leaves blur on screen.

import type { PromptSpec, Region } from "../prompts/types.ts";

export const DEFAULT_FOCUS_BLUR = 60;
/** blur (Gaussian sigma) at full reach at 100 %, CSS px */
export const MAX_FOCUS_BLUR_PX = 20;
/** the blur reaches full strength after this many seconds of the window (or at its end, if shorter) */
export const FOCUS_RAMP_SEC = 8;
/** after the window (or when the region is lost) the blur eases out over this long */
export const FOCUS_FADE_OUT_MS = 700;
/** the region was not found for this long: the blur eases out instead of holding a stale spot */
export const FOCUS_LOST_MS = 1500;
/** the ring unit: the region's size (geometric mean radius), at most this many CSS px */
export const FOCUS_RING_UNIT_MAX_PX = 100;
/** the blur is full this many ring units out from the region's edge */
export const FOCUS_REACH = 3.2;
/** the canvas is drawn at the device pixel ratio, but never wider or taller than this (device px) */
export const FOCUS_CANVAS_MAX_PX = 2560;

/**
 * Blur at full reach in CSS px for the focusBlur setting in percent: unset or
 * invalid -> 60 %, clamped to 0..100, 0 = off.
 */
export function focusBlurPx(setting: unknown): number {
  const n = typeof setting === "number" ? setting : typeof setting === "string" && setting.trim() !== "" ? Number(setting) : NaN;
  const pct = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_FOCUS_BLUR;
  return (pct / 100) * MAX_FOCUS_BLUR_PX;
}

/**
 * The prompt asks to look at a region of the video: any gaze target but
 * eyes_closed (no region) and off_screen (the target is outside the video).
 */
export function wantsFocusBlur(spec: PromptSpec | undefined): spec is PromptSpec {
  return spec?.check === "gaze" && spec.target !== undefined && spec.target !== "eyes_closed" && spec.target !== "off_screen";
}

/**
 * 0..1 how far the blur has built up at video time t: eased (smoothstep)
 * from the window's start to full after FOCUS_RAMP_SEC, or at the end of a
 * shorter window. 0 before the start or with an unknown time.
 */
export function focusRamp(spec: Pick<PromptSpec, "start" | "end">, t: number | undefined): number {
  if (t === undefined || !Number.isFinite(t)) return 0;
  const span = Math.min(FOCUS_RAMP_SEC, spec.end - spec.start);
  if (!(span > 0)) return t >= spec.start ? 1 : 0;
  const f = Math.min(1, Math.max(0, (t - spec.start) / span));
  return f * f * (3 - 2 * f);
}

/** An ellipse in the canvas's own coordinates (px from its top-left). */
export interface FocusEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * The sharp spot for a target region (viewport px) inside a canvas whose
 * top-left is at `origin`: an ellipse as is; a polygon by the ellipse through
 * its bounding box's corners (so the whole polygon stays sharp); undefined
 * without a region or for "outside" regions.
 */
export function focusEllipse(region: Region | undefined, origin: { x: number; y: number }): FocusEllipse | undefined {
  if (!region) return undefined;
  if (region.kind === "ellipse") return { cx: region.cx - origin.x, cy: region.cy - origin.y, rx: region.rx, ry: region.ry };
  if (region.kind === "polygon" && region.points.length > 0) {
    const xs = region.points.map((p) => p.x);
    const ys = region.points.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    return {
      cx: (x0 + x1) / 2 - origin.x,
      cy: (y0 + y1) / 2 - origin.y,
      rx: ((x1 - x0) / 2) * Math.SQRT2,
      ry: ((y1 - y0) / 2) * Math.SQRT2,
    };
  }
  return undefined;
}

/** time constant of the ellipse smoothing (the region updates at ~10 Hz and jitters) */
const SMOOTH_TAU_MS = 120;
/** a jump further than this many radii is a cut or a different person: no gliding across the frame */
const SNAP_RADII = 4;

/** Eases the drawn ellipse towards the latest region; a large jump snaps. */
export function smoothEllipse(prev: FocusEllipse | undefined, next: FocusEllipse, dtMs: number): FocusEllipse {
  if (!prev) return next;
  if (!(dtMs > 0)) return prev;
  const jump = Math.hypot(next.cx - prev.cx, next.cy - prev.cy);
  if (jump > SNAP_RADII * Math.max(prev.rx, prev.ry, next.rx, next.ry, 1)) return next;
  const a = 1 - Math.exp(-dtMs / SMOOTH_TAU_MS);
  const ease = (p: number, n: number) => p + (n - p) * a;
  return { cx: ease(prev.cx, next.cx), cy: ease(prev.cy, next.cy), rx: ease(prev.rx, next.rx), ry: ease(prev.ry, next.ry) };
}

/** The ring unit of an ellipse: its geometric mean radius, capped. */
export function ringUnit(e: FocusEllipse): number {
  return Math.min(Math.sqrt(Math.max(0, e.rx) * Math.max(0, e.ry)), FOCUS_RING_UNIT_MAX_PX);
}

/**
 * Blur sigma at point (x, y) for full-reach blur `sigma` (same units as the
 * ellipse): 0 inside the ellipse, growing linearly with the distance past its
 * edge (measured along the ray from its centre) to `sigma` at FOCUS_REACH
 * units. The fragment shader computes the same per pixel.
 */
export function blurAt(e: FocusEllipse, unit: number, sigma: number, x: number, y: number): number {
  const dx = x - e.cx;
  const dy = y - e.cy;
  const q = Math.hypot(dx / Math.max(e.rx, 1), dy / Math.max(e.ry, 1));
  const past = q > 1 ? Math.hypot(dx, dy) * (1 - 1 / q) : 0;
  return sigma * Math.min(1, Math.max(0, past / Math.max(unit * FOCUS_REACH, 1)));
}

/** Canvas backing size for a CSS box: the device pixel ratio, capped at FOCUS_CANVAS_MAX_PX. */
export function focusCanvasSize(cssW: number, cssH: number, dpr: number): { width: number; height: number; scale: number } {
  const big = Math.max(cssW, cssH, 1);
  const scale = Math.max(0.1, Math.min(dpr > 0 ? dpr : 1, FOCUS_CANVAS_MAX_PX / big));
  return { width: Math.max(1, Math.round(cssW * scale)), height: Math.max(1, Math.round(cssH * scale)), scale };
}
