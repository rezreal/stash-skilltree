// "Look back at the video" where the viewer is looking: while the session
// warns (grace) or has paused for inattention, a small callout follows the
// smoothed gaze point with an arrow towards the video's centre (or, during
// a gaze prompt, towards the target region: `aim`). Only while
// an eye tracker is connected and the point is valid and inside the
// viewport; otherwise the caller shows its centred message on the video.
//
// Fullscreen: the gaze is necessarily within the player, so the callout is
// drawn inside the overlay host (absolute, player coordinates). Otherwise,
// with the gaze elsewhere on the page, it is portalled to document.body
// (position: fixed, above stash's UI, pointer-events: none). Geometry in
// gazeCallout.ts.
import type { ViewportPoint } from "../gaze/types.ts";
import { smoothPoint } from "../gaze/index.ts";
import { useGaze, useGazePoint } from "../player/useGaze.ts";
import { stashPlayerApi } from "../stashplayer/api.ts";
import { calloutMode, placeCallout, type CalloutMode, type Rect, type Size } from "./gazeCallout.ts";

export interface GazeCalloutState {
  mode: CalloutMode;
  /** smoothed gaze, viewport coordinates */
  point: ViewportPoint;
  /** the player's rect, viewport coordinates */
  target: Rect;
  /** what the arrow points at (the player, or a gaze prompt's target region), viewport coordinates */
  aim: Rect;
}

/** the callout box; CSS (.stp-gaze-callout) uses the same size */
export const CALLOUT_SIZE: Size = { width: 280, height: 84 };

/** samples older than this count as lost (tracker stalled) */
const STALE_MS = 500;
/** short losses (blinks) keep the callout where it was */
const HOLD_MS = 400;

function toRect(r: DOMRect): Rect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function isFullscreenFor(el: Element): boolean {
  const fs = document.fullscreenElement;
  return !!fs && (fs === el || fs.contains(el));
}

/**
 * Where the callout goes right now, or undefined for the centred fallback.
 * Re-evaluated on every gaze frame and on every render of the caller.
 * aim: what to point at instead of the player (viewport coordinates); the
 * callout also hides while the gaze is on it.
 */
export function useGazeCallout(
  enabled: boolean,
  getTarget: () => HTMLElement | null,
  aim?: Rect,
): GazeCalloutState | undefined {
  const gaze = useGaze();
  const connected = gaze.status?.connection === "connected";
  const sample = useGazePoint(enabled && connected);
  const smoothed = React.useRef<{ p: ViewportPoint; t: number } | undefined>(undefined);
  const lastGood = React.useRef<{ state: GazeCalloutState; at: number } | undefined>(undefined);

  if (!enabled || !connected) {
    smoothed.current = undefined;
    lastGood.current = undefined;
    return undefined;
  }
  const el = getTarget();
  const now = performance.now();
  const fresh = !!sample && now - sample.t <= STALE_MS;
  if (el && sample && fresh && sample.valid && sample.point) {
    const prev = smoothed.current;
    const p = smoothPoint(prev?.p, sample.point, prev ? sample.t - prev.t : 0);
    smoothed.current = { p, t: sample.t };
    const target = toRect(el.getBoundingClientRect());
    const aimAt = aim ?? target;
    const mode = calloutMode({
      point: p,
      valid: true,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      target: aimAt,
      fullscreen: isFullscreenFor(el),
    });
    if (mode) {
      const state = { mode, point: p, target, aim: aimAt };
      lastGood.current = { state, at: now };
      return state;
    }
    lastGood.current = undefined;
    return undefined;
  }
  smoothed.current = undefined;
  const held = lastGood.current;
  return held && now - held.at <= HOLD_MS ? held.state : undefined;
}

export function GazeCallout(props: { state: GazeCalloutState; title: string; detail?: string }) {
  const { state } = props;
  const overlay = state.mode === "overlay";
  const bounds: Rect = overlay
    ? state.target
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const place = placeCallout({ point: state.point, target: state.aim, bounds, size: CALLOUT_SIZE });
  // overlay: the host fills the player, so player coordinates
  const left = overlay ? place.left - state.target.left : place.left;
  const top = overlay ? place.top - state.target.top : place.top;

  const box = (
    <div
      className={`stp-gaze-callout ${overlay ? "is-overlay" : "is-fixed"}`}
      style={{ left: `${left}px`, top: `${top}px`, width: `${CALLOUT_SIZE.width}px`, height: `${CALLOUT_SIZE.height}px` }}
      role="status"
      aria-live="polite"
    >
      <span className="stp-gaze-callout-title">{props.title}</span>
      {props.detail && <span className="stp-gaze-callout-detail">{props.detail}</span>}
      <svg
        className="stp-gaze-callout-arrow"
        width="30"
        height="30"
        viewBox="0 0 30 30"
        style={{ left: `${place.arrowX}px`, top: `${place.arrowY}px`, transform: `rotate(${place.angleDeg}deg)` }}
        aria-hidden="true"
      >
        <path d="M4 15h18M15 7l8 8-8 8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
  if (overlay) return box;
  return stashPlayerApi().ReactDOM.createPortal(box, document.body);
}
