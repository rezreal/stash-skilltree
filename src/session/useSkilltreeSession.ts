// A Skilltree viewing session driven by any video behind a VideoHandle
// (stash's scene player, see src/stashplayer/). Does what PlayerScreen's
// session did over its own <video>:
// - ticks every 250 ms with handle.currentTime() / paused() / ended() /
//   muted() / volume() and attention from useAttentionSource over the
//   player's container
// - the session's pauseRequested / resumeRequested -> handle.pause({ byPlugin
//   }) / handle.play()
// - handle.onPause(cause): only "other" is the viewer's (pauseByUser); our
//   own pauses, seeks and the clip's end are ignored
// - "ended" -> the session's ended (undecided spend prompts are declined);
//   exposure loops that stash didn't loop start over instead
// - spend prompts pause the video until answered (or their window runs out)
// - a complete session is committed once; stopping a loop saves its
//   exposure (so does leaving the page with unsaved loop minutes)
// - Esc / stop() aborts (loops: saves)
// Nothing is written for any other ending: the session is a transaction.
import type { Graph, NodeKey, Progress, SceneInput, Visibility } from "../core/types.ts";
import {
  buildCommit,
  commitSession,
  createSession,
  exposureTarget,
  exposureTotal,
  isTerminal,
  policyForScene,
  saveExposure,
  step,
} from "../play/index.ts";
import type { Ledger, PromptResult, SessionCommit, SessionState, SpendEvent, Streak, WatchPolicy } from "../play/types.ts";
import { errorText } from "../player/common.tsx";
import { missedSpends, pendingSpend, spendPrompts, spentInSession, type SpendPrompt } from "../player/markers.ts";
import type { AttentionReading } from "../player/gazeView.ts";
import { useAttentionSource, type AttentionSource } from "../player/useAttentionSource.ts";
import type { PlayData } from "../player/usePlayData.ts";
import { isExposureOnly, previousExposure, promptMarkers } from "../player/view.ts";
import type { VideoHandle } from "../stashplayer/videoHandle.ts";
import type { MarkerInput } from "../core/types.ts";
import { isViewerPause, loopWorthSaving, playerRequest, spendDeadlineMs } from "./controller.ts";

export const TICK_MS = 250;

/** what the session started from; later reloads don't change it */
export interface StartSnapshot {
  scene: SceneInput;
  policy: WatchPolicy;
  ledger: Ledger;
  streak: Streak;
  visibility: Map<NodeKey, Visibility>;
  progress: Progress;
  graph: Graph;
}

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; commit?: SessionCommit; exposureSec?: number }
  | { status: "error"; error: string; commit?: SessionCommit };

export interface OpenSpend {
  prompt: SpendPrompt;
  deadlineMs: number;
}

export interface SkilltreeSessionInput {
  scene: SceneInput;
  handle: VideoHandle;
  data: PlayData;
  /** refreshes the shared play data (usePlayData's reload) */
  reload: () => Promise<void>;
  /** defaults to the scene's policy from its tags */
  policy?: WatchPolicy;
  /**
   * The one place each tick's attention passes through, e.g. the checks
   * module's combineAttention(base, presence, required). Default: the
   * reading's own verdict.
   */
  adjustAttention?: (reading: AttentionReading, nowMs: number) => boolean;
  /**
   * Called when the clip ends, before the session evaluates its rules, e.g.
   * the prompt checks' finish() so open prompt windows report their results.
   */
  beforeEnd?: () => void;
}

export interface SkilltreeSession {
  start: StartSnapshot;
  scene: SceneInput;
  policy: WatchPolicy;
  exposureOnly: boolean;
  session: SessionState;
  /** balance minus what this session spent so far */
  balance: number;
  attention: AttentionSource;
  spends: SpendPrompt[];
  prompts: MarkerInput[];
  openSpend: OpenSpend | undefined;
  decideSpend: (prompt: SpendPrompt, accepted: boolean) => void;
  save: SaveState;
  /** Esc / Stop: aborts a watched clip, saves a loop */
  stop: () => void;
  /** commits again after a failed save */
  retrySave: () => void;
  /** saves the loop's minutes again after a failed save */
  retryLoopSave: () => void;
  /** a prompt marker's result (prompt checks) */
  reportPrompt: (result: PromptResult) => void;
  /** jumps the player to `sec` (prompt replays); no-op without a player */
  seek: (sec: number) => void;
  videoTime: number;
  furthest: number;
  /** seconds, from the player once known, else the scene's */
  durationSec: number;
}

