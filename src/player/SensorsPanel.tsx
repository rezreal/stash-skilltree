// The sensors panel of the player: which signal decides attention, and the
// eye tracker's connection, rate, presence and last verdict, with the
// "Show gaze" toggle and links to connect and calibrate. Self-contained
// (reads the shared gaze source itself), so it can sit next to any player.
import { router } from "./api.ts";
import { CALIBRATE_ROUTE } from "./common.tsx";
import { attentionSourceLabel, gazeChipView, gazeSensorView, type AttentionReading } from "./gazeView.ts";
import { measuredRate, useGaze, useShowGaze } from "./useGaze.ts";

export function SensorsPanel(props: {
  reading: AttentionReading;
  /** snap flashes in the clip (funscript snap axis), shown when > 0 */
  snapFlashes?: number;
}) {
  const { Link } = router();
  const { reading } = props;
  const gaze = useGaze();
  const [showGaze, setShowGaze] = useShowGaze();
  const status = gaze.status;
  const connected = status?.connection === "connected";

  // the rate and presence move without status events
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!connected) return;
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, [connected]);

  const chip = gazeChipView(gaze.settings, status, gaze.calibrated);
  const view = status ? gazeSensorView(status, reading, connected ? measuredRate() : undefined) : undefined;

  return (
    <div className="stp-panel">
      <div className="stp-panel-head">
        <h2 className="stp-caps">Sensors</h2>
        {status && (
          <Link to={CALIBRATE_ROUTE} className="stp-small stp-orange">
            {gaze.calibrated ? "Calibrate" : "Calibrate now"}
          </Link>
        )}
      </div>
      <div className="stp-row">
        <span>{attentionSourceLabel(reading)}</span>
        <span className={reading.attending ? "stp-blue" : "stp-orange"}>{reading.attending ? "with you" : "away"}</span>
      </div>
      {!!props.snapFlashes && (
        <div className="stp-row stp-small stp-snap-count">
          <span className="stp-muted">Snap flashes</span>
          <span className="stp-mono">{props.snapFlashes} in this clip</span>
        </div>
      )}
      {status && view && (
        <div className="stp-col stp-gap-sm stp-sensor-block">
          <div className="stp-row">
            <span>{view.title}</span>
            <span className={`stp-tone-${view.connectionTone}`}>{view.connection}</span>
          </div>
          {connected && (
            <>
              <div className="stp-row stp-small">
                <span className="stp-muted">Rate</span>
                <span className="stp-mono">{view.rate}</span>
              </div>
              <div className="stp-row stp-small">
                <span className="stp-muted">Presence</span>
                <span>{view.presence}</span>
              </div>
              <div className="stp-row stp-small">
                <span className="stp-muted">Last verdict</span>
                <span>{view.reason}</span>
              </div>
              <label className="stp-toggle stp-small">
                <input type="checkbox" checked={showGaze} onChange={(e) => setShowGaze(e.currentTarget.checked)} />
                Show gaze
              </label>
            </>
          )}
          {!connected && chip.hint && <p className="stp-small stp-muted stp-lh stp-sensor-hint">{chip.hint}</p>}
          {chip.canConnect && (
            <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={gaze.connect}>
              Connect eye tracker
            </button>
          )}
        </div>
      )}
    </div>
  );
}
