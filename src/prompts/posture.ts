// Body-pose classification of the viewer (webcam BlazePose landmarks).
// Pure 2D geometry. Coordinates are normalized to the webcam frame; x is
// multiplied by the frame aspect so angles and distances are undistorted.
// y grows downwards ("above" = smaller y). Landmarks with visibility below
// POSTURE.minVisibility are ignored; when the landmarks a pose needs are
// missing the answer is "unknown" (neither pass nor fail).
//
// Yoga poses: straightness of a limb survives the 2D projection, a bend
// angle doesn't. So poses told apart by a bend (plank, down_dog, plow, puppy,
// cobra) are only judged side-on to the camera, and the straddles, warrior,
// tree and butterfly, whose legs spread out sideways, only facing it; from the wrong
// side the answer is "unknown" with a hint to turn (also happy_baby and
// savasana, lying poses that point at a camera at the feet). warrior is
// warrior II (virabhadrasana II). cat, cow, child and forward_fold work
// from either side (heights; the fold's hip angle only side-on). Thunderbolt
// pose (vajrasana) is kneel_sit; hastasana (upward salute) is stand + arms_up
// with straight arms. The view is read off the shoulder width: a frontal torso is ~0.75
// torso lengths wide, a side-on one much narrower.

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
  /** side-on view: shoulder width below this share of the torso length (frontal ~0.75) */
  sideMaxShoulderTorso: 0.45,
  /** a straight arm or leg: joint angle above this, degrees */
  straightMinDeg: 150,
  /** a bent knee (on all fours): knee angle below this, degrees */
  bentKneeMaxDeg: 130,
  // Floor poses below; distances are in body scale = max(torso length, shoulder width),
  // which stays usable when the torso points at the camera.
  /** all fours (cat, cow, puppy): hips at least this far above the knees (thighs upright) */
  fourHipsAboveKnees: 0.4,
  /** cat, cow: hands on the floor - wrists at most this far above the knees */
  fourHandsAboveKnees: 0.35,
  /** cat, cow: wrists at least this far below the shoulders (arms holding the chest up) */
  fourChestAboveHands: 0.4,
  /** cat: head (nose) at least this far below the shoulders (head dropped, back rounded) */
  catHeadBelowShoulders: 0.25,
  /** cow: head at least this far above the shoulders (head lifted, belly dropped) */
  cowHeadAboveShoulders: 0.1,
  /** puppy: chest down - wrists at most this far below the shoulders */
  puppyChestAboveHands: 0.35,
  /** puppy: wrists at least this much farther from the hips than the shoulders (arms reaching forward) */
  puppyReach: 0.3,
  /** down_dog: hips at least this far above the shoulders */
  dogHipsAboveShoulders: 0.3,
  /** down_dog, forward_fold: knee angle above this, degrees (soft knees are fine) */
  softKneeMinDeg: 130,
  /** forward_fold: shoulder-hip-ankle angle below this, degrees; down_dog needs at least this */
  foldHipMaxDeg: 50,
  /** forward_fold: shoulders at least this far below the hips */
  foldShouldersBelowHips: 0.3,
  /** forward_fold: hips at least this far above the ankles (standing on the feet) */
  foldHipsAboveFeet: 0.8,
  /** down_dog: shoulder-hip-ankle angle at most this, degrees (larger: hips not lifted) */
  dogHipMaxDeg: 120,
  /** plank: shoulder-hip line within this of horizontal, degrees */
  plankMaxTiltDeg: 35,
  /** plank: shoulder-hip-ankle angle above this, degrees (a straight body) */
  plankBodyMinDeg: 160,
  /** plank: elbows or wrists at least this far below the shoulders (on hands or forearms) */
  plankSupport: 0.3,
  /** plow: hips at least this far above the shoulders */
  plowHipsAboveShoulders: 0.5,
  /** plow: shoulder-hip-ankle angle at most this, degrees (legs folded over the head) */
  plowHipMaxDeg: 75,
  /** plow: ankles at least this far below the hips (feet lowered behind the head) */
  plowFeetBelowHips: 0.5,
  /** plow: ankles at most this far below the shoulders (shoulders on the floor, not a standing fold) */
  plowFeetBelowShoulders: 0.4,
  /** child: shoulders at most this far above the hips (folded forward over the thighs) */
  childShouldersAboveHips: 0.15,
  /** happy_baby: knees at least this far (torso lengths) above the hips */
  happyKneesAboveHips: 0.3,
  /** happy_baby: shoulder-hip-knee angle at most this, degrees (knees drawn toward the armpits) */
  happyHipMaxDeg: 100,
  /** happy_baby: ankles at least this far (torso lengths) above the knees (soles up) */
  happyFeetAboveKnees: 0.2,
  /** happy_baby: each wrist within this (torso lengths) of an ankle (holding the feet) */
  happyHandsToFeet: 0.5,
  /** savasana: knees, ankles and wrists within this (torso lengths) of hip height (resting on the floor) */
  savasanaOffFloor: 0.3,
  /** warrior: ankles at least this far apart horizontally (wide stance) */
  warriorFeetApart: 1.2,
  /** warrior: front knee angle at most this, degrees */
  warriorFrontKneeMaxDeg: 130,
  /** warrior, tree: shoulder-hip line within this of vertical, degrees */
  uprightMaxTiltDeg: 20,
  /** warrior: each arm (shoulder-wrist) within this of horizontal, degrees */
  warriorArmMaxTiltDeg: 20,
  /** tree: standing ankle at least this far below the hips */
  treeStandFootBelowHips: 0.8,
  /** tree: lifted ankle at least this far above the standing one (off the floor) */
  treeFootLifted: 0.3,
  /** tree: lifted ankle at most this far, horizontally, from the standing leg (foot on the leg) */
  treeFootOnLeg: 0.35,
  /** tree: lifted knee at least this far, horizontally, from the standing leg (knee out to the side) */
  treeKneeOut: 0.4,
  /** butterfly: ankles at most this far apart (soles together) */
  butterflyFeetApart: 0.35,
  /** butterfly: feet at most this far from the middle of the hips (heels drawn in) */
  butterflyHeelsIn: 0.8,
  /** butterfly: knees at least this far apart horizontally (fallen out to the sides) */
  butterflyKneesApart: 1,
  /** butterfly: ankles at most this far below the hips (sitting, not standing) */
  butterflyFeetBelowHips: 1,
  /** butterfly: shoulder-hip line within this of vertical, degrees (sitting tall) */
  butterflyTorsoMaxTiltDeg: 30,
  /** cobra: shoulders at least this far (torso lengths) above the hips (chest lifted) */
  cobraChestUp: 0.4,
  /** cobra: knees and ankles within this (torso lengths) of hip height (legs on the floor) */
  cobraLegsOffFloor: 0.3,
  /** cobra: wrists at least this far (torso lengths) below the shoulders (pressing into the floor) */
  cobraHandsBelowShoulders: 0.3,
  /** cobra: wrists within this (torso lengths), horizontally, of the shoulders (hands under them) */
  cobraHandsUnderShoulders: 0.5,
  /** cobra: elbow angle above this, degrees (arms pushing up, not resting on the forearms) */
  cobraElbowMinDeg: 110,
  /** straddle: angle between the legs (hips to ankles) at least this, degrees */
  straddleMinDeg: 90,
  /** straddle: ankles at most this far below the hips (sitting, not standing) */
  straddleFeetBelowHips: 1,
  /** straddle: ankles at most this far above the hips (legs resting on the floor) */
  straddleFeetAboveHips: 0.2,
  /** straddle_up: angle between the legs at least this, degrees */
  straddleUpMinDeg: 50,
  /** straddle_up: ankles at least this far above the hips (legs lifted) */
  straddleUpFeetAboveHips: 0.4,
  /** straddle_up: shoulder-hip line within this of vertical, degrees (sitting up, leaning back a little) */
  straddleUpTorsoMaxTiltDeg: 45,
} as const;

