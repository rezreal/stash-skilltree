// The gaze source of the play screens. One source lives for the plugin's
// lifetime (module state), so moving between the choice screen, the player
// and the calibration doesn't reconnect the tracker; it is replaced only when
// the gazeSource setting changes. Every sample is mapped to the viewport
// (window geometry read at sample time, then the stored calibration) and
// handed to subscribers, e.g. the attention classifier. Rendering reads the
// latest point at most once per animation frame (useGazePoint).
import type { Calibration, GazeSettings, GazeSource, GazeStatus } from "../gaze/types.ts";
import { IDENTITY_CALIBRATION } from "../gaze/types.ts";
import {
  createMouseSource,
  createTobiiSource,
  parseCalibration,
  readWindowGeometry,
  serializeCalibration,
  tobiiDevicePermitted,
} from "../gaze/index.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";
import { mapGazeSample, type MappedSample } from "./gazeGeometry.ts";
import { gazeSettings } from "./gazeView.ts";
import { loadCalibrationText, loadShowGaze, saveCalibrationText, saveShowGaze } from "./storage.ts";

export type { MappedSample };

interface Runtime {
  source: GazeSettings["source"];
  gaze?: GazeSource;
  status?: GazeStatus;
  stop: () => void;
}

let runtime: Runtime | undefined;
let calibration: Calibration | undefined;
let latest: MappedSample | undefined;
/** sample times of the last second, for a measured rate */
let recent: number[] = [];

const sampleListeners = new Set<(s: MappedSample) => void>();
/** status, source or calibration changed */
const changeListeners = new Set<() => void>();

function emitChange(): void {
  for (const cb of [...changeListeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[skilltree] gaze listener failed", err);
    }
  }
}

function emitSample(s: MappedSample): void {
  for (const cb of [...sampleListeners]) {
    try {
      cb(s);
    } catch (err) {
      console.error("[skilltree] gaze sample listener failed", err);
    }
  }
}

function start(kind: GazeSettings["source"]): Runtime | undefined {
  if (kind === "off") return undefined;
  if (kind === "webxr") {
    return {
      source: kind,
      status: { kind, connection: "error", message: "WebXR gaze isn't available yet." },
      stop: () => undefined,
    };
  }
  let gaze: GazeSource;
  try {
    gaze = kind === "tobii" ? createTobiiSource() : createMouseSource({});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: kind, status: { kind, connection: "error", message }, stop: () => undefined };
  }
  const rt: Runtime = { source: kind, gaze, status: gaze.status(), stop: () => undefined };
  const offStatus = gaze.onStatus((s) => {
    rt.status = s;
    if (s.connection !== "connected") latest = undefined;
    emitChange();
  });
  const offSample = gaze.onSample((s) => {
    recent.push(s.t);
    if (recent.length > 512) recent = recent.slice(-256);
    let mapped: MappedSample;
    try {
      mapped = mapGazeSample(s, readWindowGeometry(), currentCalibration(), rt.status?.screen);
    } catch {
      mapped = { t: s.t, valid: false };
    }
    latest = mapped;
    emitSample(mapped);
  });
  rt.stop = () => {
    offStatus();
    offSample();
    gaze.disconnect();
  };
  // WebUSB pairing needs a click (Connect button); a tracker paired on an
  // earlier visit is reconnected right away. The mouse needs no permission.
  if (kind === "mouse") {
    void gaze.connect().catch(() => undefined);
  } else {
    void tobiiDevicePermitted().then((ok) => {
      if (ok && runtime === rt && rt.status?.connection !== "connected") void gaze.connect().catch(() => undefined);
    });
  }
  return rt;
}

/** (re)creates the source when the setting changed; a no-op otherwise */
function configure(settings: GazeSettings): void {
  if ((runtime?.source ?? "off") === settings.source) return;
  runtime?.stop();
  latest = undefined;
  recent = [];
  runtime = start(settings.source);
  emitChange();
}

