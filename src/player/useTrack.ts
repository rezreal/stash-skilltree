// The distance sensor of the play screens and the per-clip track session.
//
// Like useGaze: one sensor source lives for the plugin's lifetime (module
// state), so moving between the choice screen, the player and the sensor
// page doesn't reconnect; it is recreated only when the sensor settings
// change. The raw-to-position calibration is kept in localStorage
// ("skilltree.trackCalibration", via the track module's serialize/parse).
//
// useTrackSession(sceneId, getVideoTime) builds a createTrackSession for the
// scene's funscript (main stroke axis, inverted/range applied by
// scriptActions), feeds it every sensor sample with the video time at
// arrival, and hands out guide()/score() for the overlay and the panel.
//
// Auto-connect (on by default, per browser): a sensor that connected before
// on this page reconnects by itself when a track clip starts, and on a fresh
// page load a sensor granted earlier connects without a click where the
// browser lists earlier grants (navigator.bluetooth.getDevices). Pressing
// Disconnect stops that until the next Connect. Dropped links are retried by
// the source itself (src/sensors/ble.ts).
//
// The sensor is optional: without a calibration (or without a connected
// sensor) the clip still plays and the guide still shows the target, but the
// track rule is not scored (TrackHandle.scored() is false).
import type { Funscript } from "../funscript/parse.ts";
import { loadFunscript } from "../funscript/load.ts";
import { bluetoothAvailable, canAutoConnect, createBleDistanceSource, sensorDevicePermitted } from "../sensors/ble.ts";
import {
  createTrackSession,
  parseTrackCalibration,
  scriptActions,
  createPositionFilter,
  serializeTrackCalibration,
  type TrackSession,
} from "../track/index.ts";
import type {
  Action,
  BleSensorConfig,
  DistanceSample,
  DistanceSource,
  GuideFrame,
  Section,
  SensorStatus,
  TrackCalibration,
  TrackLimits,
  TrackScore,
} from "../track/types.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";
import { ROUTE } from "../ui/register.tsx";
import type { StorageLike } from "./storage.ts";
import { applyValidRange, configKey, trackSettings, type TrackSettings } from "./trackView.ts";

/** the sensor setup and calibration page; registered by register.tsx */
export const SENSOR_ROUTE = `${ROUTE}/sensor`;

export const TRACK_CALIBRATION_KEY = "skilltree.trackCalibration";
export const SENSOR_AUTO_KEY = "skilltree.sensorAutoConnect";

// --- calibration storage -------------------------------------------------------------

function storage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

let calibration: TrackCalibration | undefined;
let calibrationLoaded = false;

export function currentTrackCalibration(): TrackCalibration | undefined {
  if (!calibrationLoaded) {
    calibrationLoaded = true;
    try {
      calibration = parseTrackCalibration(storage()?.getItem(TRACK_CALIBRATION_KEY));
    } catch {
      calibration = undefined;
    }
  }
  return calibration;
}

/** stores the calibration (undefined removes it); false when storage is blocked */
export function setTrackCalibration(c: TrackCalibration | undefined): boolean {
  calibration = c;
  calibrationLoaded = true;
  let stored = false;
  try {
    const s = storage();
    if (s) {
      if (c) s.setItem(TRACK_CALIBRATION_KEY, serializeTrackCalibration(c));
      else s.removeItem(TRACK_CALIBRATION_KEY);
      stored = true;
    }
  } catch {
    stored = false;
  }
  emitChange();
  return stored;
}

// --- auto-connect preference ------------------------------------------------------------

let autoConnect: boolean | undefined;

export function sensorAutoConnect(): boolean {
  if (autoConnect === undefined) {
    try {
      autoConnect = storage()?.getItem(SENSOR_AUTO_KEY) !== "0";
    } catch {
      autoConnect = true;
    }
  }
  return autoConnect;
}

export function setSensorAutoConnect(on: boolean): void {
  autoConnect = on;
  try {
    storage()?.setItem(SENSOR_AUTO_KEY, on ? "1" : "0");
  } catch {
    // applies until the page is reloaded
  }
  emitChange();
  if (on) ensureSensorConnected();
}

// --- the shared sensor ----------------------------------------------------------------

