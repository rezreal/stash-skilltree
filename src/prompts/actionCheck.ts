// Webcam action checks over ViewerFrame streams (t in ms). Pure, stateful.
//
// nod / shake_head: oscillation of pitch / yaw. A swing is counted when the
// angle moves at least `amplitude` degrees away from the last extreme in the
// opposite direction (hysteresis, so jitter never counts); a cycle is two
// consecutive swings (down-up or up-down) within maxCycleMs.
// eyes_closed / eyes_open / hand_raised / still / mouth_open / mouth_closed:
// continuous holds. Frames without a face don't count and don't reset, except
// for still (a face leaving the frame is movement).
// mouth_open / mouth_closed read the face's jawOpen blendshape; mouth_open
// holds for min(holdSec, mouthOpenMaxSec), mouth_closed ("keep it in your
// mouth") for the hold time.
// hand_to_mouth: a hand at the mouth per the viewer pose (viewerFrame.ts
// handToMouth), gated on the pose rather than the face, since the hand often
// hides the face; holds for min(holdSec, handToMouthMaxSec).
// Body-pose actions (arms_up, hands_on_head, hands_together, kneel, stand,
// lie_down, the yoga poses; see posture.ts) hold for min(holdSec, poseMaxSec) and are gated
// on the viewer pose, not the face (a face is often hidden when lying down);
// time where the needed landmarks are missing is neither pass nor fail.
// In windows longer than LONG_WINDOW_SEC a body pose, mouth_closed and still
// are scored by share, like a long gaze window: passed iff at least
// SUSTAINED_MIN_SHARE of the evidence time was in it and at least the hold
// time of it (meditation-style "stay kneeling for the whole part", "hold it
// in your mouth", "hold still").
// Body poses also report what is missing right now (posture.ts hints, e.g.
// "Sit back onto your heels"): a reason shows once it held POSE_HINT
// .showMs, and goes away once the pose has been held for .clearMs, so the
// banner doesn't flicker at a threshold. No hint after a short window has
// passed.

import { createHoldTracker, createShareTracker, isSustained, sharePercentText, SUSTAINED_MIN_SHARE } from "./hold.ts";
import { assessPosture, isPoseAction, POSTURE_HINTS } from "./posture.ts";
import type { PostureVerdict } from "./posture.ts";
import type { HoldState } from "./hold.ts";
import type { CheckResult, PromptAction, PromptSpec, ViewerFrame } from "./types.ts";

export const ACTION_THRESHOLDS = {
  nodAmplitudeDeg: 8,
  shakeAmplitudeDeg: 10,
  /** a down-up (or left-right) cycle must take at most this long */
  maxCycleMs: 3000,
  /** angle changes this small keep refreshing the time of the current extreme */
  jitterDeg: 1,
  eyesClosedMin: 0.5,
  eyesClosedMaxSec: 1.5,
  eyesOpenMax: 0.3,
  /** blinks shorter than this don't break an eyes_open hold */
  blinkToleranceMs: 400,
  handRaisedSec: 0.5,
  /** detection flicker shorter than this doesn't break a hand_raised hold */
  handFlickerMs: 200,
  /** per-frame mean landmark motion (normalized units) counted as still */
  stillMotion: 0.005,
  /** body-pose actions hold for min(holdSec, this) */
  poseMaxSec: 1.5,
  /** pose detection flicker shorter than this doesn't break a body-pose hold */
  poseFlickerMs: 250,
  /** jawOpen at or above this is an open mouth */
  mouthOpenMin: 0.35,
  /** jawOpen at or below this is a closed mouth (lips together, cheeks may be full) */
  mouthClosedMax: 0.15,
  mouthOpenMaxSec: 1.5,
  /** a jawOpen flicker shorter than this doesn't break a mouth hold */
  mouthFlickerMs: 300,
  handToMouthMaxSec: 1,
  /** pose flicker shorter than this doesn't break a hand_to_mouth hold */
  handToMouthFlickerMs: 300,
} as const;

/** actions a long window scores by share instead of by one hold (see the top) */
export function scoredByShare(action: PromptAction | undefined): boolean {
  return isPoseAction(action) || action === "mouth_closed" || action === "still";
}

export interface ActionCheckOptions {
  stillMotion?: number;
  nodAmplitudeDeg?: number;
  shakeAmplitudeDeg?: number;
  maxCycleMs?: number;
}

export interface ActionCheck {
  readonly spec: PromptSpec;
  push(frame: ViewerFrame): void;
  result(): CheckResult;
  reset(): void;
}

export const POSE_HINT = {
  /** a reason must hold this long before it shows, ms */
  showMs: 600,
  /** the hint goes away once the pose was held this long, ms */
  clearMs: 250,
} as const;

