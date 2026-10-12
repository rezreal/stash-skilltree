// The camera gate, shown by the session controller before a session starts
// when the webcam is required: asks for the camera from a click (or starts
// it right away when the site already has camera permission), shows a small
// live preview with a presence indicator, explains failures by error code,
// and calls onReady once the camera runs and a person is in view.
//
// Not required and no camera (denied, none found, insecure page): onReady
// with camera false and a note. The running camera is handed over to the
// session's useViewerPresence (the shared session lingers ~1 s on unmount).
import { checksSettings } from "./settings.ts";
import { cameraErrorHelp, createSteadyPresence, gatePhase } from "./gate.ts";
import { useViewerPresence } from "./useViewerPresence.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";

export interface GateResult {
  /** the camera runs (presence is checked during the session) */
  camera: boolean;
  /** e.g. "camera off: no camera found" */
  note?: string;
}

const POLL_MS = 200;

export type PermissionGuess = "granted" | "denied" | "prompt" | "unknown";

/**
 * Camera permission without prompting (Permissions API; Firefox may not know
 * "camera": "unknown"). Also used by the session to start presence silently
 * when the webcam is not required but already allowed.
 */
export function useCameraPermission(): PermissionGuess {
  const [state, setState] = React.useState<PermissionGuess>("unknown");
  React.useEffect(() => {
    let alive = true;
    const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!perms?.query) return;
    perms
      .query({ name: "camera" as PermissionName })
      .then((p) => {
        if (alive) setState(p.state);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export function CameraGate(props: {
  onReady: (result: GateResult) => void;
  /** default: the webcamRequired setting */
  required?: boolean;
  className?: string;
}) {
  const settings = checksSettings(usePluginSettings());
  const required = props.required ?? settings.webcamRequired;
  const permission = useCameraPermission();
  const [requested, setRequested] = React.useState(false);
  const viewer = useViewerPresence({ enabled: requested });
  const [personSeen, setPersonSeen] = React.useState(false);
  const [inView, setInView] = React.useState(false);
  const steady = React.useRef(createSteadyPresence());
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const done = React.useRef(false);
  const onReadyRef = React.useRef(props.onReady);
  onReadyRef.current = props.onReady;

  // already allowed for this site: no need for the click
  React.useEffect(() => {
    if (permission === "granted") setRequested(true);
  }, [permission]);

  const on = viewer.state === "on";

  // the preview plays the same stream (a second element; tracks aren't touched)
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

  // presence indicator
  React.useEffect(() => {
    if (!on) {
      steady.current = createSteadyPresence();
      setInView(false);
      return;
    }
    const id = window.setInterval(() => {
      const f = viewer.latest();
      const present = !!f?.personPresent;
      setInView(present);
      if (steady.current(present, performance.now())) setPersonSeen(true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [on, viewer]);

  const deniedUpfront = !required && permission === "denied" && !requested;
  const phase = deniedUpfront
    ? "skip"
    : gatePhase({ required, requested, state: viewer.state, errorCode: viewer.error?.code, personSeen });
  const help = viewer.error ? cameraErrorHelp(viewer.error.code, viewer.error.message) : undefined;

  React.useEffect(() => {
    if (done.current) return;
    if (phase === "ready") {
      done.current = true;
      onReadyRef.current({ camera: true });
    } else if (phase === "skip") {
      done.current = true;
      const why = help ? help.title.toLowerCase() : "camera access is blocked";
      onReadyRef.current({ camera: false, note: `camera off: ${why}` });
    }
  }, [phase, help]);

  const turnOn = () => {
    if (requested) viewer.retry();
    else setRequested(true);
  };
  const skip = () => {
    if (done.current) return;
    done.current = true;
    setRequested(false);
    onReadyRef.current({ camera: false, note: "camera off" });
  };

  return (
    <div className={`stc-gate${props.className ? ` ${props.className}` : ""}`} role="dialog" aria-label="Camera check">
      <h2 className="stc-gate-title">{phase === "error" && help ? help.title : "This session uses your camera"}</h2>

      {phase === "ask" && (
        <>
          <p className="stc-gate-text">
            Skilltree checks that you're in front of the screen, and the actions some clips ask for. The pictures are
            analysed in this browser and never leave it. The camera turns off when the session ends.
          </p>
          <div className="stc-gate-actions">
            <button type="button" className="stp-btn stp-btn-orange" onClick={turnOn}>
              Turn on camera
            </button>
            {!required && (
              <button type="button" className="stp-btn stp-btn-outline" onClick={skip}>
                Continue without camera
              </button>
            )}
          </div>
        </>
      )}

      {phase === "starting" && (
        <p className="stc-gate-text" role="status">
          <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
          Starting the camera… allow it if the browser asks.
        </p>
      )}

      {(phase === "looking" || phase === "ready") && (
        <div className="stc-gate-live">
          <div className={`stc-gate-preview${inView ? " is-present" : ""}`}>
            <video ref={videoRef} muted playsInline autoPlay aria-label="Camera preview" />
          </div>
          <p className={`stc-gate-presence ${inView ? "is-present" : "is-absent"}`} role="status">
            <span className="stc-dot" aria-hidden="true" />
            {phase === "ready" ? "You're in view. Starting…" : inView ? "You're in view…" : "Move into view of the camera"}
          </p>
        </div>
      )}

      {phase === "error" && help && (
        <>
          <p className="stc-gate-text">{help.hint}</p>
          {viewer.error?.code === "unknown" && <p className="stc-gate-text stp-muted">{viewer.error.message}</p>}
          <div className="stc-gate-actions">
            {help.retry && (
              <button type="button" className="stp-btn stp-btn-orange" onClick={turnOn}>
                Try again
              </button>
            )}
            {!required && (
              <button type="button" className="stp-btn stp-btn-outline" onClick={skip}>
                Continue without camera
              </button>
            )}
          </div>
        </>
      )}

      {phase === "skip" && <p className="stc-gate-text">Continuing without the camera.</p>}
    </div>
  );
}
