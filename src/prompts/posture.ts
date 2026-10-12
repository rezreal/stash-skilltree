// Body-pose classification of the viewer (webcam BlazePose landmarks).
// Pure 2D geometry. Coordinates are normalized to the webcam frame; x is
// multiplied by the frame aspect so angles and distances are undistorted.
// y grows downwards ("above" = smaller y). Landmarks with visibility below
// POSTURE.minVisibility are ignored; when the landmarks a pose needs are
// missing the answer is "unknown" (neither pass nor fail).

import { POSE } from "./types.ts";
import type { HoldState } from "./hold.ts";
import type { NormPoint, PromptAction } from "./types.ts";

/** Thresholds; distances are in shoulder widths (sw) or torso lengths. */
export const POSTURE = {
  minVisibility: 0.5,
  defaultAspect: 4 / 3,
  /** arms_up: both wrists this far (sw) above the nose (head top is ~0.3 sw above it) */
  armsUpAboveNoseSw: 0.3,
  /** arms_up without a visible nose: wrists this far (sw) above the shoulder line */
  armsUpAboveShouldersSw: 0.8,
  /** hands_on_head: wrists at most this far (sw) above eye height ... */
  headHandsAboveEyesSw: 0.6,
  /** ... and at most this far (sw) below it */
  headHandsBelowEyesSw: 0.15,
  /** hands_on_head: wrists within this horizontal distance (sw) of the head centre */
  headHandsNearSw: 0.6,
  /** hands_together: wrists within this distance (sw) of each other */
  handsTogetherSw: 0.25,
  /** hands_together: may be this far (sw) above the shoulder line */
  handsTogetherAboveShouldersSw: 0.1,
  /** hips missing (desk webcam): hips assumed this far (sw) below the shoulders */
  assumedTorsoSw: 1.4,
  /** kneel: knee angle (hip-knee-ankle) below this, degrees */
  kneelKneeMaxDeg: 110,
  /** kneel: hips low - hip-to-ankle vertical distance below this share of the torso length
   * (tall kneel ~1.0, standing ~1.6, sitting on the heels ~0.2) */
  kneelHipAnkleMaxTorso: 1.2,
  /** kneel: knee near ankle height (shins on the floor; rules out sitting on a chair) */
  kneelKneeAnkleMaxTorso: 0.35,
  /** kneel: a shin shorter than this on screen points at the camera; its knee angle is not trusted */
  kneelShortShinTorso: 0.35,
  /** kneel_sit (sitting on the heels): hip-to-ankle vertical distance below this share of the torso length
   * (on the heels ~0.2-0.4, tall kneel ~1.0) */
  kneelSitHipAnkleMaxTorso: 0.6,
  /** kneel_sit: hips at least this far (torso lengths) above the knees (rules out sitting cross-legged,
   * where the hips are at or below knee height) */
  kneelSitHipAboveKneeTorso: 0.12,
  /** kneel_sit: shoulder-hip line within this of vertical, degrees (an upright back) */
  kneelSitTorsoMaxTiltDeg: 30,
  /** stand: knee and hip angles above this, degrees */
  standJointMinDeg: 160,
  /** stand: shoulder-hip line within this of vertical, degrees */
  standTorsoMaxTiltDeg: 20,
  /** lie_down: shoulder-hip line within this of horizontal, degrees */
  lieMaxTiltDeg: 30,
} as const;

export const POSE_ACTIONS = ["arms_up", "hands_on_head", "hands_together", "kneel", "kneel_sit", "stand", "lie_down"] as const;
export type PoseAction = (typeof POSE_ACTIONS)[number];

export function isPoseAction(a: PromptAction | undefined): a is PoseAction {
  return a !== undefined && (POSE_ACTIONS as readonly string[]).includes(a);
}

interface Q {
  x: number;
  y: number;
}

const dist = (a: Q, b: Q): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Q, b: Q): Q => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** angle at b between a and c, degrees */
function angle(a: Q, b: Q, c: Q): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (n === 0) return 180;
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))) * 180) / Math.PI;
}

/** angle of the line a-b to the horizontal, 0..90 degrees */
function tiltFromHorizontal(a: Q, b: Q): number {
  const deg = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
  return deg;
}

