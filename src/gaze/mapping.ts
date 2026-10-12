// Screen -> viewport mapping for gaze samples. Pure; the window geometry is
// read by the caller (readWindowGeometry) at sample time.
//
// Geometry model and its assumptions:
// - A tracker sample is in DEVICE pixels of the tracked monitor, origin at
//   that monitor's top-left. `screen` (when given) is that monitor's origin
//   in device pixels of the virtual desktop and is added first; for the
//   primary monitor (or when the tracker already reports desktop pixels)
//   leave it out / at 0,0.
// - Desktop device px / devicePixelRatio = the CSS px that window.screenX/Y
//   are measured in. This holds for a single monitor and for monitors that
//   share one scale factor; mixed-DPI setups need the affine calibration on
//   top (which absorbs any remaining offset and scale).
// - Browser chrome: the side borders are equal, chromeLeft =
//   (outerWidth - innerWidth) / 2, and the bottom border equals a side
//   border, so chromeTop = outerHeight - innerHeight - chromeLeft (tabs,
//   address bar, bookmarks bar). On Windows a maximized window has
//   screenX = -8 with 8px invisible borders, which this model handles.
// - Fullscreen: no chrome, the viewport starts at screenX/Y (= the monitor
//   origin).
// - Browser zoom changes devicePixelRatio and inner sizes together; it is
//   covered as long as the geometry is read at sample time.

import type { Calibration, ScreenRect, ViewportPoint, WindowGeometry } from "./types.ts";

export interface ChromeInsets {
  left: number;
  top: number;
}

/** Offset of the viewport inside the outer window, CSS px. */
export function chromeInsets(geo: WindowGeometry): ChromeInsets {
  if (geo.fullscreen) return { left: 0, top: 0 };
  const left = Math.max(0, (geo.outerWidth - geo.innerWidth) / 2);
  const top = Math.max(0, geo.outerHeight - geo.innerHeight - left);
  return { left, top };
}

function dprOf(geo: WindowGeometry): number {
  return geo.devicePixelRatio > 0 && Number.isFinite(geo.devicePixelRatio) ? geo.devicePixelRatio : 1;
}

/** Tracker screen px (device px of the tracked monitor) -> viewport CSS px. */
export function screenToViewport(
  sample: { x: number; y: number },
  geo: WindowGeometry,
  screen?: ScreenRect,
): ViewportPoint {
  const dpr = dprOf(geo);
  const chrome = chromeInsets(geo);
  const dx = sample.x + (screen?.x ?? 0);
  const dy = sample.y + (screen?.y ?? 0);
  return {
    x: dx / dpr - geo.screenX - chrome.left,
    y: dy / dpr - geo.screenY - chrome.top,
  };
}

/** Inverse of screenToViewport (mouse source, tests). */
export function viewportToScreen(
  p: ViewportPoint,
  geo: WindowGeometry,
  screen?: ScreenRect,
): { x: number; y: number } {
  const dpr = dprOf(geo);
  const chrome = chromeInsets(geo);
  return {
    x: (p.x + geo.screenX + chrome.left) * dpr - (screen?.x ?? 0),
    y: (p.y + geo.screenY + chrome.top) * dpr - (screen?.y ?? 0),
  };
}

/** x' = a*x + b*y + c, y' = d*x + e*y + f */
export function applyCalibration(p: ViewportPoint, c: Calibration): ViewportPoint {
  return { x: c.a * p.x + c.b * p.y + c.c, y: c.d * p.x + c.e * p.y + c.f };
}

/** What readWindowGeometry needs from window (structurally, so tests can fake it). */
export interface WindowLike {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
}

/** Reads the current window placement; call it per sample (windows move). */
export function readWindowGeometry(
  win: WindowLike = globalThis.window,
  doc: { fullscreenElement: unknown } | undefined = globalThis.document,
): WindowGeometry {
  return {
    screenX: win.screenX,
    screenY: win.screenY,
    outerWidth: win.outerWidth,
    outerHeight: win.outerHeight,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio || 1,
    fullscreen: doc !== undefined && doc.fullscreenElement != null,
  };
}