interface Runtime {
  key: string;
  config: BleSensorConfig;
  source: DistanceSource;
  status: SensorStatus;
  stop: () => void;
}

let runtime: Runtime | undefined;
let latest: DistanceSample | undefined;
/** the valid range from the settings, applied to every sample (changing it keeps the connection) */
let validRange: Pick<BleSensorConfig, "validMin" | "validMax"> | undefined;
/** the current source reached the sensor once: connect() reuses the device without a picker */
let connectedOnce = false;
/** the viewer pressed Disconnect: no auto-connect until they press Connect */
let userDisconnected = false;
/** the live position, filtered like the session's (lost target stays out, lone spikes dropped) */
const liveFilter = createPositionFilter();
let livePosition: number | undefined;

const sampleListeners = new Set<(s: DistanceSample) => void>();
const changeListeners = new Set<() => void>();

function emitChange(): void {
  for (const cb of [...changeListeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[skilltree] sensor listener failed", err);
    }
  }
}

function emitSample(s: DistanceSample): void {
  for (const cb of [...sampleListeners]) {
    try {
      cb(s);
    } catch (err) {
      console.error("[skilltree] sensor sample listener failed", err);
    }
  }
}

function configure(settings: TrackSettings): void {
  const key = configKey(settings.config);
  if ((runtime?.key ?? "") === key) return;
  runtime?.stop();
  runtime = undefined;
  latest = undefined;
  connectedOnce = false;
  const config = settings.config;
  if (config) {
    const source = createBleDistanceSource(config);
    const rt: Runtime = { key, config, source, status: source.status(), stop: () => undefined };
    const offStatus = source.onStatus((s) => {
      const changed = s.connection !== rt.status.connection || s.message !== rt.status.message || s.device !== rt.status.device;
      rt.status = s;
      if (s.connection === "connected") connectedOnce = true;
      if (s.connection !== "connected") latest = undefined;
      // rate-only updates arrive every second; listeners re-read on their own ticks
      if (changed) emitChange();
    });
    const offSample = source.onSample((rawSample) => {
      const s = applyValidRange(rawSample, validRange);
      latest = s;
      const cal = currentTrackCalibration();
      livePosition = cal ? liveFilter.push(s.noTarget ? Number.NaN : s.raw, cal) : undefined;
      emitSample(s);
    });
    rt.stop = () => {
      offStatus();
      offSample();
      source.disconnect();
    };
    runtime = rt;
    ensureSensorConnected();
  }
  emitChange();
}

/**
 * Connects without a click when that is possible and wanted: auto-connect is
 * on, the viewer didn't press Disconnect, and either this source reached the
 * sensor before (the device is known) or the browser lists an earlier grant.
 */
export function ensureSensorConnected(): void {
  const rt = runtime;
  if (!rt || !sensorAutoConnect() || userDisconnected) return;
  const c = rt.source.status().connection;
  if (c === "connected" || c === "connecting") return;
  if (connectedOnce) {
    void rt.source.connect();
    return;
  }
  void sensorDevicePermitted(rt.config).then((ok) => {
    if (ok && runtime === rt && rt.source.status().connection !== "connected" && rt.source.status().connection !== "connecting") {
      void rt.source.connect();
    }
  });
}

/**
 * Call from the click that starts a track clip (Watch / Test): the click is
 * the user gesture the Bluetooth picker needs, so a sensor this page hasn't
 * met yet connects too (the picker opens, filtered by the name prefix);
 * a known one connects silently. Skipped when auto-connect is off or the
 * viewer pressed Disconnect.
 */
export function connectSensorForClip(): void {
  const rt = runtime;
  if (!rt || !sensorAutoConnect() || userDisconnected) return;
  const c = rt.source.status().connection;
  if (c === "connected" || c === "connecting") return;
  void rt.source.connect();
}

/** connects the sensor; call it from a click (the Bluetooth picker needs a user gesture) */
export function connectSensor(): void {
  userDisconnected = false;
  void runtime?.source.connect();
}

export function disconnectSensor(): void {
  userDisconnected = true;
  runtime?.source.disconnect();
}

/** every raw sample; returns an unsubscribe function */
export function subscribeSensor(cb: (s: DistanceSample) => void): () => void {
  sampleListeners.add(cb);
  return () => {
    sampleListeners.delete(cb);
  };
}