export function useSkilltreeSession(input: SkilltreeSessionInput): SkilltreeSession {
  const { handle, data, reload } = input;

  const [start] = React.useState<StartSnapshot>(() => ({
    scene: input.scene,
    policy: input.policy ?? policyForScene(input.scene, data.policyTags),
    ledger: data.ledger,
    streak: data.streak,
    visibility: data.visibility,
    progress: data.progress,
    graph: data.graph,
  }));
  const { scene, policy } = start;
  const exposureOnly = isExposureOnly(policy);
  const spends = React.useMemo(() => spendPrompts(scene.markers), [scene]);
  const prompts = React.useMemo(() => promptMarkers(scene.markers), [scene]);

  const [session, dispatch] = React.useReducer(step, undefined, () =>
    createSession({ scene, policy, nowMs: Date.now(), priorExposureSec: previousExposure(scene) }),
  );
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const decidedRef = React.useRef(new Set<string>());

  const [videoTime, setVideoTime] = React.useState(0);
  const [furthest, setFurthest] = React.useState(0);
  const [duration, setDuration] = React.useState(() => {
    const d = handle.duration();
    return Number.isFinite(d) && d > 0 ? d : scene.durationSec;
  });
  const [openSpend, setOpenSpend] = React.useState<OpenSpend | undefined>(undefined);
  const openSpendRef = React.useRef(openSpend);
  openSpendRef.current = openSpend;
  const [save, setSave] = React.useState<SaveState>({ status: "idle" });
  const saveRef = React.useRef(save);
  saveRef.current = save;
  const [, forceTick] = React.useState(0);

  const balance = start.ledger.balance - spentInSession(session.spends);
  // gaze over the player while a tracker is connected, focus + activity otherwise
  const attention = useAttentionSource(() => handle.container(), data.idleSec);
  const adjustRef = React.useRef(input.adjustAttention);
  adjustRef.current = input.adjustAttention;
  const beforeEndRef = React.useRef(input.beforeEnd);
  beforeEndRef.current = input.beforeEnd;
  const baseRead = attention.read;
  const readAttention = React.useCallback(
    (nowMs: number): boolean => {
      const reading = baseRead(nowMs);
      const adjust = adjustRef.current;
      return adjust ? adjust(reading, nowMs) : reading.attending;
    },
    [baseRead],
  );

  const pauseVideo = React.useCallback(() => {
    if (!handle.paused()) handle.pause({ byPlugin: true });
  }, [handle]);
  const playVideo = React.useCallback(() => {
    if (handle.paused()) void handle.play();
  }, [handle]);

  const decideSpend = React.useCallback(
    (prompt: SpendPrompt, accepted: boolean) => {
      if (decidedRef.current.has(prompt.marker.id)) return;
      decidedRef.current.add(prompt.marker.id);
      const event: SpendEvent = {
        markerId: prompt.marker.id,
        amount: prompt.amount,
        at: handle.video() ? handle.currentTime() : prompt.window.start,
        accepted,
      };
      dispatch({ type: "spend", event });
      if (openSpendRef.current?.prompt.marker.id === prompt.marker.id) {
        // cleared right away, so the play event below isn't taken as playing over the prompt
        openSpendRef.current = undefined;
        setOpenSpend(undefined);
        if (accepted) playVideo();
      }
    },
    [handle, playVideo],
  );

  // the session clock: attention, video time, spend prompts
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const s = sessionRef.current;
      if (isTerminal(s) || !handle.video()) return;
      const nowMs = Date.now();
      const att = readAttention(nowMs);
      const playing = !handle.paused() && !handle.ended();
      const audible = !handle.muted() && handle.volume() > 0;
      const t = handle.currentTime();
      dispatch({ type: "tick", nowMs, videoTime: t, attending: att, playing, audible });
      setVideoTime(t);
      setFurthest((f) => Math.max(f, t));
      forceTick((n) => (n + 1) % 1_000_000);

      // decidedRef also holds decisions the reducer hasn't rendered yet
      const decided = [...decidedRef.current].map((markerId) => ({ markerId, amount: 0, at: 0, accepted: false }));
      const open = openSpendRef.current;
      for (const p of missedSpends(spends, decided, t)) decideSpend(p, false);
      if (open) {
        if (nowMs >= open.deadlineMs) decideSpend(open.prompt, false);
      } else {
        const p = pendingSpend(spends, decided, t);
        if (p) {
          const opened = { prompt: p, deadlineMs: spendDeadlineMs(p, nowMs) };
          openSpendRef.current = opened;
          setOpenSpend(opened);
          pauseVideo();
        }
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [handle, readAttention, spends, decideSpend, pauseVideo]);

  // the session asks to pause (inattention) or resume
  React.useEffect(() => {
    const req = playerRequest(session, handle.paused(), !!openSpendRef.current);
    if (req === "pause") pauseVideo();
    else if (req === "play") playVideo();
  }, [session, handle, pauseVideo, playVideo]);

  // finished: stop the video; a completed session is committed once
  const committing = React.useRef(false);
  const commit = React.useCallback(
    async (prepared?: SessionCommit) => {
      setSave({ status: "saving" });
      let c: SessionCommit | undefined = prepared;
      try {
        c =
          c ??
          buildCommit(
            sessionRef.current,
            scene,
            policy,
            start.streak,
            start.ledger,
            new Date().toISOString(),
            data.dailyEarnCap !== undefined ? { dailyCap: data.dailyEarnCap, dayStartHour: data.dayStartHour } : undefined,
          );
        await commitSession(data.client, c);
      } catch (err) {
        setSave({ status: "error", error: errorText(err), commit: c });
        return;
      }
      await reload();
      setSave({ status: "saved", commit: c });
    },
    [data.client, data.dailyEarnCap, data.dayStartHour, scene, policy, start, reload],
  );
  React.useEffect(() => {
    if (!isTerminal(session)) return;
    pauseVideo();
    setOpenSpend(undefined);
    if (session.phase === "complete" && !committing.current) {
      committing.current = true;
      void commit();
    }
  }, [session.phase, pauseVideo, commit]);

  /**
   * Stopping a loop saves its exposure. Once the stored total reaches the
   * target the loop also counts as complete (ended -> commit).
   */
  const saveLoop = React.useCallback(async (): Promise<"saved" | "completed" | "failed"> => {
    pauseVideo();
    const s = sessionRef.current;
    const exposureSec = s.exposureSec;
    setSave({ status: "saving" });
    try {
      await saveExposure(data.client, scene.id, exposureTotal(s));
    } catch (err) {
      setSave({ status: "error", error: errorText(err) });
      return "failed";
    }
    if (exposureTotal(s) >= exposureTarget(s) && !isTerminal(s)) {
      dispatch({ type: "ended", nowMs: Date.now() });
      return "completed";
    }
    await reload();
    setSave({ status: "saved", exposureSec });
    return "saved";
  }, [data.client, scene, pauseVideo, reload]);

  const stop = React.useCallback(() => {
    const s = sessionRef.current;
    if (isTerminal(s) || saveRef.current.status !== "idle") return;
    if (exposureOnly) {
      void saveLoop();
      return;
    }
    pauseVideo();
    dispatch({ type: "abort", reason: "user", nowMs: Date.now() });
  }, [exposureOnly, saveLoop, pauseVideo]);

  // Esc stops, unless the viewer is typing somewhere
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop]);

  // leaving the page with unsaved loop minutes saves them (best effort); a
  // watched clip left mid-way simply didn't happen
  const clientRef = React.useRef(data.client);
  clientRef.current = data.client;
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  React.useEffect(
    () => () => {
      const s = sessionRef.current;
      if (!exposureOnly || !loopWorthSaving(s, saveRef.current.status === "idle")) return;
      // the shared play data cache is refreshed even after unmount, so the
      // next session starts from the stored total
      void saveExposure(clientRef.current, s.sceneId, exposureTotal(s))
        .then(() => reloadRef.current())
        .catch(() => undefined);
    },
    [exposureOnly],
  );

  // --- player events ---
  React.useEffect(() => {
    const offPlay = handle.onEvent("play", () => {
      if (openSpendRef.current) {
        // played during a spend prompt: it has to be answered first
        pauseVideo();
        return;
      }
      if (!isTerminal(sessionRef.current)) dispatch({ type: "play", nowMs: Date.now() });
    });
    const offPause = handle.onPause((cause) => {
      if (!isViewerPause(cause, sessionRef.current, !!openSpendRef.current)) return;
      dispatch({ type: "pauseByUser", nowMs: Date.now() });
    });
    const offEnded = handle.onEvent("ended", () => {
      if (isTerminal(sessionRef.current)) return;
      if (exposureOnly) {
        // stash didn't loop it (longer than its maximum loop duration): start over
        try {
          handle.player()?.currentTime(0);
        } catch {
          // no player: nothing to restart
        }
        void handle.play();
        return;
      }
      beforeEndRef.current?.();
      const d = handle.duration();
      const end = Number.isFinite(d) && d > 0 ? d : handle.currentTime() || scene.durationSec;
      for (const p of spends) if (!decidedRef.current.has(p.marker.id) && p.window.start < end) decideSpend(p, false);
      dispatch({ type: "ended", nowMs: Date.now() });
    });
    const onDuration = () => {
      const d = handle.duration();
      if (Number.isFinite(d) && d > 0) setDuration(d);
    };
    const offMeta = handle.onEvent("loadedmetadata", onDuration);
    const offDur = handle.onEvent("durationchange", onDuration);
    onDuration();
    return () => {
      offPlay();
      offPause();
      offEnded();
      offMeta();
      offDur();
    };
  }, [handle, exposureOnly, scene, spends, decideSpend, pauseVideo]);

  const reportPrompt = React.useCallback((result: PromptResult) => dispatch({ type: "prompt", result }), []);
  const seek = React.useCallback(
    (sec: number) => {
      try {
        handle.player()?.currentTime(Math.max(0, sec));
      } catch {
        // player between dispose and removal
      }
    },
    [handle],
  );

  return {
    start,
    scene,
    policy,
    exposureOnly,
    session,
    balance,
    attention,
    spends,
    prompts,
    openSpend,
    decideSpend,
    save,
    stop,
    retrySave: () => void commit(save.status === "error" ? save.commit : undefined),
    retryLoopSave: () => void saveLoop(),
    reportPrompt,
    seek,
    videoTime,
    furthest,
    durationSec: duration > 0 ? duration : scene.durationSec,
  };
}
