// The viewer's webcam for React: one shared camera session (module state,
// see camera.ts) started while any component has `enabled`, stopped
// (camera light off) about a second after the last one disables or
// unmounts. Presence runs on every frame (createPresenceMonitor).
import type { PerceptionError } from "../perception/errors.ts";
import { startViewer, VIEWER_RATE } from "../perception/viewer.ts";
import type { ViewerFrame } from "../prompts/types.ts";
import type { PresenceInfo } from "./attention.ts";
import { createCameraManager, type CameraManager, type CameraState } from "./camera.ts";

export interface ViewerPresence {
  state: CameraState;
  /** why the camera failed (code + message), with state "error" */
  error?: PerceptionError;
  /** presence now; nowMs in the performance.now() timebase (the default) */
  present(nowMs?: number): PresenceInfo;
  /** the most recent analysed frame */
  latest(): ViewerFrame | null;
  /** the camera stream (for a preview), null unless on */
  stream(): MediaStream | null;
  /** analysis rate in Hz (VIEWER_RATE.idle / .action) */
  setRate(hz: number): void;
  /** every analysed frame; returns an unsubscribe */
  subscribe(cb: (f: ViewerFrame) => void): () => void;
  /** starts again after an error */
  retry(): void;
}

let manager: CameraManager | undefined;

/** The shared camera (created on first use). */
export function cameraManager(): CameraManager {
  if (!manager) {
    const m = createCameraManager({
      start: ({ rateHz }) => startViewer({ rateHz }),
      rateHz: VIEWER_RATE.idle,
    });
    manager = m;
    // leaving the page (tab close, navigation away from stash): camera off now
    if (typeof window !== "undefined") window.addEventListener("pagehide", () => m.stopNow());
  }
  return manager;
}

export function useViewerPresence(opts: { enabled: boolean }): ViewerPresence {
  const m = cameraManager();
  const [snap, setSnap] = React.useState(() => m.snapshot());

  React.useEffect(() => {
    const sync = () => setSnap(m.snapshot());
    const off = m.onChange(sync);
    sync(); // it may have changed before this subscribed
    return off;
  }, [m]);

  React.useEffect(() => {
    if (!opts.enabled) return;
    return m.acquire();
  }, [m, opts.enabled]);

  return React.useMemo<ViewerPresence>(() => {
    const v: ViewerPresence = {
      state: snap.state,
      present: (nowMs?: number) => m.present(nowMs),
      latest: () => m.latest(),
      stream: () => m.stream(),
      setRate: (hz: number) => m.setRate(hz),
      subscribe: (cb: (f: ViewerFrame) => void) => m.subscribe(cb),
      retry: () => m.retry(),
    };
    if (snap.error) v.error = snap.error;
    return v;
  }, [m, snap]);
}