/** What the viewer should change, per pose action and reason (imperative, short). */
export const POSTURE_HINTS = {
  showHands: "Show both hands and shoulders to the camera",
  showHead: "Show your hands, elbows and face to the camera",
  showLegs: "The camera can't see your legs – move back or turn sideways",
  showBody: "Show your shoulders and hips to the camera",
  armsUp: "Raise both hands above your head",
  handsOnHead: "Put both hands on your head",
  elbowsOut: "Spread your elbows out to the sides",
  handsTogether: "Bring your hands together",
  handsChest: "Hold your hands in front of your chest",
  kneesDown: "Put your knees on the floor",
  bendKnees: "Bend your knees",
  foldLegs: "Fold your legs under you",
  hipsLower: "Lower your hips",
  ontoHeels: "Sit back onto your heels",
  heelsNotFloor: "Sit on your heels, not on the floor",
  backStraight: "Straighten your back",
  legsStraight: "Straighten your legs",
  standStraight: "Stand up straight",
  lieFlat: "Lie down flat",
  notInView: "Get in front of the camera",
} as const;

export interface PostureVerdict {
  state: HoldState;
  /** when not "in": what is missing, in plain words (POSTURE_HINTS) */
  hint?: string;
}

/** "in" when the pose shows the action, "out" when not, "unknown" when it can't tell. */
export function classifyPosture(action: PoseAction, pose: NormPoint[] | undefined, aspect?: number): HoldState {
  return assessPosture(action, pose, aspect).state;
}

