// Development stand-in for an eye tracker: the mouse pointer is the gaze.
// Samples are converted to tracker screen px with the same geometry model
// as mapping.ts, so screenToViewport(sample) gives back the pointer's
// client position. Holding Shift, leaving the window or blurring it marks
// samples invalid (looking away). A heartbeat repeats the last sample so a
// still mouse is a steady gaze, not a stalled tracker.

import { viewportToScreen, readWindowGeometry } from "./mapping.ts";
import { createListeners, createRateCounter, defaultNow, GLOBAL_TIMERS } from "./rate.ts";
import type { Timers } from "./rate.ts";
import type { GazeSample, GazeSource, GazeStatus, ScreenRect, WindowGeometry } from "./types.ts";

export interface EventTargetLike {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface MouseSourceOptions {
  /** where mouse/key/focus events are listened for, default window */
  target?: EventTargetLike;
  now?: () => number;
  /**
   * Origin of the simulated tracker monitor in desktop device px (samples
   * are relative to it, like a tracker's); reported as status().screen x/y.
   * Default 0,0.
   */
  screenOffset?: () => { x: number; y: number };
  /** size of the simulated tracker monitor in device px, default window.screen * dpr */
  screenSize?: () => { width: number; height: number } | undefined;
  /** window placement, default readWindowGeometry() */
  geometry?: () => WindowGeometry;
  timers?: Timers;
  /** sample repeat interval while the mouse is still, ms (default 33 ≈ 30 Hz) */
  heartbeatMs?: number;
  /** KeyboardEvent.key that simulates looking away while held, default "Shift" */
  awayKey?: string;
}

function defaultScreenSize(): { width: number; height: number } | undefined {
  const s = globalThis.screen;
  if (s === undefined) return undefined;
  const dpr = globalThis.devicePixelRatio || 1;
  return { width: s.width * dpr, height: s.height * dpr };
}

export function createMouseSource(opts: MouseSourceOptions = {}): GazeSource {
  const now = opts.now ?? defaultNow;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const heartbeatMs = opts.heartbeatMs ?? 33;
  const awayKey = opts.awayKey ?? "Shift";
  const geometry = opts.geometry ?? (() => readWindowGeometry());
  const screenOffset = opts.screenOffset ?? (() => ({ x: 0, y: 0 }));
  const screenSize = opts.screenSize ?? defaultScreenSize;

  const samples = createListeners<GazeSample>();
  const statuses = createListeners<GazeStatus>();
  const rate = createRateCounter();

  let connected = false;
  let target: EventTargetLike | undefined;
  let pos: { x: number; y: number } | undefined;
  let keyHeld = false;
  let outside = false;
  let timer: unknown;
  let lastTracking: boolean | undefined;
  let lastRateEmit = -Infinity;

  function screenRect(): ScreenRect {
    const o = screenOffset();
    const size = screenSize();
    return { x: o.x, y: o.y, width: size?.width ?? 0, height: size?.height ?? 0 };
  }

  function status(): GazeStatus {
    if (!connected) return { kind: "mouse", connection: "disconnected" };
    const st: GazeStatus = {
      kind: "mouse",
      connection: "connected",
      present: true,
      tracking: valid(),
      screen: screenRect(),
      rate: rate.rate(now()),
      message: `Mouse stands in for gaze; hold ${awayKey} to look away`,
    };
    return st;
  }

  function valid(): boolean {
    return pos !== undefined && !keyHeld && !outside;
  }

  function emit(): void {
    if (!connected) return;
    const t = now();
    let x = Number.NaN, y = Number.NaN;
    if (pos !== undefined) {
      const s = viewportToScreen(pos, geometry(), screenRect());
      x = s.x;
      y = s.y;
    }
    rate.add(t);
    samples.emit({ t, x, y, valid: valid() });
    const tracking = valid();
    if (tracking !== lastTracking || t - lastRateEmit >= 1000) {
      lastTracking = tracking;
      lastRateEmit = t;
      statuses.emit(status());
    }
  }

  function schedule(): void {
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (!connected) return;
      emit();
      schedule();
    }, heartbeatMs);
  }

  const onMove = (e: Event): void => {
    const m = e as MouseEvent;
    if (!Number.isFinite(m.clientX) || !Number.isFinite(m.clientY)) return;
    pos = { x: m.clientX, y: m.clientY };
    outside = false;
    if (typeof m.shiftKey === "boolean" && awayKey === "Shift") keyHeld = m.shiftKey;
    emit();
  };
  const onKeyDown = (e: Event): void => {
    if ((e as KeyboardEvent).key === awayKey && !keyHeld) {
      keyHeld = true;
      emit();
    }
  };
  const onKeyUp = (e: Event): void => {
    if ((e as KeyboardEvent).key === awayKey && keyHeld) {
      keyHeld = false;
      emit();
    }
  };
  const onOut = (e: Event): void => {
    // relatedTarget null = the pointer left the window
    if ((e as MouseEvent).relatedTarget == null) {
      outside = true;
      emit();
    }
  };
  const onBlur = (): void => {
    outside = true;
    keyHeld = false;
    emit();
  };

  const handlers: [string, (e: Event) => void][] = [
    ["mousemove", onMove],
    ["keydown", onKeyDown],
    ["keyup", onKeyUp],
    ["mouseout", onOut],
    ["blur", onBlur],
  ];

  return {
    kind: "mouse",
    async connect() {
      if (connected) return;
      target = opts.target ?? (globalThis.window as EventTargetLike | undefined);
      if (target === undefined) {
        statuses.emit({ kind: "mouse", connection: "error", message: "No window to read the mouse from" });
        return;
      }
      for (const [type, h] of handlers) target.addEventListener(type, h);
      connected = true;
      lastTracking = undefined;
      schedule();
      statuses.emit(status());
    },
    disconnect() {
      if (!connected) return;
      connected = false;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      if (target !== undefined) for (const [type, h] of handlers) target.removeEventListener(type, h);
      target = undefined;
      rate.reset();
      statuses.emit(status());
    },
    status,
    onSample: (cb) => samples.add(cb),
    onStatus: (cb) => statuses.add(cb),
  };
}
