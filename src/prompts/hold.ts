// Continuous-hold accounting shared by the gaze and action checks.
// Sample-and-hold: the interval between two pushes takes the state of the
// earlier push. "in" intervals add to the current run, "out" intervals end it
// once they add up to more than toleranceMs (shorter exits are forgiven but
// not counted), "unknown" intervals neither count nor reset. Intervals longer
// than maxDtMs only count maxDtMs (a stall is not evidence).

export type HoldState = "in" | "out" | "unknown";

export interface HoldTrackerOptions {
  needMs: number;
  toleranceMs?: number;
  maxDtMs?: number;
}

export interface HoldTracker {
  push(t: number, state: HoldState): void;
  /** forget the previous push (a discontinuity) without touching the run */
  cut(): void;
  /** end the current run; the best run is kept */
  breakRun(): void;
  reset(): void;
  /** current continuous run, ms */
  readonly runMs: number;
  /** longest run so far, ms */
  readonly bestMs: number;
  readonly needMs: number;
  readonly passed: boolean;
}

export function createHoldTracker(opts: HoldTrackerOptions): HoldTracker {
  const needMs = Math.max(1, opts.needMs);
  const tol = Math.max(0, opts.toleranceMs ?? 0);
  const maxDt = Math.max(1, opts.maxDtMs ?? 250);
  let prev: { t: number; state: HoldState } | undefined;
  let run = 0;
  let best = 0;
  let out = 0;

  return {
    push(t, state) {
      if (!Number.isFinite(t)) return;
      if (prev !== undefined && t > prev.t) {
        const dt = Math.min(t - prev.t, maxDt);
        if (prev.state === "in") {
          run += dt;
          out = 0;
          if (run > best) best = run;
        } else if (prev.state === "out") {
          out += dt;
          if (out > tol) run = 0;
        }
      }
      // time going backwards: restart the chain from here
      prev = { t, state };
    },
    cut() {
      prev = undefined;
    },
    breakRun() {
      run = 0;
      out = 0;
    },
    reset() {
      prev = undefined;
      run = 0;
      best = 0;
      out = 0;
    },
    get runMs() {
      return run;
    },
    get bestMs() {
      return best;
    },
    needMs,
    get passed() {
      return best >= needMs;
    },
  };
}

// --- share accounting (long gaze and pose windows) -----------------------------------

/** windows longer than this (seconds) are scored by share, not by a continuous hold */
export const LONG_WINDOW_SEC = 10;
/** long windows pass when at least this share of the evidence time was on target */
export const SUSTAINED_MIN_SHARE = 0.75;

/** The window is long: scored by share (sustained), not by the hold rule. */
export function isSustained(spec: { start: number; end: number }): boolean {
  return spec.end - spec.start > LONG_WINDOW_SEC;
}

/** "82% · need 75%" (floored, so a shown 75% passes) */
export function sharePercentText(share: number | undefined): string {
  const pct = share === undefined || !Number.isFinite(share) ? "–" : `${Math.floor(Math.min(1, Math.max(0, share)) * 100)}%`;
  return `${pct} · need ${Math.round(SUSTAINED_MIN_SHARE * 100)}%`;
}

// The same sample-and-hold intervals as the hold tracker, summed by state
// instead of chained into runs: "in" adds to onMs, "out" to offMs, "unknown"
// to neither (time without evidence neither counts nor is required).
// Intervals longer than maxDtMs only count maxDtMs.

export interface ShareTracker {
  push(t: number, state: HoldState): void;
  /** forget the previous push (a discontinuity) */
  cut(): void;
  reset(): void;
  readonly onMs: number;
  readonly offMs: number;
  /** onMs / (onMs + offMs); undefined before any evidence */
  readonly share: number | undefined;
}

export function createShareTracker(opts?: { maxDtMs?: number }): ShareTracker {
  const maxDt = Math.max(1, opts?.maxDtMs ?? 250);
  let prev: { t: number; state: HoldState } | undefined;
  let on = 0;
  let off = 0;

  return {
    push(t, state) {
      if (!Number.isFinite(t)) return;
      if (prev !== undefined && t > prev.t) {
        const dt = Math.min(t - prev.t, maxDt);
        if (prev.state === "in") on += dt;
        else if (prev.state === "out") off += dt;
      }
      prev = { t, state };
    },
    cut() {
      prev = undefined;
    },
    reset() {
      prev = undefined;
      on = 0;
      off = 0;
    },
    get onMs() {
      return on;
    },
    get offMs() {
      return off;
    },
    get share() {
      return on + off > 0 ? on / (on + off) : undefined;
    },
  };
}
