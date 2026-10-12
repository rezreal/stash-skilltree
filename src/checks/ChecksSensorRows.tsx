// Rows for the session's sensors panel: Camera (state, in view or not),
// Microphone (repeat prompts) and Video analysis (gaze targets on the clip).
// Uses the panel's own row classes (stp-row ...). Rows the clip doesn't use
// are left out unless `all`.
import { cameraRow, micRow, visionRow, type SensorRow } from "./gate.ts";
import type { ChecksStatus } from "./usePromptChecks.ts";
import type { ViewerPresence } from "./useViewerPresence.ts";

export function ChecksSensorRows(props: {
  viewer?: ViewerPresence;
  /** usePromptChecks().status */
  status?: ChecksStatus;
  /** show rows for sensors this clip doesn't use too (default false) */
  all?: boolean;
}) {
  const { viewer, status } = props;
  const cameraOn = viewer?.state === "on";
  // presence moves without state changes
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    if (!cameraOn) return;
    const id = window.setInterval(() => setN((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, [cameraOn]);

  const rows: SensorRow[] = [];
  if (viewer) rows.push(cameraRow(viewer.state, cameraOn ? viewer.present() : undefined, viewer.error));
  if (status && (props.all || status.speech.state !== "off")) rows.push(micRow(status.speech.state, status.speech.message));
  if (status && (props.all || status.vision.state !== "off")) rows.push(visionRow(status.vision.state, status.vision.message));
  if (rows.length === 0) return null;

  return (
    <div className="stp-col stp-gap-sm stp-sensor-block stc-sensor-rows">
      {rows.map((r) => (
        <React.Fragment key={r.key}>
          <div className="stp-row stp-small">
            <span className="stp-muted">{r.label}</span>
            <span className={`stp-tone-${r.tone}`}>{r.value}</span>
          </div>
          {r.hint && <p className="stp-small stp-muted stp-lh stp-sensor-hint">{r.hint}</p>}
        </React.Fragment>
      ))}
    </div>
  );
}
