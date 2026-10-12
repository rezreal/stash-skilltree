// The viewer's webcam for a viewing session: presence all the time, body /
// head actions during prompts. startViewer() opens the camera and runs the
// analysis loop at a configurable rate; stopViewer() stops the tracks so the
// camera light goes off.
//
// Rates: VIEWER_RATE.idle (2 Hz) while no action prompt is active, .action
// (15 Hz) during one - the caller switches with setRate(). The loop uses
// setTimeout, which browsers throttle to ~1 Hz in hidden tabs.

import type { ViewerFrame } from "../prompts/types.ts";
import { PerceptionError } from "./errors.ts";
import { clampRate, nextDelay } from "./time.ts";
import { createVision } from "./vision.ts";
import type { ViewerAnalyzer, Vision, VisionOptions } from "./vision.ts";
import { openWebcam, stopStream } from "./webcam.ts";
import type { WebcamOptions } from "./webcam.ts";

// idle only serves presence (DEFAULT_PRESENCE_STALE_MS 2 s, grace 1.5 s):
// 2 Hz keeps well inside both, at well under half the main-thread cost of
// the face / pose models per second
export const VIEWER_RATE = { idle: 2, action: 15 } as const;

export interface ViewerSessionOptions {
  /** analysis rate in Hz (default VIEWER_RATE.idle) */
  rateHz?: number;
  /** reuse a Vision instance (it is not disposed on stop); default: a new one */
  vision?: Vision;
  visionOptions?: VisionOptions;
  webcam?: WebcamOptions;
  /** a <video> to show the webcam in (preview); default a detached one */
  video?: HTMLVideoElement;
  /** clock, default performance.now */
  now?: () => number;
}

export interface ViewerSession {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  readonly rate: number;
  readonly running: boolean;
  /** the most recent frame (null before the first) */
  latest(): ViewerFrame | null;
  onFrame(cb: (f: ViewerFrame) => void): () => void;
  /** camera lost (unplugged, revoked) or repeated analysis failures */
  onError(cb: (e: PerceptionError) => void): () => void;
  setRate(hz: number): void;
  /** same as stopViewer(session) */
  stop(): void;
}

/** Consecutive failed analyses before onError fires (once). */
const MAX_FAILURES = 20;

/** Opens the webcam and starts analysing it. Rejects with PerceptionError. */
export async function startViewer(opts: ViewerSessionOptions = {}): Promise<ViewerSession> {
  const now = opts.now ?? (() => performance.now());
  const stream = await openWebcam(opts.webcam);
  let vision: Vision | undefined;
  let analyzer: ViewerAnalyzer;
  try {
    vision = opts.vision ?? (await createVision(opts.visionOptions));
    analyzer = await vision.viewerAnalyzer(stream, { video: opts.video });
  } catch (err) {
    stopStream(stream);
    if (!opts.vision) vision?.dispose();
    throw err instanceof PerceptionError ? err : new PerceptionError("model-failed", String(err), err);
  }

  let rate = clampRate(opts.rateHz ?? VIEWER_RATE.idle, VIEWER_RATE.idle);
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: ViewerFrame | null = null;
  let failures = 0;
  let failureReported = false;
  const frameCbs = new Set<(f: ViewerFrame) => void>();
  const errorCbs = new Set<(e: PerceptionError) => void>();

  const emitError = (e: PerceptionError): void => {
    for (const cb of errorCbs) cb(e);
  };

  const tick = (): void => {
    timer = undefined;
    if (!running) return;
    const started = now();
    const frame = analyzer.analyze(started);
    if (frame) {
      failures = 0;
      failureReported = false;
      latest = frame;
      for (const cb of frameCbs) cb(frame);
    } else if (analyzer.lastError !== undefined && ++failures >= MAX_FAILURES && !failureReported) {
      failureReported = true;
      emitError(new PerceptionError("model-failed", `Webcam analysis keeps failing: ${String(analyzer.lastError)}`, analyzer.lastError));
    }
    if (running) timer = setTimeout(tick, nextDelay(rate, started, now()));
  };

  const onEnded = (): void => {
    if (running) emitError(new PerceptionError("device-busy", "The webcam stopped (unplugged or access revoked)."));
  };
  for (const t of stream.getVideoTracks()) t.addEventListener("ended", onEnded);

  const session: ViewerSession = {
    stream,
    video: analyzer.video,
    get rate() {
      return rate;
    },
    get running() {
      return running;
    },
    latest: () => latest,
    onFrame(cb) {
      frameCbs.add(cb);
      return () => frameCbs.delete(cb);
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => errorCbs.delete(cb);
    },
    setRate(hz) {
      const next = clampRate(hz, rate);
      if (next === rate) return;
      rate = next;
      // apply right away instead of after a long idle delay
      if (running && timer !== undefined) {
        clearTimeout(timer);
        timer = setTimeout(tick, 0);
      }
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const t of stream.getVideoTracks()) t.removeEventListener("ended", onEnded);
      analyzer.dispose();
      stopStream(stream);
      if (!opts.vision) vision?.dispose();
      frameCbs.clear();
      errorCbs.clear();
    },
  };
  timer = setTimeout(tick, 0);
  return session;
}

/** Ends a viewer session: stops the loop, closes the models, stops the camera. */
export function stopViewer(session: ViewerSession | null | undefined): void {
  session?.stop();
}
