// Mapping MediaPipe landmarker results of the person in the VIDEO to a
// PersonFrame. Pure: inputs are plain landmark arrays (structurally what
// MediaPipe returns), no MediaPipe import.

import type { NormPoint, PersonFrame } from "../prompts/types.ts";

/** Structural subset of MediaPipe's NormalizedLandmark. */
export interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

/** Face mesh indices (478-point model with irises). "left" = the subject's left, as POSE. */
export const FACE = {
  /** iris centres (only in the 478-point mesh) */
  leftIris: 473,
  rightIris: 468,
  /** eye corners, the fallback when there are no irises */
  leftEyeOuter: 263,
  leftEyeInner: 362,
  rightEyeOuter: 33,
  rightEyeInner: 133,
  upperLipInner: 13,
  lowerLipInner: 14,
  mouthLeft: 291,
  mouthRight: 61,
} as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Landmarks to NormPoints; visibility is copied only when asked (pose models report it, face/hand models don't). */
export function toNormPoints(lms: readonly LandmarkLike[], withVisibility: boolean): NormPoint[] {
  return lms.map((l) =>
    withVisibility && typeof l.visibility === "number" ? { x: l.x, y: l.y, visibility: l.visibility } : { x: l.x, y: l.y },
  );
}

/**
 * Bounding box of the points with visibility >= minVisibility (points without
 * visibility count). Falls back to all points when none qualify.
 */
export function boundsOf(points: readonly NormPoint[], minVisibility = 0): Box | undefined {
  let use = points.filter((p) => p.visibility === undefined || p.visibility >= minVisibility);
  if (!use.length) use = points.slice();
  if (!use.length) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of use) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function area(b: Box | undefined): number {
  return b ? b.w * b.h : 0;
}

/** Sorts landmark sets largest (bounding box area) first; stable for ties. */
export function largestFirst<T>(items: readonly T[], box: (item: T) => Box | undefined): T[] {
  return items
    .map((item, i) => ({ item, i, a: area(box(item)) }))
    .sort((p, q) => q.a - p.a || p.i - q.i)
    .map((e) => e.item);
}

function mean(points: (LandmarkLike | undefined)[]): NormPoint | undefined {
  const ok = points.filter((p): p is LandmarkLike => !!p);
  if (!ok.length) return undefined;
  return {
    x: ok.reduce((s, p) => s + p.x, 0) / ok.length,
    y: ok.reduce((s, p) => s + p.y, 0) / ok.length,
  };
}

export type FaceSummary = PersonFrame["faces"][number];

/** Box, eye centres and mouth centre of one face mesh. */
export function summarizeFace(mesh: readonly LandmarkLike[]): FaceSummary | undefined {
  const box = boundsOf(toNormPoints(mesh, false));
  if (!box) return undefined;
  const hasIris = mesh.length > FACE.leftIris;
  const leftEye = hasIris ? mean([mesh[FACE.leftIris]]) : mean([mesh[FACE.leftEyeOuter], mesh[FACE.leftEyeInner]]);
  const rightEye = hasIris ? mean([mesh[FACE.rightIris]]) : mean([mesh[FACE.rightEyeOuter], mesh[FACE.rightEyeInner]]);
  const mouth = mean([mesh[FACE.upperLipInner], mesh[FACE.lowerLipInner], mesh[FACE.mouthLeft], mesh[FACE.mouthRight]]);
  const out: FaceSummary = { box };
  if (leftEye) out.leftEye = leftEye;
  if (rightEye) out.rightEye = rightEye;
  if (mouth) out.mouth = mouth;
  return out;
}

export interface PersonResults {
  /** PoseLandmarkerResult.landmarks */
  poses?: readonly (readonly LandmarkLike[])[];
  /** FaceLandmarkerResult.faceLandmarks */
  faces?: readonly (readonly LandmarkLike[])[];
  /** HandLandmarkerResult.landmarks */
  hands?: readonly (readonly LandmarkLike[])[];
}

/** Visibility a pose landmark needs to count for a pose's size. */
export const POSE_SIZE_VISIBILITY = 0.5;

/**
 * Builds a PersonFrame. Poses, faces and hands are each sorted largest first.
 * A model that was skipped for this frame yields an empty list.
 */
export function mapPersonFrame(videoTime: number, r: PersonResults): PersonFrame {
  const poses = largestFirst(
    (r.poses ?? []).map((p) => toNormPoints(p, true)),
    (p) => boundsOf(p, POSE_SIZE_VISIBILITY),
  );
  const faces = largestFirst(
    (r.faces ?? []).map(summarizeFace).filter((f): f is FaceSummary => !!f),
    (f) => f.box,
  );
  const hands = largestFirst(
    (r.hands ?? []).map((h) => toNormPoints(h, false)),
    (h) => boundsOf(h),
  );
  return { videoTime, poses, faces, hands };
}