/** the stored calibration, identity when none (read once, then kept) */
export function currentCalibration(): Calibration {
  if (!calibration) {
    try {
      const text = loadCalibrationText();
      calibration = (text ? parseCalibration(text) : undefined) ?? IDENTITY_CALIBRATION;
    } catch {
      calibration = IDENTITY_CALIBRATION;
    }
  }
  return calibration;
}

/** stores the calibration (undefined = identity); false when it could not be stored */
export function setCalibration(c: Calibration | undefined): boolean {
  let stored: boolean;
  try {
    stored = saveCalibrationText(c ? serializeCalibration(c) : undefined);
  } catch {
    stored = false;
  }
  calibration = c ?? IDENTITY_CALIBRATION;
  emitChange();
  return stored;
}

export function gazeStatusNow(): GazeStatus | undefined {
  return runtime?.status;
}

export function gazeSourceNow(): GazeSource | undefined {
  return runtime?.gaze;
}

/** connects the source; call it from a click (the first WebUSB pairing needs a user gesture) */
export function connectGaze(): void {
  void runtime?.gaze?.connect().catch(() => undefined);
}

export function disconnectGaze(): void {
  runtime?.gaze?.disconnect();
}

/** every mapped sample; returns an unsubscribe function */
export function subscribeGaze(cb: (s: MappedSample) => void): () => void {
  sampleListeners.add(cb);
  return () => {
    sampleListeners.delete(cb);
  };
}

export function latestGaze(): MappedSample | undefined {
  return latest;
}

/** samples per second over the last second, measured here */
export function measuredRate(nowMs: number = performance.now()): number {
  let n = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] > nowMs - 1000; i--) n++;
  return n;
}

export interface GazeHandle {
  settings: GazeSettings;
  /** undefined when gazeSource is off */
  status: GazeStatus | undefined;
  source: GazeSource | undefined;
  calibration: Calibration;
  /** a calibration was measured (not identity) */
  calibrated: boolean;
  connect: () => void;
  disconnect: () => void;
  subscribe: (cb: (s: MappedSample) => void) => () => void;
  latest: () => MappedSample | undefined;
  setCalibration: (c: Calibration | undefined) => boolean;
}

/** The shared gaze source, configured from the plugin settings. */
export function useGaze(): GazeHandle {
  const settings = gazeSettings(usePluginSettings());
  React.useEffect(() => configure(settings), [settings.source]);
  const [, setVersion] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setVersion((v) => (v + 1) % 1_000_000);
    changeListeners.add(bump);
    bump(); // the source may have been configured before this subscribed
    return () => {
      changeListeners.delete(bump);
    };
  }, []);
  const cal = currentCalibration();
  return {
    settings,
    status: runtime?.status,
    source: runtime?.gaze,
    calibration: cal,
    calibrated: cal.points > 0,
    connect: connectGaze,
    disconnect: disconnectGaze,
    subscribe: subscribeGaze,
    latest: latestGaze,
    setCalibration,
  };
}

/** The latest mapped sample, updated at most once per animation frame while `enabled`. */
export function useGazePoint(enabled: boolean): MappedSample | undefined {
  const [sample, setSample] = React.useState<MappedSample | undefined>(undefined);
  React.useEffect(() => {
    if (!enabled) {
      setSample(undefined);
      return;
    }
    let frame = 0;
    const off = subscribeGaze(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setSample(latest);
      });
    });
    return () => {
      off();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);
  return sample;
}

// --- the "Show gaze" toggle, shared by the sensors panel and the gaze dot ---------

let showGaze: boolean | undefined;
const showGazeListeners = new Set<(on: boolean) => void>();

export function useShowGaze(): [boolean, (on: boolean) => void] {
  const [on, setOn] = React.useState(() => (showGaze ??= loadShowGaze()));
  React.useEffect(() => {
    showGazeListeners.add(setOn);
    return () => {
      showGazeListeners.delete(setOn);
    };
  }, []);
  const set = React.useCallback((next: boolean) => {
    showGaze = next;
    saveShowGaze(next);
    for (const cb of [...showGazeListeners]) cb(next);
  }, []);
  return [on, set];
}
