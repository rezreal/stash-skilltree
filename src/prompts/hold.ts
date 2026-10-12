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