// --- pose hints -----------------------------------------------------------------

interface HintTracker {
  push(t: number, v: PostureVerdict): void;
  readonly hint: string | undefined;
  reset(): void;
}

function createHintTracker(): HintTracker {
  let shown: string | undefined;
  let cand: string | undefined;
  let since = 0;
  return {
    push(t, v) {
      const next = v.state === "in" ? undefined : v.hint;
      if (next !== cand) {
        cand = next;
        since = t;
      }
      if (t - since >= (cand === undefined ? POSE_HINT.clearMs : POSE_HINT.showMs)) shown = cand;
    },
    get hint() {
      return shown;
    },
    reset() {
      shown = cand = undefined;
      since = 0;
    },
  };
}

// --- oscillation ---------------------------------------------------------------

interface Oscillation {
  push(t: number, v: number): void;
  readonly passed: boolean;
  readonly progress: number;
  readonly swings: number;
  reset(): void;
}

function createOscillation(amplitude: number, maxCycleMs: number, jitter: number): Oscillation {
  let dir: 0 | 1 | -1 = 0;
  let hi: { v: number; t: number } | undefined;
  let lo: { v: number; t: number } | undefined;
  /** running extreme in the current direction (dir 1: max, dir -1: min) */
  let ext = { v: 0, t: 0 };
  let lastSwingStart: number | undefined;
  let swings = 0;
  let inCycle = 0;
  let passed = false;
  let partial = 0;

  function swing(startT: number, t: number): void {
    swings++;
    if (lastSwingStart !== undefined && t - lastSwingStart <= maxCycleMs) {
      passed = true;
      inCycle = 2;
    } else inCycle = 1;
    lastSwingStart = startT;
  }

  return {
    push(t, v) {
      if (!Number.isFinite(v) || !Number.isFinite(t)) return;
      if (dir === 0) {
        if (hi === undefined || v > hi.v) hi = { v, t };
        else if (hi.v - v <= jitter) hi.t = t;
        if (lo === undefined || v < lo.v) lo = { v, t };
        else if (v - lo.v <= jitter) lo.t = t;
        partial = Math.min(1, (hi.v - lo.v) / amplitude);
        if (hi.v - lo.v >= amplitude) {
          if (hi.t >= lo.t) {
            swing(lo.t, t);
            dir = 1;
            ext = { ...hi };
          } else {
            swing(hi.t, t);
            dir = -1;
            ext = { ...lo };
          }
          partial = 0;
        }
        return;
      }
      const away = dir === 1 ? ext.v - v : v - ext.v;
      if (away < 0) ext = { v, t };
      else if (away <= jitter) ext.t = t;
      if (away >= amplitude) {
        swing(ext.t, t);
        dir = dir === 1 ? -1 : 1;
        ext = { v, t };
        partial = 0;
      } else partial = Math.max(0, away) / amplitude;
      if (lastSwingStart !== undefined && t - lastSwingStart > maxCycleMs && !passed) inCycle = 0;
    },
    get passed() {
      return passed;
    },
    get progress() {
      return passed ? 1 : Math.min(0.99, (Math.min(inCycle, 1) + partial) / 2);
    },
    get swings() {
      return swings;
    },
    reset() {
      dir = 0;
      hi = undefined;
      lo = undefined;
      lastSwingStart = undefined;
      swings = inCycle = 0;
      passed = false;
      partial = 0;
    },
  };
}

// --- checks --------------------------------------------------------------------

