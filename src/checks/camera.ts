// One webcam session at a time, shared by whoever needs it (the camera gate,
// then the session's presence + action prompts). Reference counted: the
// camera starts on the first acquire() and stops `lingerMs` after the last
// release, so a remount (React StrictMode, the gate handing over to the
// session in the same commit) keeps the running camera instead of blinking
// the camera light. A start still in flight when the last user left is
// stopped as soon as it resolves.
//
// No DOM here: the starter is injected (startViewer in the browser, a fake
// in tests). Time base for presence: the frames' `t` (performance.now()).

import { PerceptionError } from "../perception/errors.ts";
import { createPresenceMonitor } from "../prompts/presence.ts";
import type { PresenceOptions } from "../prompts/presence.ts";
import type { ViewerFrame } from "../prompts/types.ts";
import type { PresenceInfo } from "./attention.ts";

export type CameraState = "off" | "starting" | "on" | "error";

/** What the manager needs of a viewer session (perception/viewer.ts ViewerSession). */
export interface CameraSessionLike {
  readonly stream: MediaStream;
  latest(): ViewerFrame | null;
  onFrame(cb: (f: ViewerFrame) => void): () => void;
  onError(cb: (e: PerceptionError) => void): () => void;
  setRate(hz: number): void;
  stop(): void;
}

export interface CameraManagerOptions {
  start: (opts: { rateHz: number }) => Promise<CameraSessionLike>;
  /** ms the camera stays on after the last release (default 1000) */
  lingerMs?: number;
  /** initial analysis rate (default 2 Hz, VIEWER_RATE.idle) */
  rateHz?: number;
  presence?: PresenceOptions;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface CameraSnapshot {
  state: CameraState;
  error?: PerceptionError;
}

export interface CameraManager {
  /** starts the camera if needed; returns the (idempotent) release */
  acquire(): () => void;
  snapshot(): CameraSnapshot;
  /** presence now (default clock: performance.now()) */
  present(nowMs?: number): PresenceInfo;
  latest(): ViewerFrame | null;
  stream(): MediaStream | null;
  setRate(hz: number): void;
  subscribe(cb: (f: ViewerFrame) => void): () => void;
  /** state / error changed */
  onChange(cb: () => void): () => void;
  /** starts again after an error (while someone holds the camera) */
  retry(): void;
  /** stops right away, whoever holds it (page hide) */
  stopNow(): void;
  readonly users: number;
}

export const CAMERA_LINGER_MS = 1000;

export function toPerceptionError(err: unknown): PerceptionError {
  if (err instanceof PerceptionError) return err;
  return new PerceptionError("unknown", err instanceof Error ? err.message : String(err), err);
}

export function createCameraManager(opts: CameraManagerOptions): CameraManager {
  const lingerMs = opts.lingerMs ?? CAMERA_LINGER_MS;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const monitor = createPresenceMonitor(opts.presence);
  const frameCbs = new Set<(f: ViewerFrame) => void>();
  const changeCbs = new Set<() => void>();

  let users = 0;
  let state: CameraState = "off";
  let error: PerceptionError | undefined;
  let session: CameraSessionLike | undefined;
  let offSession: (() => void)[] = [];
  let seq = 0;
  let rate = opts.rateHz ?? 2;
  let linger: unknown;

  function setState(s: CameraState, e?: PerceptionError): void {
    if (state === s && error === e) return;
    state = s;
    error = e;
    for (const cb of [...changeCbs]) {
      try {
        cb();
      } catch (err) {
        console.error("[skilltree] camera listener failed", err);
      }
    }
  }

  function emitFrame(f: ViewerFrame): void {
    monitor.push(f);
    for (const cb of [...frameCbs]) {
      try {
        cb(f);
      } catch (err) {
        console.error("[skilltree] camera frame listener failed", err);
      }
    }
  }

  function stopSession(): void {
    for (const off of offSession) off();
    offSession = [];
    const s = session;
    session = undefined;
    monitor.reset();
    try {
      s?.stop();
    } catch (err) {
      console.error("[skilltree] stopping the camera failed", err);
    }
  }

  function start(): void {
    const my = ++seq;
    monitor.reset();
    setState("starting");
    let p: Promise<CameraSessionLike>;
    try {
      p = opts.start({ rateHz: rate });
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (s) => {
        if (my !== seq || users === 0) {
          try {
            s.stop();
          } catch {
            // ignore
          }
          if (my === seq) setState("off");
          return;
        }
        session = s;
        s.setRate(rate);
        offSession = [
          s.onFrame(emitFrame),
          s.onError((e) => {
            if (session !== s) return;
            stopSession();
            setState("error", e);
          }),
        ];
        setState("on");
      },
      (err) => {
        if (my !== seq) return;
        setState("error", toPerceptionError(err));
      },
    );
  }

  function cancelLinger(): void {
    if (linger !== undefined) clearTimer(linger);
    linger = undefined;
  }

  function stopNow(): void {
    cancelLinger();
    seq++;
    stopSession();
    setState("off");
  }

  return {
    get users() {
      return users;
    },
    acquire() {
      users++;
      cancelLinger();
      // the first user after everyone left also retries a failed start
      if (state === "off" || (state === "error" && users === 1)) start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        users = Math.max(0, users - 1);
        if (users > 0) return;
        cancelLinger();
        linger = setTimer(() => {
          linger = undefined;
          if (users === 0) stopNow();
        }, lingerMs);
      };
    },
    snapshot() {
      const s: CameraSnapshot = { state };
      if (error !== undefined) s.error = error;
      return s;
    },
    present(nowMs = now()) {
      switch (state) {
        case "off":
          return { present: false, reason: "off" };
        case "starting":
          return { present: false, reason: "starting" };
        case "error":
          return { present: false, reason: "error" };
        default: {
          const p = monitor.present(nowMs);
          return { present: p.present, reason: p.reason };
        }
      }
    },
    latest: () => session?.latest() ?? null,
    stream: () => session?.stream ?? null,
    setRate(hz) {
      if (!Number.isFinite(hz) || hz <= 0) return;
      rate = hz;
      session?.setRate(hz);
    },
    subscribe(cb) {
      frameCbs.add(cb);
      return () => {
        frameCbs.delete(cb);
      };
    },
    onChange(cb) {
      changeCbs.add(cb);
      return () => {
        changeCbs.delete(cb);
      };
    },
    retry() {
      if (users > 0 && (state === "error" || state === "off")) start();
    },
    stopNow,
  };
}