export const POSE_ACTIONS = [
  "arms_up",
  "hands_on_head",
  "hands_together",
  "kneel",
  "kneel_sit",
  "stand",
  "lie_down",
  "cat",
  "cow",
  "puppy",
  "down_dog",
  "plank",
  "plow",
  "straddle",
  "straddle_up",
  "child",
  "forward_fold",
  "happy_baby",
  "savasana",
  "hastasana",
  "warrior",
  "tree",
  "cobra",
  "butterfly",
] as const;
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
  showWhole: "Show your whole body to the camera",
  turnSide: "Turn side-on to the camera",
  faceCamera: "Face the camera",
  allFours: "Get on your hands and knees",
  handsFloor: "Put your hands on the floor",
  hipsOverKnees: "Lift your hips over your knees",
  armsStraight: "Straighten your arms",
  roundBack: "Round your back and drop your head",
  archBack: "Drop your belly and lift your head",
  chestDown: "Lower your chest toward the floor",
  reachForward: "Stretch your arms forward",
  hipsUp: "Lift your hips",
  handsForward: "Walk your hands forward",
  bodyLevel: "Bring your body level with the floor",
  onHands: "Push up onto your hands or forearms",
  hipsOverShoulders: "Lift your hips over your shoulders",
  legsOverHead: "Bring your legs over your head",
  feetDown: "Lower your feet toward the floor",
  shouldersDown: "Lie back with your shoulders on the floor",
  legsUp: "Lift your legs off the floor",
  legsDown: "Rest your legs on the floor",
  legsWide: "Spread your legs wider",
  sitDown: "Sit down on the floor",
  foldOverThighs: "Fold forward, chest onto your thighs",
  foldDeeper: "Fold forward from your hips",
  onFeet: "Stand on your feet",
  lieBack: "Lie on your back",
  kneesToChest: "Pull your knees toward your armpits",
  feetUp: "Lift your feet, soles to the ceiling",
  holdFeet: "Hold your feet",
  armsDown: "Rest your arms by your sides",
  feetWide: "Step your feet wide apart",
  bendFrontKnee: "Bend your front knee",
  backLegStraight: "Straighten your back leg",
  torsoUpright: "Keep your torso upright",
  armsOut: "Stretch your arms out to the sides at shoulder height",
  standOneLeg: "Stand on one straight leg",
  footOnLeg: "Place one foot on your other leg",
  kneeOut: "Turn your bent knee out to the side",
  chestUp: "Lift your chest",
  handsUnder: "Press your hands into the floor under your shoulders",
  feetTogether: "Bring the soles of your feet together",
  heelsIn: "Draw your heels in toward you",
  kneesOutSides: "Let your knees fall out to the sides",
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
    cat: H.showWhole,
    cow: H.showWhole,
    puppy: H.showWhole,
    down_dog: H.showWhole,
    plank: H.showWhole,
    plow: H.showWhole,
    straddle: H.showLegs,
    straddle_up: H.showLegs,
    child: H.showLegs,
    forward_fold: H.showLegs,
    happy_baby: H.showWhole,
    savasana: H.showWhole,
    hastasana: H.showWhole,
    warrior: H.showWhole,
    tree: H.showLegs,
    cobra: H.showWhole,
    butterfly: H.showLegs,
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

    case "hastasana": {
      // what's missing for standing first, then for the arms
      const stand = assessPosture("stand", pose, aspect);
      if (stand.state !== "in") return stand;
      const up = assessPosture("arms_up", pose, aspect);
      if (up.state !== "in") return up;
      for (const [s, e, w] of [
        [ls, POSE.leftElbow, lw],
        [rs, POSE.rightElbow, rw],
      ] as const) {
        const elbow = at(e);
        if (s && elbow && w && angle(s, elbow, w) <= POSTURE.straightMinDeg) return out(H.armsStraight);
      }
      return IN;
    }

    case "cat":
    case "cow":
    case "puppy":
    case "down_dog":
    case "plank":
    case "plow":
    case "straddle":
    case "straddle_up":
    case "child":
    case "forward_fold":
    case "happy_baby":
    case "savasana":
    case "warrior":
    case "tree":
    case "cobra":
    case "butterfly": {
      const sm = ls && rs ? mid(ls, rs) : ls ?? rs;
      const hm = lh && rh ? mid(lh, rh) : lh ?? rh;
      if (!sm || !hm) return unknown;
      const torso = dist(sm, hm);
      const scale = Math.max(torso, sw);
      if (scale <= 0) return unknown;
      const legs: Limb[] = [];
      const arms: Limb[] = [];
      for (const [h, k, a] of [
        [POSE.leftHip, POSE.leftKnee, POSE.leftAnkle],
        [POSE.rightHip, POSE.rightKnee, POSE.rightAnkle],
      ] as const) {
        const root = at(h);
        const joint = at(k);
        const end = at(a);
        if (root && joint && end) legs.push({ root, joint, end });
      }
      for (const [s, e, w] of [
        [POSE.leftShoulder, POSE.leftElbow, POSE.leftWrist],
        [POSE.rightShoulder, POSE.rightElbow, POSE.rightWrist],
      ] as const) {
        const root = at(s);
        const end = at(w);
        if (root && end) arms.push({ root, joint: at(e), end });
      }
      const side = sw < POSTURE.sideMaxShoulderTorso * torso;
      const head = at(POSE.nose) ?? midOf(at(POSE.leftEye), at(POSE.rightEye)) ?? midOf(at(POSE.leftEar), at(POSE.rightEar));
      return yogaPose(action, { sm, hm, torso, scale, side, legs, arms, head }) ?? unknown;
    }
  }
}

