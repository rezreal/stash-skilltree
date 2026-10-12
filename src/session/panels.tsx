// Status pieces of the session overlay: the "Counts when" panel (copied
// from src/player/PlayerScreen.tsx, which is going away; plus the track
// rule's row), the slim
// timeline above stash's control bar and useRecentChange.
import type { SceneInput } from "../core/types.ts";
import type { SessionState, WatchPolicy } from "../play/types.ts";
import { formatDuration, formatPercent } from "../player/format.ts";
import { timelineDots, timelineSegments } from "../player/timeline.ts";
import { policyLabel, promptsNeeded } from "../player/view.ts";

export function CountsWhen(props: { session: SessionState; policy: WatchPolicy; prompts: number; previousExposureSec: number }) {
  const { session, policy } = props;
  const bar = (fraction: number) => (
    <div className="stp-bar" aria-hidden="true">
      <div style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
    </div>
  );
  const passed = session.prompts.filter((p) => p.passed).length;
  const answered = session.prompts.length;
  const need = promptsNeeded(policy, props.prompts);
  const exposureMin = (props.previousExposureSec + session.exposureSec) / 60;

  return (
    <div className="stp-panel">
      <h2 className="stp-caps">Counts when</h2>
      {policy.rules.includes("attention") && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Attended</span>
            <span className="stp-mono">
              {formatPercent(session.attendedFraction)} <span className="stp-muted">/ {formatPercent(policy.attentionMin)}</span>
            </span>
          </div>
          {bar(policy.attentionMin > 0 ? session.attendedFraction / policy.attentionMin : 1)}
        </div>
      )}
      {policy.rules.includes("prompts") && props.prompts > 0 && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Prompts followed</span>
            <span className="stp-mono">
              {passed} of {answered} <span className="stp-muted">/ need {need} of {props.prompts}</span>
            </span>
          </div>
          {bar(need > 0 ? passed / need : 1)}
        </div>
      )}
      {policy.rules.includes("track") && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Track followed</span>
            {session.track !== undefined ? (
              <span className="stp-mono">
                {formatPercent(session.track)} <span className="stp-muted">/ {formatPercent(policy.trackMin)}</span>
              </span>
            ) : (
              <span className="stp-muted" title="Without distance sensor readings the track rule doesn't count for or against the clip">
                not scored
              </span>
            )}
          </div>
          {session.track !== undefined && bar(policy.trackMin > 0 ? session.track / policy.trackMin : 1)}
        </div>
      )}
      {policy.rules.includes("exposure") && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Exposure</span>
            <span className="stp-mono">
              {Math.floor(exposureMin)} min{policy.minMinutes ? <span className="stp-muted"> / {policy.minMinutes} min</span> : null}
            </span>
          </div>
          {policy.minMinutes ? bar(exposureMin / policy.minMinutes) : null}
        </div>
      )}
      <div className="stp-small stp-mono stp-muted">{policyLabel(policy)}</div>
    </div>
  );
}

/**
 * Attended intervals and marker dots as one thin strip above stash's
 * control bar (it drops to the bottom edge while the controls are hidden).
 * Not interactive: stash's own progress bar does the seeking.
 */
export function SlimTimeline(props: {
  session: SessionState;
  scene: SceneInput;
  videoTime: number;
  furthest: number;
  durationSec: number;
  showAttention: boolean;
}) {
  const { session, scene, durationSec } = props;
  const segments = props.showAttention
    ? timelineSegments(session.attended, durationSec, Math.max(props.furthest, props.videoTime))
    : [];
  const dots = timelineDots(scene.markers, session.prompts, session.spends, props.videoTime, durationSec);
  if (!props.showAttention && dots.length === 0) return null;
  const head = durationSec > 0 ? Math.min(100, (props.videoTime / durationSec) * 100) : 0;
  const label = props.showAttention
    ? `Attended ${formatPercent(session.attendedFraction)} of the clip, at ${formatDuration(props.videoTime)} of ${formatDuration(durationSec)}`
    : `At ${formatDuration(props.videoTime)} of ${formatDuration(durationSec)}`;
  return (
    <div className="stp-sp-timeline" role="img" aria-label={label}>
      <div className="stp-sp-track">
        {segments.map((s, i) => (
          <div key={i} className={`stp-track-seg is-${s.kind}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} />
        ))}
        <div className="stp-playhead" style={{ left: `${head}%` }} />
      </div>
      {dots.map((d) => (
        <div key={d.markerId} className={`stp-tl-dot is-${d.kind} is-${d.state}`} style={{ left: `${d.left}%` }} title={`${d.title} · ${d.state}`} />
      ))}
    </div>
  );
}

/** True for `ms` after `value` last increased. */
export function useRecentChange(value: number, ms: number): boolean {
  const [until, setUntil] = React.useState(0);
  const prev = React.useRef(value);
  React.useEffect(() => {
    if (value > prev.current) setUntil(Date.now() + ms);
    prev.current = value;
  }, [value, ms]);
  React.useEffect(() => {
    if (until === 0) return;
    const id = window.setTimeout(() => setUntil(0), Math.max(0, until - Date.now()));
    return () => window.clearTimeout(id);
  }, [until]);
  return until > 0;
}
