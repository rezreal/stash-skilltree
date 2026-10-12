// Gaze target regions on the page, from the person found in the video frame.
// Pure geometry: normalized video landmarks -> viewport CSS px through the
// letterboxed content rect of the <video> element (object-fit: contain).
//
// Sizes are relative to the person: the unit is the on-screen shoulder width
// (estimated from hips, face or eyes when the shoulders are missing). Every
// region is at least minDiameterPx across (default 90 px) because trackers
// are only accurate to about 1-2 degrees.

import { insideRect } from "../gaze/attention.ts";
import { POSE } from "./types.ts";
import type { ViewportPoint } from "../gaze/types.ts";
import type { ContentRect, GazeTarget, NormPoint, PersonFrame, Region, VideoBox } from "./types.ts";

export const DEFAULT_MIN_DIAMETER_PX = 90;
export const DEFAULT_MIN_VISIBILITY = 0.5;

export interface RegionOptions {
  /** smallest on-screen size of a region (diameter / side), CSS px */
  minDiameterPx?: number;
  /** landmarks with a lower visibility are ignored */
  minVisibility?: number;
  /** only regions on the person: feet_floor has no fallback without feet (the region heatmap) */
  personOnly?: boolean;
}

type P = ViewportPoint;

/** The rect the video content is drawn in under object-fit: contain. */
export function videoContentRect(box: VideoBox): ContentRect {
  const { left, top, width, height, videoWidth, videoHeight } = box;
  if (!(videoWidth > 0) || !(videoHeight > 0) || !(width > 0) || !(height > 0)) {
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const w = videoWidth * scale;
  const h = videoHeight * scale;
  const l = left + (width - w) / 2;
  const t = top + (height - h) / 2;
  return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h };
}

function project(p: NormPoint, r: ContentRect): P {
  return { x: r.left + p.x * r.width, y: r.top + p.y * r.height };
}

/** A normalized video-frame point on the page. */
export function toViewport(p: NormPoint, box: VideoBox): ViewportPoint {
  return project(p, videoContentRect(box));
}

// --- geometry helpers ----------------------------------------------------------

const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: P, b: P): P => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a: P, b: P, f: number): P => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
const add = (a: P, b: P): P => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: P, f: number): P => ({ x: a.x * f, y: a.y * f });
const sub = (a: P, b: P): P => ({ x: a.x - b.x, y: a.y - b.y });

