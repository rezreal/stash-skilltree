// /skilltree/stroke-camera: sets up the webcam for stroking / hands_off
// prompts, as a three-step wizard like the distance sensor's:
// 1. Framing: a mirrored preview with the shoulders, hips and wrists marked,
//    and what's missing for the camera to see the lap (strokeFraming);
// 2. Record: 5 s of stroking at the usual pace, then 3 s of rest, turned into
//    a calibration (calibrateStroke) or the reason it didn't work;
// 3. Check: the live verdict with that calibration ("Stroking · 84 per
//    minute"), then Save.
// The calibration is kept in this browser (camera angle and room are per
// device). The camera is the shared one (useViewerPresence), started by the
// viewer's click and analysed at the action rate while the page is open;
// frames never leave the browser.
import { useViewerPresence } from "../checks/useViewerPresence.ts";
import { VIEWER_RATE } from "../perception/viewer.ts";
import {
  calibrateStroke,
  createStrokeTracker,
  strokeFraming,
  type PoseSample,
  type StrokeCalibration,
  type StrokeTracker,
} from "../prompts/stroke.ts";
import { POSE, type NormPoint, type ViewerFrame } from "../prompts/types.ts";
import { router } from "./api.ts";
import { PLAY_ROUTE } from "./common.tsx";
import { loadStrokeCalibration, saveStrokeCalibration } from "./storage.ts";
import { useTicker } from "./useTrack.ts";

const STROKE_MS = 5000;
const REST_MS = 3000;

type Step = "framing" | "record" | "check";
type Recording = { phase: "stroke" | "rest"; start: number };

const MARKS: [keyof typeof POSE, string][] = [
  ["leftShoulder", "shoulder"],
  ["rightShoulder", "shoulder"],
  ["leftHip", "hip"],
  ["rightHip", "hip"],
  ["leftWrist", "wrist"],
  ["rightWrist", "wrist"],
];

function describe(cal: StrokeCalibration): string {
  const when = cal.savedAt ? new Date(cal.savedAt).toLocaleDateString() : "";
  return `${cal.hand === "left" ? "Left" : "Right"} hand (as the camera sees it) · ${Math.round(cal.rateHz * 60)} strokes per minute${when ? ` · saved ${when}` : ""}`;
}