/** A limb from its root (shoulder, hip) over the middle joint (elbow, knee) to its end (wrist, ankle). */
interface Limb {
  root: Q;
  joint: Q | undefined;
  end: Q;
}

interface Body {
  /** shoulder and hip midpoints (or the one visible side) */
  sm: Q;
  hm: Q;
  torso: number;
  /** max(torso length, shoulder width) */
  scale: number;
  /** seen side-on (else facing the camera, or turned away) */
  side: boolean;
  /** visible legs (with knee) and arms (elbow optional) */
  legs: Limb[];
  arms: Limb[];
  head: Q | undefined;
}

const midOf = (a: Q | undefined, b: Q | undefined): Q | undefined => (a && b ? mid(a, b) : undefined);

const straight = (l: Limb, minDeg: number = POSTURE.straightMinDeg): boolean =>
  l.joint === undefined || angle(l.root, l.joint, l.end) > minDeg;

/**
 * The yoga poses; undefined when the needed landmarks are missing.
 * Seen from a side that can't show the pose: unknown, with a hint to turn.
 * Checks run most basic first; the first one that fails gives the hint.
 */
function yogaPose(action: PoseAction, b: Body): PostureVerdict | undefined {
  const H = POSTURE_HINTS;
  const P = POSTURE;
  const { sm, hm, torso, scale, legs, arms } = b;
  /** checks in order: [ok, hint when not] */
  const first = (checks: readonly (readonly [boolean, string])[]): PostureVerdict => {
    for (const [ok, hint] of checks) if (!ok) return { state: "out", hint };
    return { state: "in" };
  };
  const turnSide: PostureVerdict = { state: "unknown", hint: H.turnSide };
  const faceCamera: PostureVerdict = { state: "unknown", hint: H.faceCamera };
  const all = <T>(xs: readonly T[], f: (x: T) => boolean): boolean => xs.every(f);
  const spread = (): number | undefined => {
    if (legs.length < 2) return undefined;
    return angle(legs[0]!.end, hm, legs[1]!.end);
  };

  switch (action) {
    case "cat":
    case "cow":
    case "puppy": {
      if (legs.length === 0 || arms.length === 0) return undefined;
      // knees on the floor, bent, the hips up over them
      const kneesDown = all(
        legs,
        (l) =>
          l.joint !== undefined &&
          Math.abs(l.joint.y - l.end.y) < P.kneelKneeAnkleMaxTorso * scale &&
          angle(l.root, l.joint, l.end) < P.bentKneeMaxDeg,
      );
      const hipsUp = all(legs, (l) => l.joint !== undefined && l.joint.y - l.root.y >= P.fourHipsAboveKnees * scale);
      const kneeY = Math.max(...legs.map((l) => l.joint!.y));
      if (action === "puppy") {
        if (!b.side) return turnSide;
        return first([
          [kneesDown, H.allFours],
          [hipsUp, H.hipsOverKnees],
          [all(arms, (a) => a.end.y - a.root.y <= P.puppyChestAboveHands * scale), H.chestDown],
          [all(arms, (a) => dist(a.end, hm) >= dist(a.root, hm) + P.puppyReach * scale), H.reachForward],
        ]);
      }
      if (b.head === undefined) return undefined;
      const headDrop = b.head.y - sm.y;
      return first([
        [kneesDown, H.allFours],
        [all(arms, (a) => a.end.y >= kneeY - P.fourHandsAboveKnees * scale), H.handsFloor],
        [hipsUp, H.hipsOverKnees],
        [all(arms, (a) => a.end.y - a.root.y >= P.fourChestAboveHands * scale && straight(a)), H.armsStraight],
        action === "cat"
          ? [headDrop >= P.catHeadBelowShoulders * scale, H.roundBack]
          : [-headDrop >= P.cowHeadAboveShoulders * scale, H.archBack],
      ]);
    }

    case "down_dog": {
      if (legs.length === 0 || arms.length === 0) return undefined;
      if (!b.side) return turnSide;
      const hipDeg = Math.min(...legs.map((l) => angle(sm, hm, l.end)));
      return first([
        [all(arms, (a) => a.end.y > a.root.y), H.handsFloor],
        [sm.y - hm.y >= P.dogHipsAboveShoulders * torso, H.hipsUp],
        [all(legs, (l) => straight(l, P.softKneeMinDeg)), H.legsStraight],
        [all(arms, (a) => straight(a)), H.armsStraight],
        [hipDeg >= P.foldHipMaxDeg, H.handsForward],
        [hipDeg <= P.dogHipMaxDeg, H.hipsUp],
      ]);
    }

    case "plank": {
      if (legs.length === 0 || arms.length === 0) return undefined;
      if (!b.side) return turnSide;
      const supported = arms.some((a) => Math.max(a.end.y, a.joint?.y ?? a.end.y) - a.root.y >= P.plankSupport * torso);
      // the most bent side decides; sagging hips sit below the shoulder-ankle line
      let worst: { deg: number; sag: boolean } | undefined;
      for (const l of legs) {
        const deg = angle(sm, hm, l.end);
        const dx = l.end.x - sm.x;
        const lineY = dx === 0 ? hm.y : sm.y + ((l.end.y - sm.y) * (hm.x - sm.x)) / dx;
        if (worst === undefined || deg < worst.deg) worst = { deg, sag: hm.y > lineY };
      }
      return first([
        [tiltFromHorizontal(sm, hm) <= P.plankMaxTiltDeg, H.bodyLevel],
        [supported, H.onHands],
        [all(legs, (l) => straight(l)), H.legsStraight],
        [worst!.deg > P.plankBodyMinDeg, worst!.sag ? H.hipsUp : H.hipsLower],
      ]);
    }

    case "child": {
      if (legs.length === 0) return undefined;
      return first([
        [all(legs, (l) => Math.abs(l.joint!.y - l.end.y) < P.kneelKneeAnkleMaxTorso * scale && angle(l.root, l.joint!, l.end) < P.bentKneeMaxDeg), H.kneesDown],
        [all(legs, (l) => Math.abs(l.end.y - l.root.y) < P.kneelSitHipAnkleMaxTorso * scale), H.ontoHeels],
        [hm.y - sm.y <= P.childShouldersAboveHips * scale, H.foldOverThighs],
      ]);
    }

    case "forward_fold": {
      if (legs.length === 0) return undefined;
      return first([
        [all(legs, (l) => l.end.y - hm.y >= P.foldHipsAboveFeet * scale && l.end.y - sm.y >= P.plowFeetBelowShoulders * scale), H.onFeet],
        [sm.y - hm.y >= P.foldShouldersBelowHips * scale, H.foldDeeper],
        [all(legs, (l) => straight(l, P.softKneeMinDeg)), H.legsStraight],
        [!b.side || all(legs, (l) => angle(sm, hm, l.end) < P.foldHipMaxDeg), H.foldDeeper],
      ]);
    }

    case "happy_baby": {
      if (legs.length === 0 || arms.length === 0) return undefined;
      if (!b.side) return turnSide;
      return first([
        [tiltFromHorizontal(sm, hm) <= P.lieMaxTiltDeg, H.lieBack],
        [all(legs, (l) => hm.y - l.joint!.y >= P.happyKneesAboveHips * torso && angle(sm, hm, l.joint!) <= P.happyHipMaxDeg), H.kneesToChest],
        [all(legs, (l) => !straight(l)), H.bendKnees],
        [all(legs, (l) => l.joint!.y - l.end.y >= P.happyFeetAboveKnees * torso), H.feetUp],
        [all(arms, (a) => legs.some((l) => dist(a.end, l.end) <= P.happyHandsToFeet * torso)), H.holdFeet],
      ]);
    }

    case "savasana": {
      if (legs.length === 0 || arms.length === 0) return undefined;
      if (!b.side) return turnSide;
      const low = (q: Q): boolean => Math.abs(q.y - hm.y) <= P.savasanaOffFloor * torso;
      return first([
        [tiltFromHorizontal(sm, hm) <= P.lieMaxTiltDeg, H.lieFlat],
        [all(legs, (l) => low(l.joint!) && low(l.end)), H.legsDown],
        [all(legs, (l) => straight(l)), H.legsStraight],
        [all(arms, (a) => low(a.end) && dist(a.end, hm) <= torso), H.armsDown],
      ]);
    }

    case "warrior": {
      if (legs.length < 2 || arms.length < 2) return undefined;
      if (b.side) return faceCamera;
      const knees = legs.map((l) => angle(l.root, l.joint!, l.end));
      return first([
        [Math.abs(legs[0]!.end.x - legs[1]!.end.x) >= P.warriorFeetApart * scale, H.feetWide],
        [Math.min(...knees) <= P.warriorFrontKneeMaxDeg, H.bendFrontKnee],
        [Math.max(...knees) > P.straightMinDeg, H.backLegStraight],
        [90 - tiltFromHorizontal(sm, hm) <= P.uprightMaxTiltDeg, H.torsoUpright],
        [all(arms, (a) => straight(a) && tiltFromHorizontal(a.root, a.end) <= P.warriorArmMaxTiltDeg), H.armsOut],
      ]);
    }

    case "tree": {
      if (legs.length < 2) return undefined;
      if (b.side) return faceCamera;
      // the standing leg is the one whose foot is lower
      const [stand, lifted] = legs[0]!.end.y >= legs[1]!.end.y ? [legs[0]!, legs[1]!] : [legs[1]!, legs[0]!];
      /** horizontal distance of q from the standing leg's hip-ankle line */
      const offLeg = (q: Q): number => {
        const dy = stand.end.y - stand.root.y;
        const x = dy === 0 ? stand.root.x : stand.root.x + ((stand.end.x - stand.root.x) * (q.y - stand.root.y)) / dy;
        return Math.abs(q.x - x);
      };
      return first([
        [stand.end.y - hm.y >= P.treeStandFootBelowHips * scale && straight(stand), H.standOneLeg],
        [stand.end.y - lifted.end.y >= P.treeFootLifted * scale, H.footOnLeg],
        [offLeg(lifted.end) <= P.treeFootOnLeg * scale, H.footOnLeg],
        [!straight(lifted) && offLeg(lifted.joint!) >= P.treeKneeOut * scale, H.kneeOut],
        [90 - tiltFromHorizontal(sm, hm) <= P.uprightMaxTiltDeg, H.torsoUpright],
      ]);
    }

    case "butterfly": {
      if (legs.length < 2) return undefined;
      if (b.side) return faceCamera;
      const [l, r] = [legs[0]!, legs[1]!];
      return first([
        [all(legs, (g) => g.end.y - hm.y <= P.butterflyFeetBelowHips * scale && !straight(g)), H.sitDown],
        [dist(l.end, r.end) <= P.butterflyFeetApart * scale, H.feetTogether],
        [dist(mid(l.end, r.end), hm) <= P.butterflyHeelsIn * scale, H.heelsIn],
        [Math.abs(l.joint!.x - r.joint!.x) >= P.butterflyKneesApart * scale, H.kneesOutSides],
        [sm.y < hm.y && 90 - tiltFromHorizontal(sm, hm) <= P.butterflyTorsoMaxTiltDeg, H.backStraight],
      ]);
    }

    case "cobra": {
      if (legs.length === 0 || arms.length === 0) return undefined;
      if (!b.side) return turnSide;
      const low = (q: Q): boolean => Math.abs(q.y - hm.y) <= P.cobraLegsOffFloor * torso;
      return first([
        [all(legs, (l) => low(l.joint!) && low(l.end)), H.lieFlat],
        [all(legs, (l) => straight(l)), H.legsStraight],
        [hm.y - sm.y >= P.cobraChestUp * torso, H.chestUp],
        [
          all(arms, (a) => a.end.y - a.root.y >= P.cobraHandsBelowShoulders * torso && Math.abs(a.end.x - a.root.x) <= P.cobraHandsUnderShoulders * torso),
          H.handsUnder,
        ],
        [all(arms, (a) => straight(a, P.cobraElbowMinDeg)), H.armsStraight],
      ]);
    }

    case "plow": {
      if (legs.length === 0) return undefined;
      if (!b.side) return turnSide;
      return first([
        [sm.y - hm.y >= P.plowHipsAboveShoulders * torso, H.hipsOverShoulders],
        [all(legs, (l) => angle(sm, hm, l.end) <= P.plowHipMaxDeg), H.legsOverHead],
        [all(legs, (l) => l.end.y - sm.y <= P.plowFeetBelowShoulders * torso), H.shouldersDown],
        [all(legs, (l) => l.end.y - hm.y >= P.plowFeetBelowHips * torso), H.feetDown],
        [all(legs, (l) => straight(l)), H.legsStraight],
      ]);
    }

    case "straddle":
    case "straddle_up": {
      const deg = spread();
      if (deg === undefined) return undefined;
      if (b.side) return faceCamera;
      if (action === "straddle") {
        return first([
          [all(legs, (l) => l.end.y - hm.y <= P.straddleFeetBelowHips * scale), H.sitDown],
          [all(legs, (l) => hm.y - l.end.y <= P.straddleFeetAboveHips * scale), H.legsDown],
          [all(legs, (l) => straight(l)), H.legsStraight],
          [deg >= P.straddleMinDeg, H.legsWide],
        ]);
      }
      return first([
        [all(legs, (l) => hm.y - l.end.y >= P.straddleUpFeetAboveHips * scale), H.legsUp],
        [all(legs, (l) => straight(l)), H.legsStraight],
        [deg >= P.straddleUpMinDeg, H.legsWide],
        [sm.y < hm.y && 90 - tiltFromHorizontal(sm, hm) <= P.straddleUpTorsoMaxTiltDeg, H.backStraight],
      ]);
    }

    default:
      return undefined;
  }
}
