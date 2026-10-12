// Gaze samples -> viewport points for the play screens, and viewport
// targets -> the tracker's normalized screen coordinates for the device
// calibration. Pure: the window geometry is read by the caller
// (readWindowGeometry from src/gaze) at sample time and passed in.
import type { Calibration, GazeSample, ScreenRect, ViewportPoint, WindowGeometry } from "../gaze/types.ts";
import { applyCalibration, screenToViewport, viewportToScreen } from "../gaze/index.ts";

/** One gaze sample mapped to the viewport. */
export interface MappedSample {
  /** ms, performance.now() timebase (GazeSample.t) */
  t: number;
  valid: boolean;
  /** viewport point from the geometry alone, before the stored calibration */
  raw?: ViewportPoint;
  /** viewport point after the stored calibration */
  point?: ViewportPoint;
}

/** Invalid or non-finite samples carry no point. */
export function mapGazeSample(
  sample: GazeSample,
  geo: WindowGeometry,
  calibration: Calibration,
  screen?: ScreenRect,
): MappedSample {
  if (!sample.valid || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return { t: sample.t, valid: false };
  const raw = screenToViewport(sample, geo, screen);
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return { t: sample.t, valid: false };
  return { t: sample.t, valid: true, raw, point: applyCalibration(raw, calibration) };
}

/** Size of the tracked monitor in device px: the tracker's report, else window.screen × devicePixelRatio. */
export function monitorSize(
  screen: ScreenRect | undefined,
  cssScreen: { width: number; height: number },
  devicePixelRatio: number,
): { width: number; height: number } {
  if (screen && screen.width > 0 && screen.height > 0) return { width: screen.width, height: screen.height };
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return { width: cssScreen.width * dpr, height: cssScreen.height * dpr };
}

/**
 * A viewport target in the tracker's [0,1]² screen coordinates (inverse of
 * the sample mapping), clamped to the screen.
 */
export function deviceTarget(
  p: ViewportPoint,
  geo: WindowGeometry,
  monitor: { width: number; height: number },
  screen?: ScreenRect,
): ViewportPoint {
  const s = viewportToScreen(p, geo, screen);
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
  return { x: clamp(s.x / monitor.width), y: clamp(s.y / monitor.height) };
}

/** Euclidean distance in CSS px. */
export function distancePx(a: ViewportPoint, b: ViewportPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