export function StrokeCameraScreen() {
  const { Link } = router();
  const [camOn, setCamOn] = React.useState(false);
  const viewer = useViewerPresence({ enabled: camOn });
  const on = viewer.state === "on";
  const [saved, setSaved] = React.useState<StrokeCalibration | undefined>(() => loadStrokeCalibration());
  const [step, setStep] = React.useState<Step>("framing");
  const [recording, setRecording] = React.useState<Recording | undefined>(undefined);
  const [problem, setProblem] = React.useState<string | undefined>(undefined);
  const [candidate, setCandidate] = React.useState<StrokeCalibration | undefined>(undefined);
  const [note, setNote] = React.useState<string | undefined>(undefined);
  const latest = React.useRef<ViewerFrame | undefined>(undefined);
  const buffers = React.useRef<{ stroke: PoseSample[]; rest: PoseSample[] }>({ stroke: [], rest: [] });
  const recordingRef = React.useRef(recording);
  recordingRef.current = recording;
  const checkRef = React.useRef<{ tracker: StrokeTracker; state: string; t: number } | undefined>(undefined);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  useTicker(on, 150);

  // analyse fast while the page is open; the shared camera goes back to idle after
  React.useEffect(() => {
    if (!on) return;
    viewer.setRate(VIEWER_RATE.action);
    const off = viewer.subscribe((f) => {
      latest.current = f;
      const rec = recordingRef.current;
      if (rec) buffers.current[rec.phase].push({ t: f.t, ...(f.pose ? { pose: f.pose } : {}), ...(f.aspect ? { aspect: f.aspect } : {}) });
      const chk = checkRef.current;
      if (chk) {
        chk.state = chk.tracker.push(f.t, f.pose, f.aspect);
        chk.t = f.t;
      }
    });
    return () => {
      off();
      viewer.setRate(VIEWER_RATE.idle);
    };
  }, [on, viewer]);

  React.useEffect(() => {
    const el = videoRef.current;
    const stream = on ? viewer.stream() : null;
    if (!el || !stream) return;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [on, viewer]);

  // the recording: stroke, then rest, then the calibration
  React.useEffect(() => {
    if (!recording) return;
    const timer = window.setTimeout(
      () => {
        if (recording.phase === "stroke") {
          setRecording({ phase: "rest", start: performance.now() });
          return;
        }
        setRecording(undefined);
        const r = calibrateStroke(buffers.current.stroke, buffers.current.rest, new Date().toISOString());
        if (r.ok) {
          setCandidate(r.calibration);
          checkRef.current = { tracker: createStrokeTracker(r.calibration), state: "unknown", t: 0 };
          setStep("check");
        } else setProblem(r.problem);
      },
      recording.phase === "stroke" ? STROKE_MS : REST_MS,
    );
    return () => window.clearTimeout(timer);
  }, [recording]);

  const record = () => {
    setProblem(undefined);
    buffers.current = { stroke: [], rest: [] };
    setRecording({ phase: "stroke", start: performance.now() });
  };
  const save = () => {
    if (!candidate) return;
    const ok = saveStrokeCalibration(candidate);
    setSaved(candidate);
    setNote(ok ? "Saved. Stroke prompts in clips use it from the next clip on." : "Couldn't save: this browser blocks storage for the site.");
  };
  const remove = () => {
    saveStrokeCalibration(undefined);
    setSaved(undefined);
    setNote("Removed. Stroke prompts now watch both hands around your hips.");
  };

  const frame = latest.current;
  const framing = strokeFraming(frame?.pose, frame?.aspect);
  const aspect = frame?.aspect ?? 4 / 3;
  const left = recording ? Math.max(0, (recording.start + (recording.phase === "stroke" ? STROKE_MS : REST_MS) - performance.now()) / 1000) : 0;
  const chk = checkRef.current;
  const rate = chk ? chk.tracker.ratePerMin(chk.t) : undefined;

  return (
    <div className="skilltree-play">
      <div className="stp-sensor-page">
        <div className="stp-calib-head">
          <h1 className="stp-h1">Stroke camera</h1>
          <Link to={PLAY_ROUTE} className="stp-small stp-orange">
            Back to choices
          </Link>
        </div>
        <p className="stp-soft stp-lh">
          Stroke and hands-off prompts watch your hand at your lap through the webcam. Set the camera up once so it sees your
          shoulders, lap and hands, then show it your stroke. The calibration stays in this browser, and the camera images are
          analysed here and never leave it.
        </p>
        <p className="stp-small">
          {saved ? (
            <>
              <span className="stp-blue">Calibrated:</span> {describe(saved)}{" "}
              <button type="button" className="stp-link-btn" onClick={remove}>
                Remove
              </button>
            </>
          ) : (
            <span className="stp-muted">
              Not calibrated yet. Without a calibration, stroke prompts watch both hands around your hips with default sizes.
            </span>
          )}
        </p>
        {note && (
          <p className="stp-small stp-muted" role="status">
            {note}
          </p>
        )}

        {!camOn || viewer.state === "off" ? (
          <div>
            <button type="button" className="stp-btn stp-btn-orange" onClick={() => setCamOn(true)}>
              Turn on the camera
            </button>
          </div>
        ) : viewer.state === "error" ? (
          <div className="stp-col">
            <p className="stp-orange">{viewer.error?.message ?? "The camera didn't start."}</p>
            <div>
              <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={viewer.retry}>
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="stp-stroke-layout">
            <div className="stp-stroke-view" style={{ aspectRatio: String(aspect) }}>
              <video ref={videoRef} muted playsInline autoPlay aria-label="Your camera" />
              <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                {frame?.pose && <Marks pose={frame.pose} />}
              </svg>
              {recording && (
                <span className="stp-stroke-badge stp-mono">
                  {recording.phase === "stroke" ? "Stroke" : "Rest"} {Math.ceil(left)}
                </span>
              )}
            </div>

            <div className="stp-stroke-steps">
              {!on && <p className="stp-muted">Starting the camera…</p>}
              {on && step === "framing" && (
                <>
                  <h2 className="stp-caps">1 · Framing</h2>
                  <p className="stp-lh">Sit as you will while watching. The camera needs to see your shoulders, your lap and your hands.</p>
                  <p className={framing.ok ? "stp-blue" : "stp-orange"} role="status">
                    {framing.ok ? "Good, the camera sees what it needs." : framing.hint}
                  </p>
                  <div>
                    <button type="button" className="stp-btn stp-btn-orange stp-btn-sm" disabled={!framing.ok} onClick={() => setStep("record")}>
                      Next
                    </button>
                  </div>
                </>
              )}
              {on && step === "record" && (
                <>
                  <h2 className="stp-caps">2 · Show your stroke</h2>
                  <p className="stp-lh">
                    Press Start and stroke at your usual pace for 5 seconds. Then rest your hand without stroking for 3 seconds.
                  </p>
                  {recording ? (
                    <p className="stp-orange" role="status">
                      {recording.phase === "stroke" ? `Stroke… ${Math.ceil(left)} s` : `Now rest… ${Math.ceil(left)} s`}
                    </p>
                  ) : (
                    <>
                      {problem && <p className="stp-orange">{problem}</p>}
                      {!framing.ok && <p className="stp-small stp-orange">{framing.hint}</p>}
                      <div className="stp-row-gap">
                        <button type="button" className="stp-btn stp-btn-orange stp-btn-sm" onClick={record}>
                          {problem ? "Try again" : "Start"}
                        </button>
                        <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={() => setStep("framing")}>
                          Back
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              {on && step === "check" && candidate && (
                <>
                  <h2 className="stp-caps">3 · Check</h2>
                  <p className="stp-lh">Stroke, pause and stroke again: the line below should follow you.</p>
                  <p className={chk?.state === "in" ? "stp-blue" : chk?.state === "out" ? "stp-soft" : "stp-orange"} role="status">
                    {chk?.state === "in"
                      ? `Stroking${rate !== undefined ? ` · ${Math.round(rate)} per minute` : ""}`
                      : chk?.state === "out"
                        ? "Not stroking"
                        : (chk?.tracker.hint ?? "Can't see your hand")}
                  </p>
                  <p className="stp-small stp-muted">{describe({ ...candidate, savedAt: "" })}</p>
                  <div className="stp-row-gap">
                    <button type="button" className="stp-btn stp-btn-orange stp-btn-sm" onClick={save}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="stp-btn stp-btn-outline stp-btn-sm"
                      onClick={() => {
                        checkRef.current = undefined;
                        setCandidate(undefined);
                        setStep("record");
                      }}
                    >
                      Record again
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** shoulders, hips and wrists as dots, shoulder and hip lines (normalized frame coordinates) */
function Marks(props: { pose: readonly NormPoint[] }) {
  const { pose } = props;
  const seen = (k: keyof typeof POSE) => {
    const p = pose[POSE[k]];
    return p && (p.visibility === undefined || p.visibility >= 0.3) ? p : undefined;
  };
  const line = (a: keyof typeof POSE, b: keyof typeof POSE) => {
    const p = seen(a);
    const q = seen(b);
    return p && q ? <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} className="stp-stroke-line" /> : null;
  };
  return (
    <>
      {line("leftShoulder", "rightShoulder")}
      {line("leftHip", "rightHip")}
      {MARKS.map(([k, kind]) => {
        const p = seen(k);
        return p ? <circle key={k} cx={p.x} cy={p.y} r={0.012} className={`stp-stroke-dot is-${kind}`} /> : null;
      })}
    </>
  );
}
