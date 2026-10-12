// /skilltree/calibrate: gaze calibration. Fullscreen (from the Start click),
// then one dot at a time. With a Tobii tracker the tracker first calibrates
// itself on the points (its blob is stored by the source and re-applied on
// every connect); then the page records the mapped gaze per point, fits the
// affine correction on top, shows the error and offers a check on random
// points before saving. Works with the mouse source too (point at the dots).
import type { Calibration, ViewportPoint } from "../gaze/types.ts";
import { IDENTITY_CALIBRATION } from "../gaze/types.ts";
import { applyCalibration, calibrationPoints, readWindowGeometry } from "../gaze/index.ts";
import { router } from "./api.ts";
import {
  DISCARD_MS,
  INITIAL_CALIBRATION_STATE,
  POINT_MS,
  calibrationStep,
  currentTarget,
  errorText,
  errorVerdict,
  progressLabel,
  verifyDone,
  verifyError,
  verifyTargets,
  type CalibrationEvent,
  type CalibrationState,
  type TimedPoint,
} from "./calibrationFlow.ts";
import { PLAY_ROUTE, errorText as messageOf } from "./common.tsx";
import { dateLabel } from "./format.ts";
import { deviceTarget, distancePx, monitorSize } from "./gazeGeometry.ts";
import { gazeChipView, sourceTitle } from "./gazeView.ts";
import { useGaze } from "./useGaze.ts";

const TICK_MS = 50;

const reducer = (s: CalibrationState, e: CalibrationEvent) => calibrationStep(s, e);

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : window.requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

function isRecording(s: CalibrationState): boolean {
  return s.step === "device" || s.step === "point" || (s.step === "verify" && !verifyDone(s));
}

