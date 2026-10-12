// Live prompt checks for one clip: the prompt runner (src/prompts) wired to
// the video clock, the eye tracker, the webcam, the microphone and MediaPipe
// on the clip. The session controller passes the clock and the video and
// gets results (onResult) and replay seeks (onSeek) back.
//
// Resources:
// - speech (repeat prompts, speechEnabled): the Vosk model is loaded when the
//   hook mounts; the microphone is open only from ~1 s before a repeat window
//   until it ends. Disposed on unmount.
// - vision (gaze prompts whose target needs the person, videoAnalysis):
//   MediaPipe is loaded when the hook mounts and the analyzer bound to the
//   current <video> (re-bound when the element is swapped); frames are
//   analysed at ~10 Hz only from ~1 s before such a window until it ends.
//   Disposed on unmount.
// - webcam: owned by useViewerPresence; this hook only subscribes to its
//   frames and raises the rate around action windows (and gaze eyes_closed
//   windows, which use the webcam's blink scores as well as the tracker).
// A prompt whose sensor is unavailable (see schedule.ts) is not reported.
//
// The spec list is frozen when the runner is created (first time enabled for
// the scene), so a camera or setting change mid-clip never resets prompts.
import type { Id, SceneInput } from "../core/types.ts";
import type { GazeAttentionSample } from "../gaze/types.ts";
import { clampRate, nextDelay } from "../perception/time.ts";
import { VIEWER_RATE } from "../perception/viewer.ts";
import { createSpeech, type Speech } from "../perception/speech.ts";
import { createVision, type PersonAnalyzer, type Vision } from "../perception/vision.ts";
import type { PerceptionError } from "../perception/errors.ts";
import { gazeStatusNow, subscribeGaze } from "../player/useGaze.ts";
import { createPromptRunner, type GazeFeedSample, type PromptRunner } from "../prompts/runner.ts";
import { promptSpecs } from "../prompts/specs.ts";
import { grammarFor } from "../prompts/speechCheck.ts";
import type { PromptEvents, PromptPhase, PromptProgress, PromptResult, PromptSpec, Region, VideoBox } from "../prompts/types.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";
import type { MicState, VisionState } from "./gate.ts";
import {
  DEFAULT_LEAD_SEC,
  filterPromptEvents,
  newlyReplaying,
  personPartsFor,
  scheduleChecks,
  selectSpecs,
  uncheckableReason,
  usesWebcam,
  type SensorAvailability,
  type SkippedSpec,
} from "./schedule.ts";
import { checksSettings, type ChecksSettings } from "./settings.ts";
import { promptAttentionFrom, type PromptAttention } from "./attention.ts";
import type { ViewerPresence } from "./useViewerPresence.ts";
import type { LastResult } from "./wording.ts";

/** runner + analysis tick (Hz) */
export const CHECKS_TICK_HZ = 10;
/** consecutive failed analyses before video analysis counts as failed */
const MAX_ANALYSIS_FAILURES = 20;

export interface ChecksStatus {
  vision: { state: VisionState; message?: string };
  speech: { state: MicState; message?: string };
  /** needed: the clip has action prompts */
  camera: { needed: boolean; state: ViewerPresence["state"] | "none" };
}

export interface PromptChecksInput {
  scene: SceneInput;
  /** false: inert (also when the promptsEnabled setting is off) */
  enabled: boolean;
  /** video seconds; undefined/NaN while unknown */
  getVideoTime: () => number | undefined;
  getVideo: () => HTMLVideoElement | null;
  /** where the video is drawn; default: the rect of getVideo() */
  getVideoBox?: () => VideoBox | undefined;
  /** the webcam (useViewerPresence); without it action prompts can't be checked */
  viewer?: ViewerPresence;
  /** gaze samples mapped to the viewport; default: the shared gaze source (subscribeGaze) */
  gazeSamples?: (cb: (s: GazeAttentionSample) => void) => () => void;
  /** an eye tracker is connected; default: the shared gaze source's status */
  trackerConnected?: () => boolean;
  /**
   * the tracker reports a person in front of it (undefined = unknown);
   * default: the shared gaze source's status. Gaze eyes_closed prompts read
   * "present without gaze" as closed eyes.
   */
  trackerPresent?: () => boolean | undefined;
  onResult: (r: PromptResult) => void;
  onSeek: (toSec: number) => void;
  /** default: from the plugin settings */
  settings?: ChecksSettings;
}

