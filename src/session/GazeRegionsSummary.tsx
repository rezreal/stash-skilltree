// The gaze region heatmap at the end of a session: this clip's shares as
// bars and each performer's running totals, saved (st.gaze_regions) through
// the session's writer once the session itself is saved (complete, or a
// loop's minutes). Test mode has no writer: the bars only.
import type { Id, PerformerInput } from "../core/types.ts";
import { worthSaving, type SavedRegions, type StoredRegions } from "../play/gazeRegions.ts";
import type { RegionSeconds } from "../prompts/regionHeatmap.ts";
import { countedText, performerRegionsLine, regionBars } from "../player/gazeRegionsView.ts";

export type PerformerRegionsState =
  | { status: "idle" }
  /** this session's seconds; nothing goes to the performers (test mode, too little gaze, no performers) */
  | { status: "kept"; session: RegionSeconds; test: boolean }
  | { status: "saving"; session: RegionSeconds }
  | { status: "saved"; session: RegionSeconds; totals: Map<Id, StoredRegions>; failed: Id[] };

/**
 * Adds the session's region seconds to the clip's performers once `ended`
 * turns true (saved, or a test preview). `seconds` is read at that moment.
 * `save` is the session writer's; undefined in test mode.
 */
export function usePerformerRegions(input: {
  ended: boolean;
  seconds: () => RegionSeconds;
  save: ((performerIds: readonly Id[], sec: RegionSeconds) => Promise<SavedRegions>) | undefined;
  performerIds: readonly Id[];
  /** refreshes the play data, so the start screen shows the new totals */
  reload: () => Promise<void>;
}): PerformerRegionsState {
  const [state, setState] = React.useState<PerformerRegionsState>({ status: "idle" });
  const done = React.useRef(false);
  const inputRef = React.useRef(input);
  inputRef.current = input;
  React.useEffect(() => {
    if (!input.ended || done.current) return;
    done.current = true;
    const { seconds, save, performerIds, reload } = inputRef.current;
    const session = seconds();
    if (!save || !worthSaving(session) || performerIds.length === 0) {
      setState({ status: "kept", session, test: !save });
      return;
    }
    setState({ status: "saving", session });
    // saveGazeRegions never rejects: performers that fail are listed
    void save(performerIds, session).then((r) => {
      setState({ status: "saved", session, totals: r.totals, failed: r.failed });
      if (r.totals.size > 0) void reload();
    });
  }, [input.ended]);
  return state;
}

export function GazeRegionsSummary(props: { state: PerformerRegionsState; performers: ReadonlyMap<Id, PerformerInput> }) {
  const { state } = props;
  if (state.status === "idle") return null;
  const bars = regionBars(state.session);
  if (bars.length === 0) return null;
  const name = (id: Id) => props.performers.get(id)?.name ?? `Performer ${id}`;
  return (
    <div className="stp-breakdown stp-regions" aria-label="Where you looked">
      <div className="stp-row">
        <span className="stp-soft">Where you looked</span>
        <span className="stp-small stp-muted">{countedText(state.session)}</span>
      </div>
      {bars.map((b) => (
        <div key={b.label} className="stp-region-row">
          <span className="stp-region-label">{b.label}</span>
          <span className="stp-region-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(1, Math.round(b.share * 100))}%` }} />
          </span>
          <span className="stp-mono stp-region-pct">{b.text}</span>
        </div>
      ))}
      {state.status === "kept" && state.test && <span className="stp-small stp-muted">Test: not added to the performers.</span>}
      {state.status === "saving" && <span className="stp-small stp-muted">Adding to the performers…</span>}
      {state.status === "saved" &&
        [...state.totals].map(([id, stored]) => (
          <span key={id} className="stp-small stp-soft stp-row-sep">
            {performerRegionsLine(name(id), stored)}
          </span>
        ))}
      {state.status === "saved" && state.failed.length > 0 && (
        <span className="stp-small stp-error">Not added to {state.failed.map(name).join(", ")}.</span>
      )}
    </div>
  );
}