/** classifyPosture with the reason when the pose is not (or can't be seen to be) held. */
export function assessPosture(action: PoseAction, pose: NormPoint[] | undefined, aspect?: number): PostureVerdict {
  const H = POSTURE_HINTS;
  const unseen: Readonly<Record<PoseAction, string>> = {
    arms_up: H.showHands,
    hands_on_head: H.showHead,
    hands_together: H.showHands,
    kneel: H.showLegs,
    kneel_sit: H.showLegs,
    stand: H.showLegs,
    lie_down: H.showBody,
  };
  const unknown: PostureVerdict = { state: "unknown", hint: unseen[action] };
  const IN: PostureVerdict = { state: "in" };
  const out = (hint: string): PostureVerdict => ({ state: "out", hint });
  if (pose === undefined || pose.length === 0) return unknown;
  const ax = aspect !== undefined && aspect > 0 && Number.isFinite(aspect) ? aspect : POSTURE.defaultAspect;
  const at = (i: number): Q | undefined => {
    const p = pose[i];
    if (p === undefined || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return undefined;
    if (p.visibility !== undefined && p.visibility < POSTURE.minVisibility) return undefined;
    return { x: p.x * ax, y: p.y };
  };
  const ls = at(POSE.leftShoulder);
  const rs = at(POSE.rightShoulder);
  const lh = at(POSE.leftHip);
  const rh = at(POSE.rightHip);
  const lw = at(POSE.leftWrist);
  const rw = at(POSE.rightWrist);
  const sw = ls && rs ? dist(ls, rs) : 0;

  switch (action) {
    case "arms_up": {
      if (!lw || !rw || !ls || !rs || sw <= 0) return unknown;
      const nose = at(POSE.nose);
      const limit = nose ? nose.y - POSTURE.armsUpAboveNoseSw * sw : mid(ls, rs).y - POSTURE.armsUpAboveShouldersSw * sw;
      return lw.y < limit && rw.y < limit ? IN : out(H.armsUp);
    }

    case "hands_on_head": {
      const le = at(POSE.leftElbow);
      const re = at(POSE.rightElbow);
      if (!lw || !rw || !ls || !rs || !le || !re || sw <= 0) return unknown;
      const eyeL = at(POSE.leftEye);
      const eyeR = at(POSE.rightEye);
      const nose = at(POSE.nose);
      let eyeY: number;
      let headX: number;
      if (eyeL && eyeR) {
        eyeY = (eyeL.y + eyeR.y) / 2;
        headX = (eyeL.x + eyeR.x) / 2;
      } else if (nose) {
        eyeY = nose.y - 0.1 * sw;
        headX = nose.x;
      } else return unknown;
      const ok = (w: Q): boolean =>
        w.y >= eyeY - POSTURE.headHandsAboveEyesSw * sw &&
        w.y <= eyeY + POSTURE.headHandsBelowEyesSw * sw &&
        Math.abs(w.x - headX) <= POSTURE.headHandsNearSw * sw;
      if (!ok(lw) || !ok(rw)) return out(H.handsOnHead);
      const elbowsWide = Math.abs(le.x - re.x) > Math.abs(ls.x - rs.x);
      return elbowsWide ? IN : out(H.elbowsOut);
    }

    case "hands_together": {
      if (!lw || !rw || !ls || !rs || sw <= 0) return unknown;
      const sy = mid(ls, rs).y;
      const hy = lh && rh ? mid(lh, rh).y : sy + POSTURE.assumedTorsoSw * sw;
      const wm = mid(lw, rw);
      if (dist(lw, rw) > POSTURE.handsTogetherSw * sw) return out(H.handsTogether);
      return wm.y >= sy - POSTURE.handsTogetherAboveShouldersSw * sw && wm.y <= hy ? IN : out(H.handsChest);
    }

    case "kneel":
    case "kneel_sit":
    case "stand": {
      const sides = [
        [POSE.leftShoulder, POSE.leftHip, POSE.leftKnee, POSE.leftAnkle],
        [POSE.rightShoulder, POSE.rightHip, POSE.rightKnee, POSE.rightAnkle],
      ] as const;
      const sm = ls && rs ? mid(ls, rs) : ls ?? rs;
      const hm = lh && rh ? mid(lh, rh) : lh ?? rh;
      let complete = 0;
      /** the first leg problem found, most basic first */
      let miss: string | undefined;
      for (const [s, h, k, a] of sides) {
        const hip = at(h);
        const knee = at(k);
        const ankle = at(a);
        if (!hip || !knee || !ankle) continue;
        let why: string | undefined;
        if (action === "kneel" || action === "kneel_sit") {
          if (!sm || !hm) continue;
          const torso = dist(sm, hm);
          if (torso <= 0) continue;
          complete++;
          const kneeLow = Math.abs(knee.y - ankle.y) < POSTURE.kneelKneeAnkleMaxTorso * torso;
          const bent = dist(knee, ankle) < POSTURE.kneelShortShinTorso * torso || angle(hip, knee, ankle) < POSTURE.kneelKneeMaxDeg;
          if (!kneeLow) why = H.kneesDown;
          else if (!bent) why = action === "kneel" ? H.bendKnees : H.foldLegs;
          else if (action === "kneel") {
            if (Math.abs(ankle.y - hip.y) >= POSTURE.kneelHipAnkleMaxTorso * torso) why = H.hipsLower;
          } else if (knee.y - hip.y < POSTURE.kneelSitHipAboveKneeTorso * torso) {
            // hips at or below the knees: sitting on the floor (cross-legged, between the feet)
            why = H.heelsNotFloor;
          } else if (Math.abs(ankle.y - hip.y) >= POSTURE.kneelSitHipAnkleMaxTorso * torso) {
            // on the heels: hips down near the ankles
            why = H.ontoHeels;
          }
        } else {
          const shoulder = at(s);
          if (!shoulder) continue;
          complete++;
          if (angle(hip, knee, ankle) <= POSTURE.standJointMinDeg) why = H.legsStraight;
          else if (angle(shoulder, hip, knee) <= POSTURE.standJointMinDeg) why = H.standStraight;
        }
        miss ??= why;
      }
      if (complete === 0) return unknown;
      if (miss !== undefined) return out(miss);
      if (action === "stand" || action === "kneel_sit") {
        if (!sm || !hm) return unknown;
        const maxTilt = action === "stand" ? POSTURE.standTorsoMaxTiltDeg : POSTURE.kneelSitTorsoMaxTiltDeg;
        if (90 - tiltFromHorizontal(sm, hm) > maxTilt) return out(action === "stand" ? H.standStraight : H.backStraight);
      }
      return IN;
    }

    case "lie_down": {
      const sm = ls && rs ? mid(ls, rs) : ls ?? rs;
      const hm = lh && rh ? mid(lh, rh) : lh ?? rh;
      if (!sm || !hm || dist(sm, hm) === 0) return unknown;
      return tiltFromHorizontal(sm, hm) <= POSTURE.lieMaxTiltDeg ? IN : out(H.lieFlat);
    }
  }
}
