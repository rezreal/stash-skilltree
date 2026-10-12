// The on-video guide of the track rule: a vertical depth gauge at the right
// edge (IN at the top, OUT at the bottom) with the target line, a direction
// arrow, a hold band with progress, the user's position as a blue dot and a
// faint line at the user's max depth; and a strip at the bottom with the
// next 3 s of the script, the "now" line and the current position.
//
// With `glow` > 0 the video's edges light up during scored sections: strong
// green while the user is on the target, yellow turning red the further off
// (trackView.ts glowMismatch; the error is smoothed so colors don't flicker).
//
// Self-contained like FlashOverlay: it needs the video container and the
// video time as functions plus the track handle (useTrackSession), and is
// portalled into the container so it stays visible in fullscreen (the
// container must be positioned). rAF-driven, pointer-events none; it never
// handles keys, so Stop/Esc stay the player's.
import type * as ReactTypes from "react";
import {
  glowColor,
  glowMismatch,
  guideView,
  limitsLine,
  PREVIEW_H,
  PREVIEW_W,
  previewY,
  scoreLine,
  smoothError,
  type GuideView,
} from "./trackView.ts";
import type { TrackHandle } from "./useTrack.ts";
import { useTicker } from "./useTrack.ts";

interface ReactDomLike {
  createPortal(children: ReactTypes.ReactNode, container: Element): ReactTypes.ReactPortal;
}

function reactDom(): ReactDomLike | undefined {
  return (window as unknown as { PluginApi?: { ReactDOM?: ReactDomLike } }).PluginApi?.ReactDOM;
}

export interface TrackGuideProps {
  getContainer: () => HTMLElement | null;
  /** current video time in seconds; undefined while there is no video */
  getVideoTime: () => number | undefined;
  /** undefined renders nothing */
  track: TrackHandle | undefined;
  /** match glow strength 0..1 (trackGlow setting); 0 or unset = no glow */
  glow?: number;
  /** the smoothed mismatch (0 on target .. 1 off, undefined = nothing to judge), when it changes */
  onMatch?: (mismatch: number | undefined) => void;
}

/** a key that changes only when something visible changes (positions rounded to 0.5) */
function viewKey(v: GuideView, live: boolean, mismatch: number | undefined): string {
  const r = (n: number | undefined) => (n === undefined ? "-" : Math.round(n * 2) / 2);
  return [
    r(v.targetTop),
    r(v.currentTop),
    v.arrow ?? "",
    r(v.arrowTop),
    v.band ? `${r(v.band.top)}:${r(v.band.height)}` : "",
    v.label,
    v.section,
    v.previewPoints,
    r(v.currentY),
    live ? 1 : 0,
    mismatch === undefined ? "-" : Math.round(mismatch * 20),
  ].join("|");
}