function bbox(points: P[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

const cross = (o: P, a: P, b: P): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Convex hull (Andrew's monotone chain). */
export function convexHull(points: P[]): P[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const lower: P[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Each point replaced by a 12-gon of radius r (hull of disks, approximated). */
function padPoints(points: P[], r: number): P[] {
  if (r <= 0) return points;
  const out: P[] = [];
  for (const p of points) {
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      out.push({ x: p.x + r * Math.cos(a), y: p.y + r * Math.sin(a) });
    }
  }
  return out;
}

/**
 * Polygon region from points: hull, padded by padPx, then stretched about its
 * centre so its bounding box is at least minD on each axis.
 */
function polygonRegion(points: P[], padPx: number, minD: number): Region {
  let hull = convexHull(padPoints(points, padPx));
  let b = bbox(hull);
  if (hull.length < 3 || b.maxX - b.minX < 1 || b.maxY - b.minY < 1) {
    hull = convexHull(padPoints(points, Math.max(padPx, minD / 2)));
    b = bbox(hull);
  }
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const fx = w < minD ? minD / w : 1;
  const fy = h < minD ? minD / h : 1;
  if (fx !== 1 || fy !== 1) hull = hull.map((p) => ({ x: cx + (p.x - cx) * fx, y: cy + (p.y - cy) * fy }));
  return { kind: "polygon", points: hull };
}

function ellipse(c: P, rx: number, ry: number, minD: number): Region {
  return { kind: "ellipse", cx: c.x, cy: c.y, rx: Math.max(rx, minD / 2), ry: Math.max(ry, minD / 2) };
}

// --- the person ----------------------------------------------------------------

/** Pose landmarks on the page; undefined where missing or not visible enough. */
type Pose = (P | undefined)[];

interface FaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
  leftEye?: P;
  rightEye?: P;
  mouth?: P;
}

interface Person {
  pose?: Pose;
  face?: FaceBox;
  /** shoulder width on screen, 0 when unknown */
  unit: number;
}

function visible(p: NormPoint | undefined, minVis: number): boolean {
  return (
    p !== undefined &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    (p.visibility === undefined || p.visibility >= minVis)
  );
}

function poseOnPage(pose: NormPoint[], r: ContentRect, minVis: number): Pose {
  return pose.map((p) => (visible(p, minVis) ? project(p, r) : undefined));
}

function presentOf(pose: Pose, idx: number[]): P[] {
  const out: P[] = [];
  for (const i of idx) {
    const p = pose[i];
    if (p !== undefined) out.push(p);
  }
  return out;
}

function diag(points: P[]): number {
  if (points.length < 2) return 0;
  const b = bbox(points);
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
}

/** Size of a pose: shoulder/hip extent, else half the extent of all its landmarks. */
function poseExtent(pose: Pose): number {
  const core = presentOf(pose, [POSE.leftShoulder, POSE.rightShoulder, POSE.leftHip, POSE.rightHip]);
  if (core.length >= 2) return diag(core);
  return diag(pose.filter((p): p is P => p !== undefined)) * 0.5;
}

function findPerson(frame: PersonFrame, r: ContentRect, minVis: number): Person {
  let pose: Pose | undefined;
  let bestExtent = 0;
  for (const raw of frame.poses) {
    const p = poseOnPage(raw, r, minVis);
    const e = poseExtent(p);
    if (e > bestExtent) {
      bestExtent = e;
      pose = p;
    }
  }

  const faces: FaceBox[] = frame.faces
    .filter((f) => [f.box.x, f.box.y, f.box.w, f.box.h].every(Number.isFinite) && f.box.w > 0 && f.box.h > 0)
    .map((f) => {
      const tl = project({ x: f.box.x, y: f.box.y }, r);
      const fb: FaceBox = { left: tl.x, top: tl.y, width: f.box.w * r.width, height: f.box.h * r.height };
      if (visible(f.leftEye, minVis)) fb.leftEye = project(f.leftEye!, r);
      if (visible(f.rightEye, minVis)) fb.rightEye = project(f.rightEye!, r);
      if (visible(f.mouth, minVis)) fb.mouth = project(f.mouth!, r);
      return fb;
    });
  const largestFace = (): FaceBox | undefined =>
    faces.reduce<FaceBox | undefined>((a, f) => (a === undefined || f.width * f.height > a.width * a.height ? f : a), undefined);

  // the face of the main pose: the one containing its nose; if the pose has a
  // visible nose and no face contains it, the faces belong to someone else
  let face: FaceBox | undefined;
  const nose = pose?.[POSE.nose];
  if (nose !== undefined) {
    face = faces.find((f) => insideRect(nose, { left: f.left, top: f.top, right: f.left + f.width, bottom: f.top + f.height }));
  } else {
    face = largestFace();
  }

  let unit = 0;
  const ls = pose?.[POSE.leftShoulder];
  const rs = pose?.[POSE.rightShoulder];
  const lh = pose?.[POSE.leftHip];
  const rh = pose?.[POSE.rightHip];
  if (ls && rs) unit = dist(ls, rs);
  if (unit <= 0 && lh && rh) unit = dist(lh, rh) * 1.33;
  if (unit <= 0 && face) unit = face.width * 2.5;
  if (unit <= 0 && pose) {
    const le = pose[POSE.leftEye];
    const re = pose[POSE.rightEye];
    if (le && re) unit = dist(le, re) * 6;
  }
  const out: Person = { unit };
  if (pose !== undefined) out.pose = pose;
  if (face !== undefined) out.face = face;
  return out;
}

// --- targets -------------------------------------------------------------------

/**
 * The region of the page that counts as looking at `target`, or undefined
 * when the landmarks it needs are missing (the checker then does not count
 * that time). screen_center, off_screen and the feet_floor fallback need no
 * person (opts.personOnly: feet_floor without feet is undefined). eyes_closed
 * has no region (always undefined; its check does not use one, so this is
 * not "landmarks missing").
 */
export function targetRegion(
  target: GazeTarget,
  frame: PersonFrame,
  box: VideoBox,
  opts?: RegionOptions,
): Region | undefined {
  const minD = opts?.minDiameterPx ?? DEFAULT_MIN_DIAMETER_PX;
  const minVis = opts?.minVisibility ?? DEFAULT_MIN_VISIBILITY;
  const r = videoContentRect(box);
  const centre: P = { x: r.left + r.width / 2, y: r.top + r.height / 2 };

  if (target === "eyes_closed") return undefined;
  if (target === "screen_center") return ellipse(centre, r.width * 0.125, r.height * 0.125, minD);
  if (target === "off_screen") {
    const mx = r.width * 0.05;
    const my = r.height * 0.05;
    return { kind: "outside", of: { left: r.left - mx, top: r.top - my, right: r.right + mx, bottom: r.bottom + my } };
  }

  const person = findPerson(frame, r, minVis);
  const pose: Pose = person.pose ?? [];
  const face = person.face;
  const u = person.unit;
  const at = (i: number): P | undefined => pose[i];

  switch (target) {
    case "eyes": {
      let le = face?.leftEye;
      let re = face?.rightEye;
      if (le === undefined && re === undefined) {
        le = at(POSE.leftEye);
        re = at(POSE.rightEye);
      }
      if (le && re) {
        const d = dist(le, re);
        return ellipse(mid(le, re), d * 0.9, d * 0.45, minD);
      }
      const one = le ?? re;
      if (one === undefined) return undefined;
      const d = face ? face.width * 0.4 : u / 6;
      return ellipse(one, d * 0.9, d * 0.45, minD);
    }

    case "face": {
      if (face) {
        const c = { x: face.left + face.width / 2, y: face.top + face.height / 2 };
        return ellipse(c, (face.width / 2) * 1.1, (face.height / 2) * 1.1, minD);
      }
      const pts = presentOf(pose, [POSE.nose, POSE.leftEye, POSE.rightEye, POSE.leftEar, POSE.rightEar]);
      if (pts.length === 0 || (pts.length === 1 && u <= 0)) return undefined;
      const b = bbox(pts);
      const rx = Math.max(((b.maxX - b.minX) / 2) * 1.2, u * 0.2);
      const ry = Math.max(rx * 1.3, ((b.maxY - b.minY) / 2) * 1.2);
      return ellipse({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, rx, ry, minD);
    }

    case "mouth": {
      const ml = at(POSE.mouthLeft);
      const mr = at(POSE.mouthRight);
      let c: P | undefined = face?.mouth;
      let w = face ? face.width * 0.45 : u * 0.15;
      if (c === undefined) {
        if (ml && mr) {
          c = mid(ml, mr);
          w = Math.max(w, dist(ml, mr) * 1.8);
        } else c = ml ?? mr;
      }
      if (c === undefined) return undefined;
      return ellipse(c, w / 2, w * 0.35, minD);
    }

    case "hands":
      return handsRegion(frame, pose, r, minVis, u, minD);

    case "chest": {
      const ls = at(POSE.leftShoulder);
      const rs = at(POSE.rightShoulder);
      if (!ls || !rs) return undefined;
      const sw = dist(ls, rs);
      // hips missing (close-ups): assume an upright torso 1.4 shoulder widths long
      const down: P = { x: 0, y: 1.4 * sw };
      const lh = at(POSE.leftHip) ?? add(ls, down);
      const rh = at(POSE.rightHip) ?? add(rs, down);
      const pts = [ls, rs, lerp(rs, rh, 0.4), lerp(ls, lh, 0.4)];
      return polygonRegion(pts, sw * 0.08, minD);
    }

    case "torso": {
      const pts = presentOf(pose, [POSE.leftShoulder, POSE.rightShoulder, POSE.rightHip, POSE.leftHip]);
      if (pts.length < 4) return undefined;
      return polygonRegion(pts, u * 0.08, minD);
    }

    case "hips": {
      const lh = at(POSE.leftHip);
      const rh = at(POSE.rightHip);
      if (!lh || !rh) return undefined;
      const len = dist(lh, rh);
      const unit = u > 0 ? u : len * 1.33;
      const dir = len > 0 ? scale(sub(rh, lh), 1 / len) : { x: 1, y: 0 };
      const n: P = { x: -dir.y, y: dir.x };
      const ext = scale(dir, unit * 0.25);
      const hh = unit * 0.3;
      const a = sub(lh, ext);
      const b = add(rh, ext);
      const pts = [add(a, scale(n, hh)), add(b, scale(n, hh)), sub(b, scale(n, hh)), sub(a, scale(n, hh))];
      return polygonRegion(pts, 0, minD);
    }

    case "groin": {
      const lh = at(POSE.leftHip);
      const rh = at(POSE.rightHip);
      if (!lh || !rh) return undefined;
      const hm = mid(lh, rh);
      const hipW = dist(lh, rh);
      const unit = u > 0 ? u : hipW * 1.33;
      const lk = at(POSE.leftKnee);
      const rk = at(POSE.rightKnee);
      // knees missing: thighs about 1.2 shoulder widths, straight down
      const km = lk && rk ? mid(lk, rk) : lk ?? rk ?? add(hm, { x: 0, y: unit * 1.2 });
      const thigh = sub(km, hm);
      const half = hipW > 0 ? scale(sub(rh, lh), 0.5) : { x: unit * 0.35, y: 0 };
      const top = add(hm, scale(thigh, -0.05));
      const bottom = add(hm, scale(thigh, 0.35));
      const pts = [sub(top, half), add(top, half), add(bottom, half), sub(bottom, half)];
      return polygonRegion(pts, 0, minD);
    }

    case "legs": {
      const hips = presentOf(pose, [POSE.leftHip, POSE.rightHip]);
      const lower = presentOf(pose, [POSE.leftKnee, POSE.rightKnee, POSE.leftAnkle, POSE.rightAnkle]);
      if (hips.length === 0 || lower.length === 0) return undefined;
      return polygonRegion([...hips, ...lower], Math.max(u * 0.12, 10), minD);
    }

    case "feet_floor": {
      let feet = presentOf(pose, [POSE.leftHeel, POSE.rightHeel, POSE.leftFootIndex, POSE.rightFootIndex]);
      if (feet.length === 0) feet = presentOf(pose, [POSE.leftAnkle, POSE.rightAnkle]);
      if (feet.length === 0 && opts?.personOnly) return undefined;
      if (feet.length === 0) {
        const top = r.bottom - r.height * 0.2;
        return polygonRegion(
          [
            { x: r.left, y: top },
            { x: r.right, y: top },
            { x: r.right, y: r.bottom },
            { x: r.left, y: r.bottom },
          ],
          0,
          minD,
        );
      }
      const unit = u > 0 ? u : r.height * 0.1;
      const b = bbox(feet);
      // "in front": the side the toes point to
      let front = 0;
      for (const [heel, toe] of [
        [POSE.leftHeel, POSE.leftFootIndex],
        [POSE.rightHeel, POSE.rightFootIndex],
      ] as const) {
        const h = at(heel);
        const t = at(toe);
        if (h && t) front += t.x - h.x;
      }
      const left = b.minX - unit * 0.2 - (front < 0 ? unit * 0.4 : 0);
      const right = b.maxX + unit * 0.2 + (front > 0 ? unit * 0.4 : 0);
      const top = b.minY - unit * 0.05;
      const bottom = Math.max(b.maxY + unit * 0.15, r.bottom);
      return polygonRegion(
        [
          { x: left, y: top },
          { x: right, y: top },
          { x: right, y: bottom },
          { x: left, y: bottom },
        ],
        0,
        minD,
      );
    }
  }
  return undefined;
}

/**
 * The main person as a whole: the hull of their visible pose landmarks and
 * face box, padded by a tenth of the shoulder width (at least 10 px).
 * undefined without a person.
 */
export function personRegion(frame: PersonFrame, box: VideoBox, opts?: RegionOptions): Region | undefined {
  const minD = opts?.minDiameterPx ?? DEFAULT_MIN_DIAMETER_PX;
  const minVis = opts?.minVisibility ?? DEFAULT_MIN_VISIBILITY;
  const person = findPerson(frame, videoContentRect(box), minVis);
  const pts = (person.pose ?? []).filter((p): p is P => p !== undefined);
  const f = person.face;
  if (f) {
    pts.push(
      { x: f.left, y: f.top },
      { x: f.left + f.width, y: f.top },
      { x: f.left + f.width, y: f.top + f.height },
      { x: f.left, y: f.top + f.height },
    );
  }
  if (pts.length === 0) return undefined;
  return polygonRegion(pts, Math.max(person.unit * 0.1, 10), minD);
}

/** One point set per hand of the main person; undefined when the hands can't be told apart from someone else's. */
function handSets(frame: PersonFrame, pose: Pose, r: ContentRect, minVis: number, u: number, minD: number): P[][] | undefined {
  const hands: P[][] = frame.hands
    .map((h) => h.filter((p) => visible(p, minVis)).map((p) => project(p, r)))
    .filter((h) => h.length > 0);
  const wrists = presentOf(pose, [POSE.leftWrist, POSE.rightWrist]);
  const reach = Math.max(u * 0.8, minD);

  const sets: P[][] = [];
  if (wrists.length > 0) {
    const used = new Set<number>();
    for (const w of wrists) {
      let best = -1;
      let bestD = Infinity;
      hands.forEach((h, i) => {
        if (used.has(i)) return;
        const d = dist(h[0]!, w);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0 && bestD <= reach) {
        used.add(best);
        sets.push([w, ...hands[best]!]);
      } else sets.push([w]);
    }
  } else if (pose.some((p) => p !== undefined)) {
    // a pose without visible wrists: hand landmarks would belong to someone else
    return undefined;
  } else {
    sets.push(...hands.slice(0, 2));
  }
  return sets;
}

const handPad = (s: P[], u: number): number => (s.length === 1 ? Math.max(u * 0.3, 10) : Math.max(u * 0.08, 10));

function handEllipse(s: P[], u: number, minD: number): Region {
  const b = bbox(s);
  const p = handPad(s, u);
  return ellipse({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, (b.maxX - b.minX) / 2 + p, (b.maxY - b.minY) / 2 + p, minD);
}

/** both hands as one region (the hull of the two), or the one hand */
function handsRegion(frame: PersonFrame, pose: Pose, r: ContentRect, minVis: number, u: number, minD: number): Region | undefined {
  const sets = handSets(frame, pose, r, minVis, u, minD);
  if (!sets || sets.length === 0) return undefined;
  if (sets.length === 1) return handEllipse(sets[0]!, u, minD);
  const all: P[] = [];
  for (const s of sets) all.push(...padPoints(s, handPad(s, u)));
  return polygonRegion(all, 0, minD);
}

/**
 * Each hand of the main person as its own region (the "hands" target joins
 * them into one hull, which also covers what lies between them).
 */
export function handRegions(frame: PersonFrame, box: VideoBox, opts?: RegionOptions): Region[] {
  const minD = opts?.minDiameterPx ?? DEFAULT_MIN_DIAMETER_PX;
  const minVis = opts?.minVisibility ?? DEFAULT_MIN_VISIBILITY;
  const r = videoContentRect(box);
  const person = findPerson(frame, r, minVis);
  const sets = handSets(frame, person.pose ?? [], r, minVis, person.unit, minD) ?? [];
  return sets.map((s) => handEllipse(s, person.unit, minD));
}

// --- hit test ------------------------------------------------------------------

function inPolygon(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInRegion(p: ViewportPoint, region: Region): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  switch (region.kind) {
    case "ellipse": {
      if (!(region.rx > 0) || !(region.ry > 0)) return false;
      const dx = (p.x - region.cx) / region.rx;
      const dy = (p.y - region.cy) / region.ry;
      return dx * dx + dy * dy <= 1;
    }
    case "polygon":
      return region.points.length >= 3 && inPolygon(p, region.points);
    case "outside":
      return !insideRect(p, region.of);
  }
}