export interface PromptChecks {
  /** the specs being checked (frozen per clip) */
  specs: readonly PromptSpec[];
  /** specs the settings switched off (never reported) */
  skipped: readonly SkippedSpec[];
  progress(): PromptProgress[];
  /** specs whose window is active (re-renders when this changes) */
  active: PromptSpec[];
  /** a gaze prompt's window is active (re-renders when this changes) */
  gazePromptActive: boolean;
  /**
   * The session's attention target while a gaze prompt is active: the
   * leading gaze prompt (latest start) and whether the viewer follows it at
   * nowMs (performance.now() timebase, default now). undefined when no gaze
   * prompt is active; it then is the usual gaze-on-video rule.
   */
  promptAttention(nowMs?: number): PromptAttention | undefined;
  status: ChecksStatus;
  /** the video ended: evaluates open windows and reports them (once) */
  finish(): void;
  /** the region a gaze spec currently targets (viewport px) */
  regionFor(spec: PromptSpec): Region | undefined;
  /** why a spec can't be checked right now (its result is then not reported) */
  uncheckable(spec: PromptSpec): string | undefined;
  /** the last reported result (for "Done" / "Missed") */
  lastResult(): LastResult | undefined;
  /** the current video time as last read (seconds) */
  videoTime(): number | undefined;
}