export function latestSample(): DistanceSample | undefined {
  return latest;
}

/** the latest reading mapped through the stored calibration (no drift), 0..100 */
export function latestPosition(): number | undefined {
  return latest ? livePosition : undefined;
}

export function sensorStatusNow(): SensorStatus | undefined {
  return runtime ? runtime.source.status() : undefined;
}

export interface TrackSensorHandle {
  settings: TrackSettings;
  /** service and characteristic are set */
  configured: boolean;
  /** this browser has Web Bluetooth */
  bluetooth: boolean;
  /** undefined while the sensor isn't configured */
  status: SensorStatus | undefined;
  calibration: TrackCalibration | undefined;
  calibrated: boolean;
  limits: TrackLimits;
  /** connect by itself when possible (per-browser preference, default on) */
  autoConnect: boolean;
  setAutoConnect: (on: boolean) => void;
  /** the browser lists earlier grants, so a reload reconnects without a click */
  reloadReconnects: boolean;
  connect: () => void;
  disconnect: () => void;
  subscribe: (cb: (s: DistanceSample) => void) => () => void;
  latest: () => DistanceSample | undefined;
  latestPosition: () => number | undefined;
  setCalibration: (c: TrackCalibration | undefined) => boolean;
}

/** The shared distance sensor, configured from the plugin settings. */
export function useTrackSensor(): TrackSensorHandle {
  const raw = usePluginSettings();
  const settings = trackSettings(raw);
  const key = configKey(settings.config);
  validRange = settings.config;
  React.useEffect(() => configure(settings), [key]);
  const [, setVersion] = React.useState(0);
  React.useEffect(() => {
    const bump = () => setVersion((v) => (v + 1) % 1_000_000);
    changeListeners.add(bump);
    bump();
    return () => {
      changeListeners.delete(bump);
    };
  }, []);
  const cal = currentTrackCalibration();
  return {
    settings,
    configured: settings.config !== undefined,
    bluetooth: bluetoothAvailable(),
    status: runtime && runtime.key === key ? runtime.source.status() : undefined,
    calibration: cal,
    calibrated: cal !== undefined,
    limits: settings.limits,
    autoConnect: sensorAutoConnect(),
    setAutoConnect: setSensorAutoConnect,
    reloadReconnects: canAutoConnect(),
    connect: connectSensor,
    disconnect: disconnectSensor,
    subscribe: subscribeSensor,
    latest: latestSample,
    latestPosition,
    setCalibration: setTrackCalibration,
  };
}

/** Re-renders every `ms` while `enabled` (rates and scores move without events). */
export function useTicker(enabled: boolean, ms = 500): void {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((n) => (n + 1) % 1_000_000), ms);
    return () => window.clearInterval(id);
  }, [enabled, ms]);
}

// --- the per-clip session --------------------------------------------------------------

export type TrackSessionState =
  | { state: "loading" }
  /** no funscript, or one without movement: the track rule doesn't apply */
  | { state: "none" }
  | { state: "error"; message: string }
  /** the guide works; check TrackHandle.scored() for whether the rule is scored */
  | { state: "ready" };

export interface TrackHandle {
  /** stable for the session (changes with the scene, calibration or limits) */
  session: TrackSession;
  actions: Action[];
  sections: Section[];
  limits: TrackLimits;
  /** guide frame at a video time (seconds); hides a stale sensor position */
  guide: (videoTimeSec: number) => GuideFrame;
  score: () => TrackScore;
  /** the sensor is connected and sending (a reading in the last second) */
  live: () => boolean;
  /** a calibration exists; without one no samples are fed and nothing is scored */
  calibrated: boolean;
  /**
   * The track rule can be scored: calibrated and at least one sensor reading
   * reached this session. False means "track not scored", not a failure.
   */
  scored: () => boolean;
  /** one reading (done automatically by useTrackSession); ignored while uncalibrated */
  feed: (raw: number, tMs: number, videoTimeSec: number) => void;
}

/** stands in for a missing calibration so the guide can still show the script; never fed */
const GUIDE_ONLY_CALIBRATION: TrackCalibration = { rawAtZero: 0, rawAtFull: 100, drift: 0, createdAt: "" };