export function CalibrationScreen() {
  const { Link } = router();
  const gaze = useGaze();
  const [state, dispatch] = React.useReducer(reducer, INITIAL_CALIBRATION_STATE);
  const [useDevice, setUseDevice] = React.useState(true);
  const [saveNote, setSaveNote] = React.useState<string | undefined>(undefined);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const buffer = React.useRef<TimedPoint[]>([]);
  const ownFullscreen = React.useRef(false);
  const recording = isRecording(state);
  const recordingRef = React.useRef(recording);
  recordingRef.current = recording;

  const status = gaze.status;
  const connected = status?.connection === "connected";
  const deviceCal = status?.kind === "tobii" ? gaze.source?.deviceCalibration : undefined;

  // uncalibrated viewport samples while a dot is shown; the reducer keeps those of the current point
  React.useEffect(() => {
    buffer.current = [];
    if (!recording) return;
    return gaze.subscribe((s) => {
      if (s.raw) buffer.current.push({ t: s.t, x: s.raw.x, y: s.raw.y });
    });
  }, [recording, gaze.subscribe]);

  React.useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      dispatch({ type: "tick", nowMs: performance.now(), nowIso: new Date().toISOString(), samples: buffer.current.splice(0) });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [recording]);

  // --- the tracker's own calibration (Tobii) ---
  const deviceStage = state.step === "device" ? `${state.stage}:${state.index}` : "";
  React.useEffect(() => {
    if (state.step !== "device") return;
    if (!deviceCal) {
      dispatch({ type: "deviceFailed", message: "the tracker is not connected" });
      return;
    }
    let cancelled = false;
    const fail = (err: unknown) => {
      if (!cancelled) dispatch({ type: "deviceFailed", message: messageOf(err) });
    };
    if (state.stage === "starting") {
      deviceCal.start().then(() => {
        if (!cancelled) dispatch({ type: "deviceReady", nowMs: performance.now() });
      }, fail);
    } else if (state.stage === "point") {
      const index = state.index;
      const target = state.targets[index];
      // give the eyes the same head start as the page's own recording
      const timer = window.setTimeout(() => {
        const geo = readWindowGeometry();
        const monitor = monitorSize(status?.screen, window.screen, geo.devicePixelRatio);
        const norm = deviceTarget(target, geo, monitor, status?.screen);
        deviceCal.addPoint(norm.x, norm.y).then(() => {
          if (!cancelled) dispatch({ type: "deviceAdded", index });
        }, fail);
      }, DISCARD_MS);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    } else {
      // finish() also stores the blob (storeDeviceCalibration) for the next connect
      deviceCal.finish().then(() => {
        if (!cancelled) dispatch({ type: "deviceFinished", nowMs: performance.now() });
      }, fail);
    }
    return () => {
      cancelled = true;
    };
  }, [deviceStage]);

  // --- fullscreen ---
  const exitOwnFullscreen = React.useCallback(() => {
    if (document.fullscreenElement && document.fullscreenElement === rootRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    }
    ownFullscreen.current = false;
  }, []);

  React.useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement || !ownFullscreen.current) return;
      ownFullscreen.current = false;
      // the geometry changed under the dots: the measurement is void
      if (recordingRef.current) dispatch({ type: "cancel", message: "Fullscreen was left, so the calibration stopped." });
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  React.useEffect(() => exitOwnFullscreen, [exitOwnFullscreen]);
  React.useEffect(() => {
    if (state.step === "intro" || state.step === "saved" || state.step === "failed") exitOwnFullscreen();
  }, [state.step, exitOwnFullscreen]);

  // Esc stops a running measurement (in fullscreen the browser exits first, which stops it too)
  React.useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "cancel", message: "Stopped." });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  // the tracker went away mid-measurement
  React.useEffect(() => {
    if (recordingRef.current && !connected) dispatch({ type: "cancel", message: "The eye tracker disconnected." });
  }, [connected]);

  const begin = async () => {
    setSaveNote(undefined);
    const el = rootRef.current;
    if (el && !document.fullscreenElement && el.requestFullscreen) {
      try {
        await el.requestFullscreen();
        ownFullscreen.current = true;
      } catch {
        // no fullscreen (iframe, refused): calibrate the window as it is
      }
    }
    await nextFrames(2); // let the fullscreen geometry settle
    dispatch({
      type: "start",
      targets: calibrationPoints(window.innerWidth, window.innerHeight),
      nowMs: performance.now(),
      device: useDevice && deviceCal !== undefined,
    });
  };

  const verify = () =>
    dispatch({ type: "verify", targets: verifyTargets(window.innerWidth, window.innerHeight), nowMs: performance.now() });

  const save = (c: Calibration) => {
    const stored = gaze.setCalibration(c);
    setSaveNote(stored ? undefined : "The browser blocked storage: the calibration applies until the page is reloaded.");
    dispatch({ type: "saved", calibration: c });
  };
  const reset = () => {
    const stored = gaze.setCalibration(undefined);
    setSaveNote(stored ? undefined : "The browser blocked storage.");
    dispatch({ type: "saved", calibration: IDENTITY_CALIBRATION, device: false });
  };

  const target = currentTarget(state);
  const progress = progressLabel(state);
  const total = "targets" in state ? state.targets.length : 0;
  const done = "index" in state ? state.index : 0;

  return (
    <div className="skilltree-play stp-calib-page">
      <div
        ref={rootRef}
        className={`stp-calib${recording ? " is-recording" : ""}${status?.kind === "mouse" ? " is-mouse" : ""}`}
      >
        {target && (
          <div key={`${state.step}-${done}`} className="stp-calib-dot" style={{ left: target.x, top: target.y }} aria-hidden="true">
            <span className="stp-calib-ring" style={{ animationDuration: `${POINT_MS}ms` }} />
            <span className="stp-calib-core" />
          </div>
        )}
        {state.step === "device" && state.stage !== "point" && (
          <div className="stp-calib-wait" role="status">
            <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
            {state.stage === "starting" ? "Preparing the tracker…" : "The tracker is storing its calibration…"}
          </div>
        )}
        {recording && progress && (
          <div className="stp-calib-progress" role="status">
            <span className="stp-small stp-mono">{progress}</span>
            <div className="stp-bar" aria-hidden="true">
              <div style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
            </div>
            <span className="stp-small stp-muted">Look at the dot until it is gone · Esc stops</span>
          </div>
        )}

        {state.step === "fitted" && (
          <>
            <ResultPlot
              points={state.pairs.map((p) => ({ target: p.target, measured: applyCalibration(p.measured, state.calibration) }))}
            />
            <div className="stp-calib-card" role="dialog" aria-labelledby="stp-calib-title">
              <span className="stp-eyebrow">{state.device ? "Tracker calibrated · correction fitted" : "Calibration measured"}</span>
              <ErrorLine id="stp-calib-title" px={state.calibration.errorPx} label="Mean error" />
              <p className="stp-small stp-muted">
                {state.pairs.length} of {state.pairs.length + state.missed} points had a steady gaze. Rings are the targets,
                dots where your gaze landed after the correction.
              </p>
              <div className="stp-overlay-actions">
                <button type="button" className="stp-btn stp-btn-orange" onClick={verify}>
                  Check on new points
                </button>
                <button type="button" className="stp-btn stp-btn-outline" onClick={() => save(state.calibration)}>
                  Save
                </button>
                <button type="button" className="stp-btn stp-btn-outline" onClick={() => dispatch({ type: "retry" })}>
                  Retry
                </button>
              </div>
            </div>
          </>
        )}

        {state.step === "verify" && verifyDone(state) && (
          <>
            <ResultPlot points={state.results} />
            <div className="stp-calib-card" role="dialog" aria-labelledby="stp-calib-title">
              <span className="stp-eyebrow">Check</span>
              <ErrorLine id="stp-calib-title" px={verifyError(state.results)} label="Error on new points" />
              <p className="stp-small stp-muted">
                Fitted on the calibration points: {errorText(state.calibration.errorPx)}.{" "}
                {state.results.filter((r) => r.measured).length} of {state.results.length} check points had a steady gaze.
              </p>
              <div className="stp-overlay-actions">
                <button type="button" className="stp-btn stp-btn-orange" onClick={() => save(state.calibration)}>
                  Save
                </button>
                <button type="button" className="stp-btn stp-btn-outline" onClick={verify}>
                  Check again
                </button>
                <button type="button" className="stp-btn stp-btn-outline" onClick={() => dispatch({ type: "retry" })}>
                  Retry
                </button>
              </div>
            </div>
          </>
        )}

        {(state.step === "intro" || state.step === "failed" || state.step === "saved") && (
          <div className="stp-calib-card" role="region" aria-labelledby="stp-calib-title">
            <div className="stp-calib-head">
              <h1 id="stp-calib-title" className="stp-h2">
                Gaze calibration
              </h1>
              <Link to={PLAY_ROUTE} className="stp-small stp-orange">
                Back to choices
              </Link>
            </div>

            {state.step === "intro" && (
              <>
                {state.message && (
                  <p className="stp-small stp-orange" role="alert">
                    {state.message}
                  </p>
                )}
                <p className="stp-soft stp-lh">
                  The screen goes fullscreen and shows nine dots, one after the other. Keep your head still and look at each
                  dot until it shrinks away.
                  {deviceCal ? " The tracker calibrates itself first, then the dots run once more to fit a correction." : ""}
                </p>
                <SourceLine />
                {deviceCal && (
                  <label className="stp-toggle stp-small">
                    <input type="checkbox" checked={useDevice} onChange={(e) => setUseDevice(e.currentTarget.checked)} />
                    Calibrate the tracker itself too (recommended after moving it)
                  </label>
                )}
                <CurrentCalibration calibration={gaze.calibration} />
                <div className="stp-overlay-actions stp-calib-actions">
                  <button type="button" className="stp-btn stp-btn-orange" disabled={!connected} onClick={() => void begin()}>
                    Start
                  </button>
                  {gaze.calibrated && (
                    <button type="button" className="stp-btn stp-btn-outline" onClick={reset}>
                      Reset to no correction
                    </button>
                  )}
                </div>
              </>
            )}

            {state.step === "failed" && (
              <>
                <p className="stp-error" role="alert">
                  {state.message}
                </p>
                <div className="stp-overlay-actions stp-calib-actions">
                  <button type="button" className="stp-btn stp-btn-orange" onClick={() => dispatch({ type: "retry" })}>
                    Retry
                  </button>
                </div>
              </>
            )}

            {state.step === "saved" && (
              <>
                <p className="stp-soft stp-lh" role="status">
                  {state.calibration.points > 0
                    ? `Saved. Gaze is corrected by this calibration (${errorText(state.calibration.errorPx)} mean error) from now on.`
                    : "The correction is reset: gaze is mapped by the window geometry alone."}
                </p>
                {saveNote && <p className="stp-small stp-orange">{saveNote}</p>}
                <div className="stp-overlay-actions stp-calib-actions">
                  <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange">
                    Back to choices
                  </Link>
                  <button type="button" className="stp-btn stp-btn-outline" onClick={() => dispatch({ type: "retry" })}>
                    Calibrate again
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorLine(props: { id: string; px: number | undefined; label: string }) {
  const verdict = errorVerdict(props.px);
  return (
    <div className="stp-col">
      <span id={props.id} className="stp-summary-title">
        {props.label}: <span className="stp-mono">{errorText(props.px)}</span>
      </span>
      <span className={`stp-small stp-tone-${verdict.tone}`}>{verdict.text}</span>
    </div>
  );
}

/** the source and its state, with a connect button when it isn't connected */
function SourceLine() {
  const gaze = useGaze();
  const status = gaze.status;
  const chip = gazeChipView(gaze.settings, status, gaze.calibrated);
  if (!status) return <p className="stp-small stp-orange stp-lh">{chip.hint}</p>;
  const connected = status.connection === "connected";
  return (
    <div className="stp-col stp-gap-sm">
      <div className="stp-row">
        <span>{sourceTitle(status.kind)}</span>
        <span className={`stp-tone-${chip.tone}`}>{connected ? "connected" : status.connection}</span>
      </div>
      {!connected && chip.hint && <p className="stp-small stp-muted stp-lh">{chip.hint}</p>}
      {chip.canConnect && (
        <button type="button" className="stp-btn stp-btn-outline stp-btn-sm stp-self-start" onClick={gaze.connect}>
          Connect eye tracker
        </button>
      )}
    </div>
  );
}

function CurrentCalibration(props: { calibration: Calibration }) {
  const c = props.calibration;
  if (c.points === 0) return <p className="stp-small stp-muted">No correction saved yet.</p>;
  return (
    <p className="stp-small stp-muted">
      Saved correction: {c.points} points, {errorText(c.errorPx)} mean error
      {c.createdAt ? `, measured ${dateLabel(c.createdAt.slice(0, 10))}` : ""}.
    </p>
  );
}

/** targets (rings) and where the gaze landed (dots), joined by a line */
function ResultPlot(props: { points: { target: ViewportPoint; measured?: ViewportPoint }[] }) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return (
    <svg className="stp-calib-plot" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      {props.points.map((p, i) => (
        <g key={i}>
          <circle className="stp-calib-target" cx={p.target.x} cy={p.target.y} r={14} />
          {p.measured ? (
            <>
              <line className="stp-calib-miss" x1={p.target.x} y1={p.target.y} x2={p.measured.x} y2={p.measured.y} />
              <circle className="stp-calib-measured" cx={p.measured.x} cy={p.measured.y} r={5} />
              <text className="stp-calib-label" x={p.target.x + 18} y={p.target.y - 18}>
                {Math.round(distancePx(p.measured, p.target))} px
              </text>
            </>
          ) : (
            <text className="stp-calib-label" x={p.target.x + 18} y={p.target.y - 18}>
              no steady gaze
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
