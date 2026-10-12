// The viewer's own camera as a small picture-in-picture over the clip, so
// they can see whether they do what a prompt asks and stay in frame. Opt-in
// ("Show my camera" in the sensors panel, remembered in this browser). Plays
// the session's running camera stream in a second, mirrored element (the
// tracks aren't touched); the border turns blue while a person is in view.
// Nothing is shown while the camera isn't on.
import { OverlayInteractive } from "../stashplayer/OverlayHost.tsx";
import type { ViewerPresence } from "../checks/useViewerPresence.ts";

const POLL_MS = 250;

export function CameraPip(props: { viewer: ViewerPresence; onHide: () => void }) {
  const { viewer } = props;
  const on = viewer.state === "on";
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [inView, setInView] = React.useState(false);

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

  React.useEffect(() => {
    if (!on) return;
    const tick = () => setInView(viewer.present().present);
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [on, viewer]);

  if (!on) return null;
  return (
    <OverlayInteractive className={`stp-sp-cam${inView ? " is-present" : ""}`}>
      <video ref={videoRef} muted playsInline autoPlay aria-label="Your camera" />
      <button type="button" className="stp-sp-close" onClick={props.onHide} aria-label="Hide my camera" title="Hide my camera">
        ×
      </button>
    </OverlayInteractive>
  );
}
