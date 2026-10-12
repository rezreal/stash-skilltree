// Where the "look back at the video" callout goes: at the viewer's gaze when
// it is known and inside the viewport, with an arrow pointing towards the
// video's centre. Pure geometry, tested under node --test.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * - overlay: inside the player's overlay host (fullscreen: the gaze is
 *   necessarily within the player)
 * - fixed: portalled to document.body, position: fixed (gaze elsewhere on
 *   the page)
 * undefined: no callout, the centred message on the video is used instead.
 */
export type CalloutMode = "overlay" | "fixed";

const finite = (p: Point | undefined): p is Point => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

export function insideRect(p: Point, r: Rect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
}

export function calloutMode(input: {
  point: Point | undefined;
  /** the sample was valid (eyes tracked) */
  valid: boolean;
  viewport: Size;
  /** the player's rect in viewport coordinates; null without a player */
  target: Rect | null;
  /** the player (or an ancestor of it) is the fullscreen element */
  fullscreen: boolean;
}): CalloutMode | undefined {
  const { point, target } = input;
  if (!input.valid || !finite(point) || !target) return undefined;
  const view: Rect = { left: 0, top: 0, right: input.viewport.width, bottom: input.viewport.height };
  if (!insideRect(point, view)) return undefined;
  if (input.fullscreen) return "overlay";
  // looking at the player already: the centred message is right there
  if (insideRect(point, target)) return undefined;
  return "fixed";
}

export interface CalloutPlacement {
  /** top-left of the callout box, in the bounds' coordinate space */
  left: number;
  top: number;
  /** arrow direction in degrees, 0 = pointing right, 90 = down (screen y) */
  angleDeg: number;
  /** where the arrow sits, relative to the box: on its edge facing the target */
  arrowX: number;
  arrowY: number;
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/**
 * Centres the box on the gaze point, keeps it `margin` px inside `bounds`
 * (the viewport, or the player in fullscreen) and aims the arrow from the
 * gaze point at the target's centre. Boxes larger than the bounds stick to
 * the top-left margin.
 */
export function placeCallout(input: {
  point: Point;
  target: Rect;
  bounds: Rect;
  size: Size;
  margin?: number;
}): CalloutPlacement {
  const { point, target, bounds, size } = input;
  const margin = input.margin ?? 8;
  const left = clamp(point.x - size.width / 2, bounds.left + margin, bounds.right - margin - size.width);
  const top = clamp(point.y - size.height / 2, bounds.top + margin, bounds.bottom - margin - size.height);

  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  const dx = cx - point.x;
  const dy = cy - point.y;
  const angleDeg = dx === 0 && dy === 0 ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI;

  const { x: arrowX, y: arrowY } = edgePoint(size, angleDeg);
  return { left, top, angleDeg, arrowX, arrowY };
}

/** where a ray from the box centre at `angleDeg` leaves the box (box coordinates) */
export function edgePoint(size: Size, angleDeg: number): Point {
  const hw = size.width / 2;
  const hh = size.height / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const tx = Math.abs(cos) > 1e-9 ? hw / Math.abs(cos) : Infinity;
  const ty = Math.abs(sin) > 1e-9 ? hh / Math.abs(sin) : Infinity;
  const t = Math.min(tx, ty);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { x: round(hw + cos * t), y: round(hh + sin * t) };
}

/** a rect relative to another (viewport -> container coordinates) */
export function relativeTo(r: Rect, origin: { left: number; top: number }): Rect {
  return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
}