export interface TrackSessionOptions {
  /** false skips loading (e.g. the scene has no funscript, or the policy has no track rule) */
  enabled?: boolean;
  /** samples are only scored while this says the video plays (default: always) */
  isPlaying?: () => boolean;
}

export interface TrackSessionResult {
  state: TrackSessionState;
  /** set when state is ready */
  track: TrackHandle | undefined;
}

/**
 * A track session for the scene's funscript, fed by the shared sensor. The
 * session persists the drift it learned into the stored calibration when
 * it ends (unmount or scene change).
 */
export function useTrackSession(
  sceneId: string | undefined,
  getVideoTime: () => number | undefined,
  opts: TrackSessionOptions = {},
): TrackSessionResult {
  const sensor = useTrackSensor();
  const enabled = opts.enabled !== false && sceneId !== undefined;
  const [script, setScript] = React.useState<{ id: string; f: Funscript | undefined; error?: string } | undefined>(undefined);

  React.useEffect(() => {
    if (!enabled || !sceneId) return;
    let live = true;
    loadFunscript(sceneId).then(
      (f) => {
        if (live) setScript({ id: sceneId, f });
      },
      (err: unknown) => {
        if (live) setScript({ id: sceneId, f: undefined, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [sceneId, enabled]);

  const getters = React.useRef({ getVideoTime, isPlaying: opts.isPlaying });
  getters.current = { getVideoTime, isPlaying: opts.isPlaying };

  const cal = sensor.calibration;
  const { maxDepth, maxHoldSec } = sensor.limits;
  const loaded = script && script.id === sceneId ? script : undefined;
  const actions = React.useMemo(() => (loaded?.f ? scriptActions(loaded.f) : undefined), [loaded?.f]);
  // the calibration's identity changes when it is saved; drift written back
  // by this session itself must not restart it, so key on the two readings
  const calKey = cal ? `${cal.rawAtZero}|${cal.rawAtFull}` : "";

  const track = React.useMemo((): TrackHandle | undefined => {
    if (!actions || actions.length < 2) return undefined;
    const limits = { maxDepth, maxHoldSec };
    const session = createTrackSession({ script: actions, calibration: cal ?? GUIDE_ONLY_CALIBRATION, limits });
    let fed = 0;
    return {
      session,
      actions: session.actions,
      sections: session.sections,
      limits,
      guide: (vt) => session.guide(vt, performance.now()),
      score: () => session.score(),
      live: () => {
        const s = latestSample();
        return s !== undefined && performance.now() - s.t < 1000;
      },
      calibrated: cal !== undefined,
      scored: () => cal !== undefined && fed > 0,
      feed: (raw, tMs, videoTimeSec) => {
        if (cal === undefined) return;
        session.pushSample(raw, tMs, videoTimeSec);
        fed++;
      },
    };
  }, [actions, calKey, maxDepth, maxHoldSec]);

  // a track clip starts: bring a known sensor back without a click
  React.useEffect(() => {
    if (track) ensureSensorConnected();
  }, [track]);

  React.useEffect(() => {
    // uncalibrated: the guide shows the script, nothing is fed or scored
    if (!track || !track.calibrated) return;
    const off = subscribeSensor((s) => {
      const { getVideoTime: vt, isPlaying } = getters.current;
      if (isPlaying && !isPlaying()) return;
      const t = vt();
      if (t === undefined || !Number.isFinite(t)) return;
      track.feed(s.noTarget ? Number.NaN : s.raw, s.t, t);
    });
    return () => {
      off();
      // keep the drift learned in idle sections for the next clip
      const learned = track.session.calibration();
      const stored = currentTrackCalibration();
      if (stored && learned.drift !== stored.drift && learned.rawAtZero === stored.rawAtZero && learned.rawAtFull === stored.rawAtFull) {
        setTrackCalibration(learned);
      }
    };
  }, [track]);

  let state: TrackSessionState;
  if (!enabled) state = { state: "none" };
  else if (!loaded) state = { state: "loading" };
  else if (loaded.error) state = { state: "error", message: loaded.error };
  else if (!actions || actions.length < 2) state = { state: "none" };
  else state = { state: "ready" };
  return { state, track: state.state === "ready" ? track : undefined };
}
