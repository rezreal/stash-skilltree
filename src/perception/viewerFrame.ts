// Mapping MediaPipe results of the VIEWER (webcam) to ViewerFrames. Pure: the
// stateful part (motion needs the previous frame) lives in a small mapper
// object without any browser dependency.

import { POSE } from "../prompts/types.ts";
import type { NormPoint, ViewerFrame } from "../prompts/types.ts";
import { headPoseFromMatrix } from "./headPose.ts";
import { toNormPoints } from "./personFrame.ts";
import type { LandmarkLike } from "./personFrame.ts";

/** Structural subset of MediaPipe's Classifications / Category. */
export interface BlendshapesLike {
  categories: readonly { categoryName: string; score: number }[];
}

/** Score of a named blendshape (e.g. "eyeBlinkLeft"), undefined when absent. */
export function blendshapeScore(shapes: BlendshapesLike | undefined, name: string): number | undefined {
  const c = shapes?.categories.find((k) => k.categoryName === name);
  return c ? c.score : undefined;
}

function visible(p: NormPoint | undefined, min: number): p is NormPoint {
  return !!p && (p.visibility === undefined || p.visibility >= min);
}

export interface HandRaisedOptions {
  /** how far (normalized frame height) the wrist must be above its shoulder */
  margin?: number;
  /** visibility the shoulder needs (default 0.5) */
  shoulderVisibility?: number;
  /** visibility the wrist needs; lower, a raised wrist is often at the frame edge (default 0.3) */
  wristVisibility?: number;
}

/**
 * True when a wrist is above the shoulder on the same side by more than
 * `margin` (default 0.1) of the frame height. y grows downwards.
 */
export function handRaised(pose: readonly NormPoint[] | undefined, opts: HandRaisedOptions = {}): boolean {
  if (!pose) return false;
  const margin = opts.margin ?? 0.1;
  const sv = opts.shoulderVisibility ?? 0.5;
  const wv = opts.wristVisibility ?? 0.3;
  const sides: [number, number][] = [
    [POSE.leftShoulder, POSE.leftWrist],
    [POSE.rightShoulder, POSE.rightWrist],
  ];
  return sides.some(([s, w]) => {
    const sh = pose[s];
    const wr = pose[w];
    return visible(sh, sv) && visible(wr, wv) && sh.y - wr.y > margin;
  });
}

/**
 * Mean Euclidean displacement (normalized units) over the landmarks present
 * and visible (>= minVisibility) in both frames. undefined when nothing is
 * comparable.
 */
export function meanDisplacement(
  prev: readonly NormPoint[] | undefined,
  cur: readonly NormPoint[] | undefined,
  minVisibility = 0.5,
): number | undefined {
  if (!prev || !cur) return undefined;
  const n = Math.min(prev.length, cur.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = prev[i];
    const b = cur[i];
    if (!visible(a, minVisibility) || !visible(b, minVisibility)) continue;
    sum += Math.hypot(b.x - a.x, b.y - a.y);
    count++;
  }
  return count ? sum / count : undefined;
}

/** Pose landmarks with visibility >= 0.5 needed to call a body "present". */
export const PRESENT_MIN_LANDMARKS = 8;
export const PRESENT_VISIBILITY = 0.5;

/** A face was found, or a pose with at least 8 landmarks at visibility >= 0.5. */
export function personPresent(facePresent: boolean, pose: readonly NormPoint[] | undefined): boolean {
  if (facePresent) return true;
  if (!pose) return false;
  let n = 0;
  for (const p of pose) if (visible(p, PRESENT_VISIBILITY) && p.visibility !== undefined) n++;
  return n >= PRESENT_MIN_LANDMARKS;
}

/** What the viewer analyzer got from MediaPipe for one webcam frame. */
export interface ViewerResults {
  /** FaceLandmarkerResult.faceLandmarks (first face is used) */
  faces?: readonly (readonly LandmarkLike[])[];
  /** FaceLandmarkerResult.faceBlendshapes */
  blendshapes?: readonly BlendshapesLike[];
  /** FaceLandmarkerResult.facialTransformationMatrixes */
  matrices?: readonly { data: ArrayLike<number> }[];
  /** PoseLandmarkerResult.landmarks (first pose is used) */
  poses?: readonly (readonly LandmarkLike[])[];
  /** webcam frame width / height */
  aspect?: number;
}

export interface ViewerFrameMapper {
  map(t: number, r: ViewerResults): ViewerFrame;
  reset(): void;
}

/**
 * Turns per-frame results into ViewerFrames. motion compares with the previous
 * frame of the same kind: pose landmarks when a pose is visible, else the face
 * mesh; it is undefined on the first frame and after a switch of kind.
 */
export function createViewerFrameMapper(): ViewerFrameMapper {
  let prev: { kind: "pose" | "face"; points: NormPoint[] } | undefined;
  return {
    reset() {
      prev = undefined;
    },
    map(t, r) {
      const face = r.faces?.[0];
      const facePresent = !!face && face.length > 0;
      const poseLms = r.poses?.[0];
      const pose = poseLms && poseLms.length ? toNormPoints(poseLms, true) : undefined;
      const frame: ViewerFrame = {
        t,
        facePresent,
        personPresent: personPresent(facePresent, pose),
        handRaised: handRaised(pose),
      };
      if (pose) frame.pose = pose;
      if (r.aspect && Number.isFinite(r.aspect)) frame.aspect = r.aspect;
      if (facePresent) {
        const shapes = r.blendshapes?.[0];
        const l = blendshapeScore(shapes, "eyeBlinkLeft");
        const rr = blendshapeScore(shapes, "eyeBlinkRight");
        if (l !== undefined) frame.eyeBlinkLeft = l;
        if (rr !== undefined) frame.eyeBlinkRight = rr;
        const m = r.matrices?.[0];
        const hp = m ? headPoseFromMatrix(m.data) : undefined;
        if (hp) {
          frame.yaw = hp.yaw;
          frame.pitch = hp.pitch;
          frame.roll = hp.roll;
        }
      }

      let cur: typeof prev;
      if (pose && personPresent(false, pose)) cur = { kind: "pose", points: pose };
      else if (face && face.length) cur = { kind: "face", points: toNormPoints(face, false) };
      if (cur && prev && prev.kind === cur.kind) {
        const m = meanDisplacement(prev.points, cur.points);
        if (m !== undefined) frame.motion = m;
      }
      prev = cur;
      return frame;
    },
  };
}
