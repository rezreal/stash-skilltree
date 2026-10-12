// The microphone gate, shown by the session controller before a clip with
// repeat prompts starts (after the camera gate): asks for the microphone
// from a click (or right away when the site already has mic permission),
// explains failures by error code and calls onReady once the browser granted
// it. The test stream is closed at once; usePromptChecks opens the mic again
// around each repeat window, which no longer prompts.
//
// There is no "continue without": a missing mic would quietly drop the
// clip's repeat prompts. Switching speech recognition off in the plugin
// settings is the way to watch without one (the error hints say so).
import { micErrorHelp } from "./gate.ts";
import type { PermissionGuess } from "./CameraGate.tsx";
import { PerceptionError } from "../perception/errors.ts";
import { getMedia, stopStream } from "../perception/webcam.ts";

/** Microphone permission without prompting (Permissions API; may be "unknown"). */
export function useMicPermission(): PermissionGuess {
  const [state, setState] = React.useState<PermissionGuess>("unknown");
  React.useEffect(() => {
    let alive = true;
    const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!perms?.query) return;
    perms
      .query({ name: "microphone" as PermissionName })
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

type MicGateState = { phase: "ask" } | { phase: "starting" } | { phase: "ready" } | { phase: "error"; error: PerceptionError };

export function MicGate(props: { onReady: () => void; className?: string }) {
  const permission = useMicPermission();
  const [state, setState] = React.useState<MicGateState>({ phase: "ask" });
  const alive = React.useRef(true);
  const onReadyRef = React.useRef(props.onReady);
  onReadyRef.current = props.onReady;

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const request = React.useCallback(() => {
    setState({ phase: "starting" });
    getMedia({ audio: true, video: false }, "microphone").then(
      (stream) => {
        stopStream(stream);
        if (alive.current) setState({ phase: "ready" });
      },
      (err: unknown) => {
        const error = err instanceof PerceptionError ? err : new PerceptionError("unknown", String(err), err);
        if (alive.current) setState({ phase: "error", error });
      },
    );
  }, []);

  // already allowed for this site: no need for the click
  React.useEffect(() => {
    if (permission === "granted" && state.phase === "ask") request();
  }, [permission, state.phase, request]);

  React.useEffect(() => {
    if (state.phase === "ready") onReadyRef.current();
  }, [state.phase]);

  const help = state.phase === "error" ? micErrorHelp(state.error.code, state.error.message) : undefined;

  return (
    <div className={`stc-gate${props.className ? ` ${props.className}` : ""}`} role="dialog" aria-label="Microphone check">
      <h2 className="stc-gate-title">{help ? help.title : "This clip asks you to repeat phrases out loud"}</h2>

      {state.phase === "ask" && (
        <>
          <p className="stc-gate-text">
            Skilltree listens while a phrase is due and checks that you said it. Speech is recognised in this
            browser and never leaves it. The microphone is only on around each phrase. Headphones help: the clip's
            own voice can drown yours out.
          </p>
          <div className="stc-gate-actions">
            <button type="button" className="stp-btn stp-btn-orange" onClick={request}>
              Turn on microphone
            </button>
          </div>
        </>
      )}

      {state.phase === "starting" && (
        <p className="stc-gate-text" role="status">
          <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
          Starting the microphone… allow it if the browser asks.
        </p>
      )}

      {state.phase === "ready" && (
        <p className="stc-gate-text" role="status">
          Microphone ready. Starting…
        </p>
      )}

      {state.phase === "error" && help && (
        <>
          <p className="stc-gate-text">{help.hint}</p>
          {state.error.code === "unknown" && <p className="stc-gate-text stp-muted">{state.error.message}</p>}
          {help.retry && (
            <div className="stc-gate-actions">
              <button type="button" className="stp-btn stp-btn-orange" onClick={request}>
                Try again
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
