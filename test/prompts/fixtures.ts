import { POSE } from "../../src/prompts/types.ts";
import type { NormPoint, PersonFrame, PromptSpec, VideoBox } from "../../src/prompts/types.ts";

/** 1000x1000 element showing a 16:9 video: content 1000x562.5 at top 218.75 */
export const BOX: VideoBox = { left: 0, top: 0, width: 1000, height: 1000, videoWidth: 1600, videoHeight: 900 };
/** no letterboxing: element 1600x900 at (100, 50) */
export const BOX_FULL: VideoBox = { left: 100, top: 50, width: 1600, height: 900, videoWidth: 1600, videoHeight: 900 };

type Name = keyof typeof POSE;

/** A 33-point pose; unspecified landmarks invisible. */
export function pose(points: Partial<Record<Name, readonly [number, number] | readonly [number, number, number]>>): NormPoint[] {
  const out: NormPoint[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  for (const [k, v] of Object.entries(points)) {
    if (!v) continue;
    out[POSE[k as Name]] = { x: v[0], y: v[1], visibility: v[2] ?? 0.99 };
  }
  return out;
}

/** a standing person in the middle of a 16:9 video frame */
export const STANDING = {
  nose: [0.5, 0.2],
  leftEye: [0.49, 0.19],
  rightEye: [0.51, 0.19],
  leftEar: [0.48, 0.2],
  rightEar: [0.52, 0.2],
  mouthLeft: [0.495, 0.22],
  mouthRight: [0.505, 0.22],
  leftShoulder: [0.45, 0.3],
  rightShoulder: [0.55, 0.3],
  leftElbow: [0.43, 0.42],
  rightElbow: [0.57, 0.42],
  leftWrist: [0.42, 0.52],
  rightWrist: [0.58, 0.52],
  leftHip: [0.47, 0.55],
  rightHip: [0.53, 0.55],
  leftKnee: [0.47, 0.72],
  rightKnee: [0.53, 0.72],
  leftAnkle: [0.47, 0.88],
  rightAnkle: [0.53, 0.88],
  leftHeel: [0.465, 0.9],
  rightHeel: [0.525, 0.9],
  leftFootIndex: [0.48, 0.92],
  rightFootIndex: [0.54, 0.92],
} satisfies Partial<Record<Name, [number, number]>>;

export function frame(poses: NormPoint[][], extra?: Partial<PersonFrame>): PersonFrame {
  return { videoTime: 0, poses, faces: [], hands: [], ...extra };
}

export function spec(over: Partial<PromptSpec>): PromptSpec {
  return { markerId: "m1", check: "gaze", start: 10, end: 15, title: "", holdSec: 2, ...over };
}