export function createActionCheck(spec: PromptSpec, opts?: ActionCheckOptions): ActionCheck {
  const T = ACTION_THRESHOLDS;
  const action = spec.action;

  if (action === "nod" || action === "shake_head") {
    const amp = action === "nod" ? (opts?.nodAmplitudeDeg ?? T.nodAmplitudeDeg) : (opts?.shakeAmplitudeDeg ?? T.shakeAmplitudeDeg);
    const osc = createOscillation(amp, opts?.maxCycleMs ?? T.maxCycleMs, T.jitterDeg);
    const label = action === "nod" ? "nod" : "head shake";
    return {
      spec,
      push(f) {
        if (!f.facePresent) return;
        const v = action === "nod" ? f.pitch : f.yaw;
        if (v !== undefined) osc.push(f.t, v);
      },
      result() {
        return {
          passed: osc.passed,
          progress: osc.progress,
          detail: osc.passed ? `${label} seen` : `${osc.swings} swing${osc.swings === 1 ? "" : "s"}`,
        };
      },
      reset() {
        osc.reset();
      },
    };
  }

  let needSec = spec.holdSec;
  let tolerance = 0;
  let classify: (f: ViewerFrame) => HoldState;
  let hints: HintTracker | undefined;
  let absentResets = false;
  let label: string;
  const both = (f: ViewerFrame): [number, number] | undefined =>
    f.eyeBlinkLeft === undefined || f.eyeBlinkRight === undefined ? undefined : [f.eyeBlinkLeft, f.eyeBlinkRight];
  switch (action) {
    case "eyes_closed":
      needSec = Math.min(spec.holdSec, T.eyesClosedMaxSec);
      label = "eyes closed";
      classify = (f) => {
        const b = both(f);
        return b === undefined ? "unknown" : b[0] >= T.eyesClosedMin && b[1] >= T.eyesClosedMin ? "in" : "out";
      };
      break;
    case "eyes_open":
      tolerance = T.blinkToleranceMs;
      label = "eyes open";
      classify = (f) => {
        const b = both(f);
        return b === undefined ? "unknown" : b[0] <= T.eyesOpenMax && b[1] <= T.eyesOpenMax ? "in" : "out";
      };
      break;
    case "hand_raised":
      needSec = T.handRaisedSec;
      tolerance = T.handFlickerMs;
      label = "hand raised";
      classify = (f) => (f.handRaised === undefined ? "unknown" : f.handRaised ? "in" : "out");
      break;
    case "still": {
      const limit = opts?.stillMotion ?? T.stillMotion;
      absentResets = true;
      label = "still";
      classify = (f) => (f.motion === undefined || !Number.isFinite(f.motion) ? "unknown" : f.motion <= limit ? "in" : "out");
      break;
    }
    case "mouth_open":
      needSec = Math.min(spec.holdSec, T.mouthOpenMaxSec);
      tolerance = T.mouthFlickerMs;
      label = "mouth open";
      classify = (f) => (f.jawOpen === undefined ? "unknown" : f.jawOpen >= T.mouthOpenMin ? "in" : "out");
      break;
    case "mouth_closed":
      tolerance = T.mouthFlickerMs;
      label = "mouth closed";
      classify = (f) => (f.jawOpen === undefined ? "unknown" : f.jawOpen <= T.mouthClosedMax ? "in" : "out");
      break;
    case "hand_to_mouth":
      needSec = Math.min(spec.holdSec, T.handToMouthMaxSec);
      tolerance = T.handToMouthFlickerMs;
      label = "hand at mouth";
      classify = (f) => (f.handToMouth === undefined ? "unknown" : f.handToMouth ? "in" : "out");
      break;
    default:
      if (isPoseAction(action)) {
        needSec = Math.min(spec.holdSec, T.poseMaxSec);
        tolerance = T.poseFlickerMs;
        label = action.replace(/_/g, " ");
        const tracker = createHintTracker();
        hints = tracker;
        classify = (f) => {
          const v: PostureVerdict = f.personPresent ? assessPosture(action, f.pose, f.aspect) : { state: "unknown", hint: POSTURE_HINTS.notInView };
          tracker.push(f.t, v);
          return v.state;
        };
      } else {
        label = "unknown action";
        classify = () => "unknown";
      }
  }
  const faceGated = !isPoseAction(action) && action !== "hand_to_mouth";
  const sustained = scoredByShare(action) && isSustained(spec);

  const hold = createHoldTracker({ needMs: Math.max(0.1, needSec) * 1000, toleranceMs: tolerance, maxDtMs: 250 });
  const share = createShareTracker({ maxDtMs: 250 });
  return {
    spec,
    push(f) {
      if (faceGated && !f.facePresent) {
        if (absentResets) {
          hold.breakRun();
          hold.cut();
        } else hold.push(f.t, "unknown");
        return;
      }
      const state = classify(f);
      hold.push(f.t, state);
      share.push(f.t, state);
    },
    result() {
      if (sustained) {
        const sh = share.share;
        const passed = sh !== undefined && sh >= SUSTAINED_MIN_SHARE && share.onMs >= hold.needMs;
        const r: CheckResult = {
          passed,
          progress: passed ? 1 : Math.min(1, (sh ?? 0) / SUSTAINED_MIN_SHARE, share.onMs / hold.needMs),
          detail: `${label} ${sharePercentText(sh)}`,
        };
        if (sh !== undefined) r.share = sh;
        if (hints?.hint !== undefined) r.hint = hints.hint;
        return r;
      }
      const passed = hold.passed;
      const r: CheckResult = {
        passed,
        progress: passed ? 1 : Math.min(1, hold.bestMs / hold.needMs),
        detail: `${label} ${(hold.bestMs / 1000).toFixed(1)} of ${(hold.needMs / 1000).toFixed(1)} s`,
      };
      if (!passed && hints?.hint !== undefined) r.hint = hints.hint;
      return r;
    },
    reset() {
      hold.reset();
      share.reset();
      hints?.reset();
    },
  };
}