export function TrackGuide(props: TrackGuideProps) {
  const { track } = props;
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const [state, setState] = React.useState<{ view: GuideView; live: boolean; mismatch: number | undefined } | undefined>(undefined);
  const getters = React.useRef(props);
  getters.current = props;

  React.useEffect(() => {
    if (!track) {
      setState(undefined);
      return;
    }
    let raf = 0;
    let lastKey = "";
    let lastEl: HTMLElement | null = null;
    let err: number | undefined;
    let lastMs = performance.now();
    let reported: number | undefined | null = null;
    const frame = () => {
      const nowMs = performance.now();
      const dt = nowMs - lastMs;
      lastMs = nowMs;
      const el = getters.current.getContainer();
      if (el !== lastEl) {
        lastEl = el;
        setContainer(el);
      }
      const t = getters.current.getVideoTime();
      if (t === undefined || !Number.isFinite(t)) {
        if (reported !== undefined) {
          reported = undefined;
          getters.current.onMatch?.(undefined);
        }
        if (lastKey !== "") {
          lastKey = "";
          setState(undefined);
        }
      } else {
        const g = track.guide(t);
        const view = guideView(g, track.limits);
        const live = track.live();
        let mismatch: number | undefined;
        const judging = (getters.current.glow ?? 0) > 0 || getters.current.onMatch !== undefined;
        if (live && track.calibrated && g.current !== undefined && judging) {
          err = smoothError(err, g.current - g.target, dt);
          mismatch = glowMismatch(g, err);
        } else {
          err = undefined;
        }
        const step = mismatch === undefined ? undefined : Math.round(mismatch * 20) / 20;
        if (step !== reported) {
          reported = step;
          getters.current.onMatch?.(step);
        }
        const key = viewKey(view, live, mismatch);
        if (key !== lastKey) {
          lastKey = key;
          setState({ view, live, mismatch });
        }
      }
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [track]);

  if (!track || !container || !state) return null;
  const layer = (
    <GuideLayer
      view={state.view}
      live={state.live}
      calibrated={track.calibrated}
      maxDepth={track.limits.maxDepth}
      mismatch={state.mismatch}
      glow={props.glow ?? 0}
    />
  );
  const dom = reactDom();
  return dom ? dom.createPortal(layer, container) : layer;
}

function Arrow(props: { up: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={props.up ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

function GuideLayer(props: { view: GuideView; live: boolean; calibrated: boolean; maxDepth: number; mismatch: number | undefined; glow: number }) {
  const { view: v, live, calibrated, maxDepth, mismatch, glow } = props;
  const limitY = previewY(maxDepth, PREVIEW_H);
  const glowStyle =
    glow > 0 && mismatch !== undefined
      ? ({ opacity: glow, "--stp-glow": glowColor(mismatch) } as ReactTypes.CSSProperties)
      : undefined;
  return (
    <div className={`stp-track${v.unscored ? " is-unscored" : ""}`}>
      {glow > 0 && <div className={`stp-track-glow${mismatch === 0 ? " is-match" : ""}`} style={glowStyle} aria-hidden="true" />}
      <div className="stp-track-gauge" role="img" aria-label={v.aria}>
        <span className="stp-track-end">IN</span>
        <div className="stp-track-rail">
          <div className="stp-track-bar" />
          {maxDepth < 100 && (
            <div className="stp-track-limit" style={{ top: `${v.limitTop}%` }} title={`Your max depth: ${Math.round(maxDepth)}`} />
          )}
          {v.band && <div className="stp-track-band" style={{ top: `${v.band.top}%`, height: `${v.band.height}%` }} />}
          <div className="stp-track-target" style={{ top: `${v.targetTop}%` }} />
          {v.arrow && (
            <div className="stp-track-arrow" style={{ top: `${v.arrowTop}%` }}>
              <Arrow up={v.arrow === "up"} />
            </div>
          )}
          {v.currentTop !== undefined && <div className="stp-track-current" style={{ top: `${v.currentTop}%` }} />}
        </div>
        <span className="stp-track-end">OUT</span>
        <span className="stp-track-label">{!calibrated ? `${v.label} · not scored` : live ? v.label : `${v.label} · no sensor`}</span>
      </div>

      <div className="stp-track-strip">
        <div className="stp-track-strip-head">
          <span>now</span>
          <span>{v.section}</span>
          <span>+3 s</span>
        </div>
        <svg viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`} preserveAspectRatio="none" role="img" aria-label="Upcoming track for the next three seconds">
          <line className="stp-track-grid" x1="0" y1="0" x2={PREVIEW_W} y2="0" />
          <line className="stp-track-grid" x1="0" y1={PREVIEW_H} x2={PREVIEW_W} y2={PREVIEW_H} />
          {maxDepth < 100 && <line className="stp-track-limit-line" x1="0" y1={limitY} x2={PREVIEW_W} y2={limitY} />}
          <polyline className="stp-track-line" points={v.previewPoints} />
          <line className="stp-track-now" x1="2" y1="0" x2="2" y2={PREVIEW_H} />
          {v.currentY !== undefined && <circle className="stp-track-dot" cx="6" cy={v.currentY} r="5" />}
        </svg>
      </div>
    </div>
  );
}

/**
 * Compact live score: "Strokes 34/48 · Holds 5/6 · Ramps 82% · lag 240 ms".
 * Updates twice a second; renders nothing without a track.
 */
export function TrackScoreLine(props: { track: TrackHandle | undefined; className?: string; showLimits?: boolean }) {
  const { track } = props;
  useTicker(track !== undefined, 500);
  if (!track) return null;
  const text = !track.calibrated
    ? "Track not scored – the distance sensor isn't calibrated"
    : !track.scored()
      ? "Track not scored – no distance sensor readings yet"
      : scoreLine(track.score());
  return (
    <div className={`stp-col stp-gap-sm ${props.className ?? ""}`}>
      <span className="stp-mono stp-small stp-track-score" role="status" aria-live="off">
        {text}
      </span>
      {props.showLimits && <span className="stp-small stp-muted">{limitsLine(track.limits)}</span>}
    </div>
  );
}
