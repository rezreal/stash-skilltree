// Focus blur: while a gaze prompt targets a region of the video (eyes, face,
// hands, chest, ...), the picture around that region blurs, more the further
// from it and more the longer the window runs; the region stays sharp. Pure:
// the setting, the ramp over the window, the region as an ellipse, its
// smoothing and the layer stack (blur + radial mask per layer) that
// FocusBlur.tsx draws with backdrop-filter.
//
// The rings grow outwards from the region's edge by multiples of the region's
// size, capped so a large region (chest, legs) still leaves blur on screen.
// The layers stack: each blurs what the ones below already blurred, so the
// outermost ring ends up at about sqrt(sum of squares) of their radii.

import type { PromptSpec, Region } from "../prompts/types.ts";

export const DEFAULT_FOCUS_BLUR = 60;
/** blur of the outermost layer at 100 %, CSS px */
export const MAX_FOCUS_BLUR_PX = 20;
/** the blur reaches full strength after this many seconds of the window (or at its end, if shorter) */
export const FOCUS_RAMP_SEC = 8;
/** after the window (or when the region is lost) the blur eases out over this long */
export const FOCUS_FADE_OUT_MS = 700;
/** the region was not found for this long: the blur eases out instead of holding a stale spot */
export const FOCUS_LOST_MS = 1500;
/** the rings' unit: the region's size (geometric mean radius), at most this many CSS px */
export const FOCUS_RING_UNIT_MAX_PX = 100;

/**
 * Blur of the outermost layer in CSS px for the focusBlur setting in
 * percent: unset or invalid -> 60 %, clamped to 0..100, 0 = off.
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

/** An ellipse in the overlay's own coordinates (px from its top-left). */
export interface FocusEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * The sharp spot for a target region (viewport px) inside an overlay whose
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

/**
 * The rings, in ring units out from the region's edge: sharp inside `from`,
 * the layer's full blur from `to` outwards; `share` of the outermost blur.
 * Regions are already padded to tracker accuracy, so the first ring starts
 * right at the edge.
 */
export const FOCUS_RINGS: readonly { from: number; to: number; share: number }[] = [
  { from: 0, to: 0.6, share: 0.25 },
  { from: 0.6, to: 1.6, share: 0.5 },
  { from: 1.6, to: 3.2, share: 1 },
];

export interface FocusLayer {
  /** CSS px; 0 = the layer is not drawn */
  blurPx: number;
  /** CSS mask-image: transparent (sharp) inside, opaque (blurred) outside */
  mask: string;
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`;

/** The ring unit of an ellipse: its geometric mean radius, capped. */
export function ringUnit(e: FocusEllipse): number {
  return Math.min(Math.sqrt(Math.max(0, e.rx) * Math.max(0, e.ry)), FOCUS_RING_UNIT_MAX_PX);
}

/** The layer stack for the ellipse at `strength` (blur px of the outermost layer, ramp applied). */
export function focusLayers(e: FocusEllipse, strength: number): FocusLayer[] {
  const u = ringUnit(e);
  return FOCUS_RINGS.map((ring) => {
    const blurPx = strength > 0 ? Math.round(strength * ring.share * 10) / 10 : 0;
    // the gradient's ending shape is the ring's outer edge; past it the last stop (opaque) continues.
    // The inner edge is the region grown by `from` units, as a share of the outer edge (mean of the axes).
    const outX = e.rx + ring.to * u;
    const outY = e.ry + ring.to * u;
    const inner = Math.round(((e.rx + e.ry + 2 * ring.from * u) / (outX + outY)) * 1000) / 10;
    const mask = `radial-gradient(ellipse ${px(outX)} ${px(outY)} at ${px(e.cx)} ${px(e.cy)}, transparent ${inner}%, #000 100%)`;
    return { blurPx, mask };
  });
}
