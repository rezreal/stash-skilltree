// The prompt banner over the video: the active prompt's instruction in plain
// words, a progress bar (hold / phrase match), and the replaying / missed /
// done states. Polls the checks itself (~10 Hz) so the session controller
// doesn't re-render for every progress step.
//
// RegionOutline draws where a gaze prompt's target is on the video. Off by
// default (showRegion) so it isn't a giveaway unless the viewer wants it.
import type { PromptSpec, Region } from "../prompts/types.ts";
import type { PromptChecks } from "./usePromptChecks.ts";
import { bannerView, type BannerView } from "./wording.ts";

const POLL_MS = 100;
const IDLE_POLL_MS = 300;

/** Re-renders every `ms` while `on`. */
function usePoll(on: boolean, ms: number): void {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setN((n) => (n + 1) % 1_000_000), ms);
    return () => window.clearInterval(id);
  }, [on, ms]);
}

export function PromptBanner(props: {
  checks: PromptChecks;
  /** draw the gaze target's region over the video (default false) */
  showRegion?: boolean;
  className?: string;
}) {
  const { checks } = props;
  const view: BannerView | undefined =
    checks.specs.length === 0
      ? undefined
      : bannerView({
          progress: checks.progress(),
          videoTime: checks.videoTime(),
          nowMs: performance.now(),
          last: checks.lastResult(),
          uncheckable: checks.uncheckable,
        });
  // fast while something is on the banner, slower in between (results and
  // replays appear without the controller re-rendering)
  usePoll(checks.specs.length > 0, view || checks.active.length > 0 ? POLL_MS : IDLE_POLL_MS);

  if (!view) return null;
  const pct = Math.round(view.progress * 100);
  return (
    <div className={`stc-banner is-${view.tone}${view.note ? " is-unchecked" : ""}${props.className ? ` ${props.className}` : ""}`} role="status" aria-live="polite">
      <div className="stc-banner-head">
        <span className="stc-banner-text">{view.instruction}</span>
        {view.status && <span className="stc-banner-status">{view.status}</span>}
        {view.secondsLeft !== undefined && view.tone === "active" && (
          <span className="stc-banner-left stp-mono">{Math.ceil(view.secondsLeft)} s</span>
        )}
      </div>
      <div
        className="stc-banner-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={view.progressLabel}
      >
        <span className="stc-banner-fill" style={{ width: `${pct}%` }} />
      </div>
      {view.note && <span className="stc-banner-note">Not checked: {view.note}</span>}
      {props.showRegion && view.tone === "active" && view.spec.check === "gaze" && (
        <RegionOutline checks={checks} spec={view.spec} />
      )}
    </div>
  );
}

/**
 * The target region of a gaze prompt, drawn in viewport coordinates. It
 * renders an absolutely positioned layer over its positioned ancestor and
 * subtracts that layer's own rect, so it lines up wherever it is mounted
 * (including fullscreen). Polls at ~10 Hz while mounted.
 */
export function RegionOutline(props: { checks: PromptChecks; spec: PromptSpec }) {
  usePoll(true, POLL_MS);
  const ref = React.useRef<SVGSVGElement | null>(null);
  const [origin, setOrigin] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const region = props.checks.regionFor(props.spec);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.left !== origin.x || r.top !== origin.y) setOrigin({ x: r.left, y: r.top });
  });

  return (
    <svg ref={ref} className="stc-region" aria-hidden="true">
      {region && <RegionShape region={region} dx={-origin.x} dy={-origin.y} />}
    </svg>
  );
}

function RegionShape(props: { region: Region; dx: number; dy: number }) {
  const { region, dx, dy } = props;
  switch (region.kind) {
    case "ellipse":
      return <ellipse cx={region.cx + dx} cy={region.cy + dy} rx={region.rx} ry={region.ry} />;
    case "polygon":
      return <polygon points={region.points.map((p) => `${p.x + dx},${p.y + dy}`).join(" ")} />;
    case "outside": {
      const o = region.of;
      return <rect className="is-outside" x={o.left + dx} y={o.top + dy} width={o.right - o.left} height={o.bottom - o.top} />;
    }
    default:
      return null;
  }
}
