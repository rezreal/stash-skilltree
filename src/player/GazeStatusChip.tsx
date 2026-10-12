// The eye tracker chip in the choice screen header. Connected: opens the
// calibration. Otherwise: a small popover with what to do, and a Connect
// button (its click is the user gesture the first WebUSB pairing needs).
import { router } from "./api.ts";
import { CALIBRATE_ROUTE } from "./common.tsx";
import { gazeChipView } from "./gazeView.ts";
import { useGaze } from "./useGaze.ts";

export function GazeStatusChip() {
  const { Link } = router();
  const gaze = useGaze();
  const view = gazeChipView(gaze.settings, gaze.status, gaze.calibrated);
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dot = <span className="stp-dot" aria-hidden="true" />;
  if (view.action === "calibrate") {
    return (
      <Link to={CALIBRATE_ROUTE} className={`stp-sensor-chip stp-tone-${view.tone}`} title="Calibrate the eye tracker">
        {dot}
        {view.label}
      </Link>
    );
  }
  return (
    <div className="stp-sensor-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`stp-sensor-chip stp-tone-${view.tone}`}
        aria-expanded={open}
        aria-controls="stp-sensor-pop"
        onClick={() => setOpen((o) => !o)}
      >
        {dot}
        {view.label}
      </button>
      {open && (
        <div id="stp-sensor-pop" className="stp-sensor-pop" role="dialog" aria-label="Eye tracker">
          <p className="stp-small stp-lh">{view.hint}</p>
          {gaze.status?.message && gaze.status.connection !== "connected" && !view.hint?.includes(gaze.status.message) && (
            <p className="stp-small stp-muted">{gaze.status.message}</p>
          )}
          {view.canConnect && (
            <button type="button" className="stp-btn stp-btn-orange stp-btn-sm" onClick={gaze.connect}>
              Connect eye tracker
            </button>
          )}
        </div>
      )}
    </div>
  );
}