/** The video element's box for the region mapping; undefined before it has a frame size. */
export function videoBoxOf(video: HTMLVideoElement | null): VideoBox | undefined {
  if (!video || !video.videoWidth || !video.videoHeight) return undefined;
  const r = video.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return undefined;
  return { left: r.left, top: r.top, width: r.width, height: r.height, videoWidth: video.videoWidth, videoHeight: video.videoHeight };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const INITIAL_STATUS: ChecksStatus = {
  vision: { state: "off" },
  speech: { state: "off" },
  camera: { needed: false, state: "none" },
};

function sameStatus(a: ChecksStatus, b: ChecksStatus): boolean {
  return (
    a.vision.state === b.vision.state &&
    a.vision.message === b.vision.message &&
    a.speech.state === b.speech.state &&
    a.speech.message === b.speech.message &&
    a.camera.needed === b.camera.needed &&
    a.camera.state === b.camera.state
  );
}

function sameSpecs(a: readonly PromptSpec[], b: readonly PromptSpec[]): boolean {
  return a.length === b.length && a.every((s, i) => s.markerId === b[i]!.markerId);
}

interface Runtime {
  key: string;
  runner: PromptRunner;
  specs: PromptSpec[];
  skipped: SkippedSpec[];
  byId: Map<Id, PromptSpec>;
  hasRepeat: boolean;
  hasAction: boolean;
  /** specs use the webcam frames (actions, gaze eyes_closed) */
  wantsViewer: boolean;
  /** gaze specs that want video analysis */
  analysisTargets: PromptSpec[];
  finished: boolean;
  last?: LastResult;
}

export function usePromptChecks(input: PromptChecksInput): PromptChecks {
  const pluginSettings = usePluginSettings();
  const settings = input.settings ?? checksSettings(pluginSettings);
  const on = input.enabled && settings.promptsEnabled;

  const inputRef = React.useRef(input);
  inputRef.current = input;

  // --- the runner, created once per scene (frozen spec list) ---------------------
  const rtRef = React.useRef<Runtime | undefined>(undefined);
  const key = `${input.scene.id}|${settings.speechEnabled ? 1 : 0}${settings.videoAnalysis ? 1 : 0}`;
  if (on && rtRef.current?.key !== key) {
    const sel = selectSpecs(promptSpecs(input.scene.markers), settings);
    const runner = createPromptRunner(sel.specs);
    rtRef.current = {
      key,
      runner,
      specs: [...runner.specs],
      skipped: sel.skipped,
      byId: new Map(sel.specs.map((s) => [s.markerId, s])),
      hasRepeat: sel.specs.some((s) => s.check === "repeat"),
      hasAction: sel.specs.some((s) => s.check === "action"),
      wantsViewer: sel.specs.some(usesWebcam),
      analysisTargets: settings.videoAnalysis
        ? sel.specs.filter((s) => s.check === "gaze" && personPartsFor([s.target]).pose)
        : [],
      finished: false,
    };
  }
  const rt = on && rtRef.current?.key === key ? rtRef.current : undefined;
  const live = rt !== undefined && rt.specs.length > 0;

  const [status, setStatusState] = React.useState<ChecksStatus>(INITIAL_STATUS);
  const statusRef = React.useRef(status);
  const patchStatus = React.useCallback((patch: Partial<ChecksStatus>) => {
    const next = { ...statusRef.current, ...patch };
    if (sameStatus(next, statusRef.current)) return;
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const [active, setActive] = React.useState<PromptSpec[]>([]);
  const activeRef = React.useRef(active);
  const [gazePromptActive, setGazeActive] = React.useState(false);
  const videoTimeRef = React.useRef<number | undefined>(undefined);

  const speechRef = React.useRef<Speech | undefined>(undefined);
  const visionRef = React.useRef<Vision | undefined>(undefined);
  const analyzerRef = React.useRef<{ video: HTMLVideoElement; analyzer: PersonAnalyzer } | undefined>(undefined);

  const viewer = input.viewer;
  const viewerRef = React.useRef(viewer);
  viewerRef.current = viewer;

  // camera status follows the viewer
  React.useEffect(() => {
    patchStatus({ camera: { needed: !!rt?.hasAction, state: viewer?.state ?? "none" } });
  }, [rt, viewer?.state, patchStatus]);

  const uncheckable = React.useCallback((spec: PromptSpec) => {
    const s = statusRef.current;
    const tracker = inputRef.current.trackerConnected ?? (() => gazeStatusNow()?.connection === "connected");
    const a: SensorAvailability = {
      // a model still loading (first download) or failed can't check its prompt
      speech: s.speech.state === "idle" || s.speech.state === "listening",
      vision: s.vision.state === "ready" || s.vision.state === "running",
      camera: viewerRef.current?.state === "on",
      tracker: tracker(),
    };
    return uncheckableReason(spec, a);
  }, []);

  /** forwards runner events, dropping those of prompts that can't be checked */
  const forward = React.useCallback(
    (runtime: Runtime, ev: PromptEvents, before: Map<Id, PromptPhase> | undefined, nowMs: number) => {
      if (ev.results.length === 0 && ev.requests.length === 0) return;
      const replaying = before ? newlyReplaying(before, runtime.runner.progress()) : [];
      const blocked = (spec: PromptSpec) => uncheckable(spec) !== undefined;
      const out = filterPromptEvents(ev, runtime.byId, replaying, blocked, DEFAULT_LEAD_SEC);
      const cur = inputRef.current;
      for (const r of out.results) {
        const spec = runtime.byId.get(r.markerId);
        if (spec) runtime.last = { spec, passed: r.passed, atMs: nowMs };
        try {
          cur.onResult(r);
        } catch (err) {
          console.error("[skilltree] onResult failed", err);
        }
      }
      for (const q of out.requests) {
        try {
          cur.onSeek(q.to);
        } catch (err) {
          console.error("[skilltree] onSeek failed", err);
        }
      }
    },
    [uncheckable],
  );

  // --- speech: model early, mic only around repeat windows ------------------------
  React.useEffect(() => {
    if (!live || !rt.hasRepeat) return;
    let disposed = false;
    const speech = createSpeech({ grammar: grammarFor(rt.specs) });
    speechRef.current = speech;
    const offResult = speech.onResult((r) => rt.runner.feedSpeech(r));
    const offError = speech.onError((e: PerceptionError) => {
      if (!disposed) patchStatus({ speech: { state: "error", message: e.message } });
    });
    patchStatus({ speech: { state: "loading" } });
    speech.load().then(
      () => {
        if (!disposed && statusRef.current.speech.state === "loading") patchStatus({ speech: { state: "idle" } });
      },
      () => undefined, // reported through onError
    );
    return () => {
      disposed = true;
      offResult();
      offError();
      speech.dispose(); // closes the mic, frees the model worker
      if (speechRef.current === speech) speechRef.current = undefined;
      patchStatus({ speech: { state: "off" } });
    };
  }, [live, rt, patchStatus]);

  // --- vision: MediaPipe early, the analyzer bound to the current <video> ----------
  React.useEffect(() => {
    if (!live || rt.analysisTargets.length === 0) return;
    let disposed = false;
    patchStatus({ vision: { state: "loading" } });
    createVision().then(
      (v) => {
        if (disposed) {
          v.dispose();
          return;
        }
        visionRef.current = v; // stays "loading" until the analyzer is bound (models)
      },
      (err: unknown) => {
        if (!disposed) patchStatus({ vision: { state: "error", message: message(err) } });
      },
    );
    return () => {
      disposed = true;
      analyzerRef.current?.analyzer.dispose();
      analyzerRef.current = undefined;
      visionRef.current?.dispose();
      visionRef.current = undefined;
      patchStatus({ vision: { state: "off" } });
    };
  }, [live, rt, patchStatus]);

  // --- webcam frames + gaze samples -> runner -------------------------------------
  const viewerSubscribe = viewer?.subscribe;
  React.useEffect(() => {
    if (!live || !rt.wantsViewer || !viewerSubscribe) return;
    return viewerSubscribe((f) => rt.runner.feedViewer(f));
  }, [live, rt, viewerSubscribe]);

  const gazeSamples = input.gazeSamples ?? subscribeGaze;
  React.useEffect(() => {
    if (!live || !rt.specs.some((s) => s.check === "gaze")) return;
    const present = (): boolean | undefined => {
      const own = inputRef.current.trackerPresent;
      if (own) return own();
      const st = gazeStatusNow();
      return st?.connection === "connected" ? st.present : undefined;
    };
    return gazeSamples((s) => {
      const sample: GazeFeedSample = { t: s.t, valid: s.valid };
      if (s.point !== undefined) sample.point = s.point;
      const p = present();
      if (p !== undefined) sample.present = p;
      rt.runner.feedGaze(sample);
    });
  }, [live, rt, gazeSamples]);

  // --- the tick: runner, mic, analysis, webcam rate --------------------------------
  React.useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let micOpen = false;
    let micFailedThisWindow = false;
    let actionRate = false;
    let binding = false;
    let failures = 0;
    const rate = clampRate(CHECKS_TICK_HZ, CHECKS_TICK_HZ);

    const ensureAnalyzer = (video: HTMLVideoElement | null): void => {
      const vision = visionRef.current;
      if (!vision || !video || binding || statusRef.current.vision.state === "error") return;
      if (analyzerRef.current?.video === video) return;
      analyzerRef.current?.analyzer.dispose();
      analyzerRef.current = undefined;
      binding = true;
      patchStatus({ vision: { state: "loading" } }); // the models download now
      vision.personAnalyzer(video, personPartsFor(rt.analysisTargets.map((s) => s.target))).then(
        (analyzer) => {
          binding = false;
          if (stopped || visionRef.current !== vision) {
            analyzer.dispose();
            return;
          }
          analyzerRef.current = { video, analyzer };
          if (statusRef.current.vision.state === "loading") patchStatus({ vision: { state: "ready" } });
        },
        (err: unknown) => {
          binding = false;
          if (!stopped) patchStatus({ vision: { state: "error", message: message(err) } });
        },
      );
    };

    const setMic = (want: boolean): void => {
      const speech = speechRef.current;
      if (!want) {
        micFailedThisWindow = false;
        if (micOpen) {
          micOpen = false;
          speech?.stop();
          if (statusRef.current.speech.state === "listening") patchStatus({ speech: { state: "idle" } });
        }
        return;
      }
      if (micOpen || micFailedThisWindow || !speech) return;
      micOpen = true;
      speech.start().then(
        () => {
          if (micOpen && !stopped && speech.state === "listening") patchStatus({ speech: { state: "listening" } });
        },
        (err: unknown) => {
          micOpen = false;
          micFailedThisWindow = true;
          if (!stopped) patchStatus({ speech: { state: "error", message: message(err) } });
        },
      );
    };

    const tick = (): void => {
      timer = undefined;
      if (stopped || rt.finished) return;
      const started = performance.now();
      const cur = inputRef.current;
      let t: number | undefined;
      try {
        t = cur.getVideoTime();
      } catch {
        t = undefined;
      }
      if (t !== undefined && Number.isFinite(t)) {
        videoTimeRef.current = t;
        const video = cur.getVideo();
        const box = cur.getVideoBox ? cur.getVideoBox() : videoBoxOf(video);
        if (box) rt.runner.setVideoBox(box);

        const before = new Map(rt.runner.progress().map((p) => [p.spec.markerId, p.phase] as const));
        const ev = rt.runner.update({ videoTime: t, nowMs: started });
        forward(rt, ev, before, started);

        const progress = rt.runner.progress();
        const sched = scheduleChecks(progress, t);

        // microphone
        if (rt.hasRepeat) setMic(sched.mic);

        // video analysis
        if (rt.analysisTargets.length > 0) {
          ensureAnalyzer(video);
          const a = analyzerRef.current;
          if (sched.analysis && a && a.video === video && statusRef.current.vision.state !== "error") {
            const frame = a.analyzer.analyze(t, performance.now(), sched.parts);
            if (frame) {
              failures = 0;
              rt.runner.feedPerson(frame, box);
            } else if (a.analyzer.lastError !== undefined && ++failures >= MAX_ANALYSIS_FAILURES) {
              patchStatus({ vision: { state: "error", message: `Video analysis keeps failing: ${message(a.analyzer.lastError)}` } });
            }
          }
          const vs = statusRef.current.vision.state;
          if (vs === "ready" || vs === "running") {
            const next = sched.analysis && analyzerRef.current ? "running" : "ready";
            if (next !== vs) patchStatus({ vision: { state: next } });
          }
        }

        // webcam rate around action (and gaze eyes_closed) windows
        if (rt.wantsViewer && sched.actionRate !== actionRate) {
          actionRate = sched.actionRate;
          viewerRef.current?.setRate(actionRate ? VIEWER_RATE.action : VIEWER_RATE.idle);
        }

        if (!sameSpecs(sched.active, activeRef.current)) {
          activeRef.current = sched.active;
          setActive(sched.active);
        }
        setGazeActive(sched.gazeActive);
      }
      if (!stopped && !rt.finished) timer = setTimeout(tick, nextDelay(rate, started, performance.now()));
    };
    timer = setTimeout(tick, 0);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (micOpen) speechRef.current?.stop();
      micOpen = false;
      if (actionRate) viewerRef.current?.setRate(VIEWER_RATE.idle);
    };
  }, [live, rt, forward, patchStatus]);

  const finish = React.useCallback(() => {
    const runtime = rtRef.current;
    if (!runtime || runtime.finished || runtime.specs.length === 0) return;
    runtime.finished = true;
    const nowMs = performance.now();
    forward(runtime, runtime.runner.finish({ nowMs }), undefined, nowMs);
    speechRef.current?.stop();
    if (statusRef.current.speech.state === "listening") patchStatus({ speech: { state: "idle" } });
    if (runtime.wantsViewer) viewerRef.current?.setRate(VIEWER_RATE.idle);
    activeRef.current = [];
    setActive([]);
    setGazeActive(false);
  }, [forward, patchStatus]);

  const progress = React.useCallback(() => (rt ? rt.runner.progress() : []), [rt]);
  const regionFor = React.useCallback((spec: PromptSpec) => rt?.runner.regionFor(spec), [rt]);
  const lastResult = React.useCallback(() => rt?.last, [rt]);
  const promptAttention = React.useCallback(
    (nowMs?: number) => (rt && !rt.finished ? promptAttentionFrom(rt.runner.currentGaze(nowMs ?? performance.now())) : undefined),
    [rt],
  );
  const videoTime = React.useCallback(() => videoTimeRef.current, []);

  return {
    specs: rt?.specs ?? [],
    skipped: rt?.skipped ?? [],
    progress,
    active,
    gazePromptActive,
    promptAttention,
    status,
    finish,
    regionFor,
    uncheckable,
    lastResult,
    videoTime,
  };
}
