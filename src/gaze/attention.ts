// Attention from gaze: is the user looking at a target rect (the video)?
// A small stateful classifier over a sliding window of viewport-mapped
// samples. Time is injected (sample.t and nowMs share the gaze timebase);
// no DOM. The UI feeds it mapped + calibrated samples and asks about the
// video's getBoundingClientRect() on its tick.

import { DEFAULT_GAZE_ATTENTION } from "./types.ts";
import type {
  DOMRectLike,
  GazeAttentionParams,
  GazeAttentionResult,
  GazeAttentionSample,
  ViewportPoint,
} from "./types.ts";

const MAX_BUFFER = 4096;

/** p inside rect grown by margin on every side (edges count as inside). */
export function insideRect(p: ViewportPoint, rect: DOMRectLike, margin = 0): boolean {
  return (
    p.x >= rect.left - margin &&
    p.x <= rect.right + margin &&
    p.y >= rect.top - margin &&
    p.y <= rect.bottom + margin
  );
}

export interface GazeAttention {
  readonly params: GazeAttentionParams;
  push(sample: GazeAttentionSample): void;
  attending(target: DOMRectLike, nowMs: number): GazeAttentionResult;
  reset(): void;
}

type Mark = "in" | "out" | "invalid";

export function createGazeAttention(params?: Partial<GazeAttentionParams>): GazeAttention {
  const p: GazeAttentionParams = { ...DEFAULT_GAZE_ATTENTION, ...params };
  // enough history to measure an invalid run reaching into the window and
  // to know the state at the window's start
  const horizon = p.windowMs + 2 * p.blinkMs + p.staleMs;
  let buf: GazeAttentionSample[] = [];

  function push(s: GazeAttentionSample): void {
    if (!Number.isFinite(s.t)) return;
    const last = buf[buf.length - 1];
    if (last === undefined || s.t >= last.t) buf.push(s);
    else {
      // out of order: insert in place (rare)
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1]!.t > s.t) i--;
      buf.splice(i, 0, s);
    }
    const cutoff = buf[buf.length - 1]!.t - horizon;
    let drop = 0;
    while (drop < buf.length - 1 && buf[drop]!.t < cutoff) drop++;
    if (buf.length - drop > MAX_BUFFER) drop = buf.length - MAX_BUFFER;
    if (drop > 0) buf = buf.slice(drop);
  }

  function attending(target: DOMRectLike, nowMs: number): GazeAttentionResult {
    // ignore samples from the future (clock skew between pushes and ticks)
    let n = buf.length;
    while (n > 0 && buf[n - 1]!.t > nowMs) n--;
    const last = buf[n - 1];
    if (last === undefined || nowMs - last.t > p.staleMs) {
      return { attending: false, reason: "stale", insideShare: 0 };
    }

    const marks: Mark[] = [];
    for (let i = 0; i < n; i++) {
      const s = buf[i]!;
      marks.push(s.valid && s.point && Number.isFinite(s.point.x) && Number.isFinite(s.point.y)
        ? insideRect(s.point, target, p.marginPx) ? "in" : "out"
        : "invalid");
    }

    // invalid runs: short ones (blinks) take the state around them, long ones stay invalid
    const eff: Mark[] = [...marks];
    let ongoing: "none" | "blink" | "long" = "none";
    for (let i = 0; i < n; ) {
      if (marks[i] !== "invalid") {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && marks[j + 1] === "invalid") j++;
      const isOngoing = j === n - 1;
      const end = isOngoing ? nowMs : buf[j + 1]!.t;
      const duration = end - buf[i]!.t;
      const short = duration <= p.blinkMs;
      if (short) {
        const fill = i > 0 ? marks[i - 1]! : j + 1 < n ? marks[j + 1]! : "invalid";
        for (let k = i; k <= j; k++) eff[k] = fill;
      }
      if (isOngoing) ongoing = short ? "blink" : "long";
      i = j + 1;
    }

    // time-weighted share of the window that is inside; each sample holds
    // until the next one (gaps shorter than staleMs keep the last state)
    const windowStart = nowMs - p.windowMs;
    let covered = 0;
    let inside = 0;
    for (let i = 0; i < n; i++) {
      const t = buf[i]!.t;
      const next = i + 1 < n ? buf[i + 1]!.t : nowMs;
      const end = Math.min(next, nowMs);
      const start = Math.max(t, windowStart);
      if (end <= start) continue;
      covered += end - start;
      if (eff[i] === "in") inside += end - start;
    }
    const insideShare = covered > 0 ? inside / covered : 0;

    if (ongoing === "long") return { attending: false, reason: "no-gaze", insideShare };
    const ok = insideShare >= p.minInsideShare;
    if (ongoing === "blink") return { attending: ok, reason: "blink", insideShare };
    return { attending: ok, reason: ok ? "inside" : "outside", insideShare };
  }

  return {
    params: p,
    push,
    attending,
    reset() {
      buf = [];
    },
  };
}

/**
 * Smoothing for the on-screen gaze dot only (decisions use raw samples).
 * Exponential smoothing with a time constant, so it behaves the same at 30,
 * 60 or 90 Hz: alpha = 1 - exp(-dt / tau). Jumps larger than snapPx
 * (saccades) move straight to the new point so the dot doesn't drag a tail
 * across the screen. Chosen over a one-euro filter because the dot is
 * cosmetic and this has one obvious knob.
 */
export function smoothPoint(
  prev: ViewportPoint | undefined,
  next: ViewportPoint,
  dtMs: number,
  opts?: { tauMs?: number; snapPx?: number },
): ViewportPoint {
  if (prev === undefined || !Number.isFinite(prev.x) || !Number.isFinite(prev.y)) return { x: next.x, y: next.y };
  const tau = opts?.tauMs ?? 60;
  const snap = opts?.snapPx ?? 250;
  if (Math.hypot(next.x - prev.x, next.y - prev.y) > snap) return { x: next.x, y: next.y };
  const alpha = tau > 0 ? 1 - Math.exp(-Math.max(0, dtMs) / tau) : 1;
  return { x: prev.x + alpha * (next.x - prev.x), y: prev.y + alpha * (next.y - prev.y) };
}
