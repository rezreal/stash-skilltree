// /skilltree/play/:sceneId: our own <video> with a viewing session.
// The session is a transaction: nothing is written unless it completes
// (loops are the exception: stopping one saves its exposure minutes).
import type { Graph, NodeKey, Progress, SceneInput, Visibility } from "../core/types.ts";
import { stashUrl } from "../stash/client.ts";
import {
  buildCommit,
  commitSession,
  createSession,
  exposureTarget,
  exposureTotal,
  fallbackAttending,
  isTerminal,
  policyForScene,
  saveExposure,
  seriesForScene,
  seriesStatus,
  step,
} from "../play/index.ts";
import type { Ledger, SessionCommit, SessionState, SpendEvent, Streak, WatchPolicy } from "../play/types.ts";
import { router } from "./api.ts";
import { createAttentionAdapter } from "./attentionAdapter.ts";
import { Balance, CoinIcon, DataGate, PLAY_ROUTE, RefreshLine, errorText } from "./common.tsx";
import {
  dateLabel,
  formatCoins,
  formatCountdown,
  formatDuration,
  formatFactor,
  formatMinutes,
  formatPercent,
  formatSignedCoins,
  nodeLabel,
} from "./format.ts";
import { HoldButton } from "./HoldButton.tsx";
import { missedSpends, pendingSpend, spendPrompts, spentInSession, type SpendPrompt } from "./markers.ts";
import { timelineDots, timelineSegments } from "./timeline.ts";
import { usePlayData, type PlayData } from "./usePlayData.ts";
import {
  abortReasonText,
  baseLabel,
  fogLabel,
  isExposureOnly,
  newlyCompleted,
  newlyVisible,
  phaseView,
  policyLabel,
  previousExposure,
  promptMarkers,
  promptsNeeded,
  seriesSummaryLine,
  type PauseCause,
} from "./view.ts";

const TICK_MS = 250;

const isFinished = isTerminal;

export function PlayerScreen() {
  const { useParams } = router();
  const { sceneId } = useParams<{ sceneId: string }>();
  const { state, reload } = usePlayData();
  const [attempt, setAttempt] = React.useState(0);

  return (
    <DataGate state={state} onRetry={() => void reload()}>
      {() => {
        if (state.status !== "ready") return null;
        const scene = state.data.graph.scenes.get(sceneId) ?? state.data.library.scenes.find((s) => s.id === sceneId);
        if (!scene) return <SceneMissing sceneId={sceneId} />;
        return (
          <PlayerSession
            key={`${sceneId}#${attempt}`}
            data={state.data}
            scene={scene}
            refreshing={state.refreshing}
            refreshError={state.refreshError}
            reload={reload}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        );
      }}
    </DataGate>
  );
}

function SceneMissing(props: { sceneId: string }) {
  const { Link } = router();
  return (
    <div className="skilltree-play stp-status" role="alert">
      <p>Scene {props.sceneId} is not in the library.</p>
      <Link to={PLAY_ROUTE} className="stp-btn stp-btn-outline">
        Back to choices
      </Link>
    </div>
  );
}

// --- the session -----------------------------------------------------------------------

interface SessionProps {
  data: PlayData;
  scene: SceneInput;
  refreshing?: string;
  refreshError?: string;
  reload: () => Promise<void>;
  onRetry: () => void;
}

/** what the session started from; later reloads don't change it */
interface StartSnapshot {
  scene: SceneInput;
  policy: WatchPolicy;
  ledger: Ledger;
  streak: Streak;
  visibility: Map<NodeKey, Visibility>;
  progress: Progress;
  graph: Graph;
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; commit?: SessionCommit; exposureSec?: number }
  | { status: "error"; error: string; commit?: SessionCommit };

interface OpenSpend {
  prompt: SpendPrompt;
  deadlineMs: number;
}

function PlayerSession(props: SessionProps) {
  const { data, reload } = props;
  const { Link, useHistory } = router();
  const history = useHistory();

  const [start] = React.useState<StartSnapshot>(() => ({
    scene: props.scene,
    policy: policyForScene(props.scene, data.policyTags),
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

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  /** pause() calls we made ourselves, so their events aren't taken as the viewer's */
  const ownPause = React.useRef(false);
  const decidedRef = React.useRef(new Set<string>());

  const [videoTime, setVideoTime] = React.useState(0);
  const [furthest, setFurthest] = React.useState(0);
  const [duration, setDuration] = React.useState(scene.durationSec);
  const [attending, setAttending] = React.useState(true);
  const [openSpend, setOpenSpend] = React.useState<OpenSpend | undefined>(undefined);
  const openSpendRef = React.useRef(openSpend);
  openSpendRef.current = openSpend;
  const [save, setSave] = React.useState<SaveState>({ status: "idle" });
  const [fullscreen, setFullscreen] = React.useState(false);
  const [videoError, setVideoError] = React.useState<string | undefined>(undefined);
  const [, forceTick] = React.useState(0);

  const balance = start.ledger.balance - spentInSession(session.spends);

  const pauseVideo = React.useCallback(() => {
    const v = videoRef.current;
    if (v && !v.paused) {
      ownPause.current = true;
      v.pause();
    }
  }, []);
  const playVideo = React.useCallback(() => {
    const v = videoRef.current;
    if (v && v.paused) v.play().catch(() => undefined);
  }, []);

  const decideSpend = React.useCallback(
    (prompt: SpendPrompt, accepted: boolean) => {
      if (decidedRef.current.has(prompt.marker.id)) return;
      decidedRef.current.add(prompt.marker.id);
      const v = videoRef.current;
      const event: SpendEvent = {
        markerId: prompt.marker.id,
        amount: prompt.amount,
        at: v ? v.currentTime : prompt.window.start,
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
    [playVideo],
  );

  // native fullscreen is replaced by ours (on the container, so overlays stay visible)
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.setAttribute("controlslist", "nofullscreen noremoteplayback");
    v.setAttribute("disablepictureinpicture", "");
  }, []);

  React.useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current && containerRef.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // the session clock: attention, video time, spend prompts
  React.useEffect(() => {
    const adapter = createAttentionAdapter();
    const id = window.setInterval(() => {
      const v = videoRef.current;
      const s = sessionRef.current;
      if (!v || isFinished(s)) return;
      const nowMs = Date.now();
      const att = fallbackAttending({ ...adapter.read(), nowMs, idleSec: data.idleSec });
      const playing = !v.paused && !v.ended;
      const audible = !v.muted && v.volume > 0;
      const t = v.currentTime;
      dispatch({ type: "tick", nowMs, videoTime: t, attending: att, playing, audible });
      setVideoTime(t);
      setFurthest((f) => Math.max(f, t));
      setAttending(att);
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
          const windowSec = Math.min(60, Math.max(5, p.window.end - p.window.start));
          const opened = { prompt: p, deadlineMs: nowMs + windowSec * 1000 };
          openSpendRef.current = opened;
          setOpenSpend(opened);
          pauseVideo();
        }
      }
    }, TICK_MS);
    return () => {
      window.clearInterval(id);
      adapter.cleanup();
    };
  }, [data.idleSec, spends, decideSpend, pauseVideo]);

  // the session asks to pause (inattention) or resume
  React.useEffect(() => {
    const v = videoRef.current;
    if (!v || isFinished(session)) return;
    if (session.pauseRequested && !v.paused) {
      pauseVideo();
    } else if (session.resumeRequested && v.paused && !openSpendRef.current) {
      playVideo();
    }
  }, [session, pauseVideo, playVideo]);

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
            data.dailyEarnCap !== undefined
              ? { dailyCap: data.dailyEarnCap, dayStartHour: data.dayStartHour }
              : undefined,
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
    if (!isFinished(session)) return;
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
    if (exposureTotal(s) >= exposureTarget(s) && !isFinished(s)) {
      dispatch({ type: "ended", nowMs: Date.now() });
      return "completed";
    }
    await reload();
    setSave({ status: "saved", exposureSec });
    return "saved";
  }, [data.client, scene, pauseVideo, reload]);

  const stop = React.useCallback(() => {
    const s = sessionRef.current;
    if (isFinished(s) || save.status !== "idle") return;
    if (exposureOnly) {
      void saveLoop();
      return;
    }
    pauseVideo();
    dispatch({ type: "abort", reason: "user", nowMs: Date.now() });
  }, [exposureOnly, saveLoop, pauseVideo, save.status]);

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

  const leave = () => {
    if (exposureOnly && session.exposureSec > 0 && save.status === "idle" && !isFinished(session)) {
      // a loop that reached its target stays to show the summary
      void saveLoop().then((r) => {
        if (r === "saved") history.push(PLAY_ROUTE);
      });
    } else {
      history.push(PLAY_ROUTE);
    }
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  // --- video events ---
  const onPlay = () => {
    if (openSpendRef.current) {
      // the viewer pressed play during a spend prompt: it has to be answered first
      pauseVideo();
      return;
    }
    if (!isFinished(sessionRef.current)) dispatch({ type: "play", nowMs: Date.now() });
  };
  const onPause = () => {
    const v = videoRef.current;
    if (ownPause.current) {
      ownPause.current = false;
      return;
    }
    if (!v || v.ended || isFinished(sessionRef.current)) return;
    dispatch({ type: "pauseByUser", nowMs: Date.now() });
  };
  const onEnded = () => {
    const v = videoRef.current;
    const end = v ? v.duration || v.currentTime : scene.durationSec;
    for (const p of spends) if (!decidedRef.current.has(p.marker.id) && p.window.start < end) decideSpend(p, false);
    dispatch({ type: "ended", nowMs: Date.now() });
  };

  const cause: PauseCause = openSpend
    ? "spend"
    : session.pausedBy === "user"
      ? "user"
      : session.pausedBy === "inattention"
        ? "attention"
        : undefined;
  const phase = phaseView(session.phase, policy, cause);
  const nodes = data.graph.sceneNodes.get(scene.id) ?? start.graph.sceneNodes.get(scene.id) ?? [];
  const performerNames = scene.performerIds
    .map((id) => data.graph.performers.get(id)?.name)
    .filter((n): n is string => !!n);
  const subtitle = [performerNames.join(", "), nodes.map(nodeLabel).join(", "), dateLabel(scene.date)]
    .filter((s) => s.length > 0)
    .join(" · ");
  const showInattention = session.phase === "paused" && session.pausedBy === "inattention" && !openSpend;
  const abortIn =
    session.pausedSinceMs !== undefined ? policy.abortSec - (Date.now() - session.pausedSinceMs) / 1000 : policy.abortSec;
  const effectiveDuration = duration > 0 ? duration : scene.durationSec;

  return (
    <div className="skilltree-play stp-player">
      <header className="stp-header stp-player-header">
        <button type="button" className="stp-back" onClick={leave}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back to choices
        </button>
        <div className="stp-player-title">
          <span className="stp-strong">{scene.title || `Scene ${scene.id}`}</span>
          <span className="stp-small stp-mono stp-muted">{subtitle}</span>
        </div>
        <div className="stp-spacer" />
        <Balance balance={balance} />
        <button
          type="button"
          className="stp-btn stp-btn-outline stp-stop"
          onClick={stop}
          disabled={isFinished(session) || save.status !== "idle"}
          aria-keyshortcuts="Escape"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <rect x="5" y="5" width="14" height="14" rx="1" />
          </svg>
          {exposureOnly ? "Stop & save · Esc" : "Stop · Esc"}
        </button>
      </header>
      <RefreshLine refreshing={props.refreshing} refreshError={props.refreshError} onRetry={() => void reload()} />

      <main className="stp-main stp-player-main">
        <section className="stp-primary" aria-label="Video">
          <div ref={containerRef} className={`stp-stage${fullscreen ? " is-fullscreen" : ""}`}>
            <video
              ref={videoRef}
              className="stp-video"
              src={stashUrl(`scene/${scene.id}/stream`)}
              controls
              playsInline
              preload="metadata"
              loop={exposureOnly}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onEnded}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration;
                if (Number.isFinite(d) && d > 0) setDuration(d);
              }}
              onError={() => {
                setVideoError("The video could not be loaded.");
                if (!isFinished(sessionRef.current) && !exposureOnly) dispatch({ type: "abort", reason: "error", nowMs: Date.now() });
              }}
            />
            <button
              type="button"
              className="stp-fs-btn"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                {fullscreen ? (
                  <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                ) : (
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                )}
              </svg>
            </button>

            {session.phase === "ready" && !videoError && (
              <div className="stp-hint-banner" role="status">
                Press play to start. Nothing is saved until the clip is complete.
              </div>
            )}
            {session.phase === "grace" && !openSpend && (
              <div className="stp-hint-banner is-warning" role="status">
                Look back at the video
              </div>
            )}

            {showInattention && (
              <div className="stp-overlay" role="alertdialog" aria-label="Paused">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="stp-orange" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1" />
                  <rect x="14" y="5" width="4" height="14" rx="1" />
                </svg>
                <div className="stp-overlay-title">Paused: you looked away</div>
                <div className="stp-soft">Come back to the video to continue.</div>
                <div className="stp-small stp-mono stp-orange">
                  aborts in {formatCountdown(abortIn)} · this attempt won’t count
                </div>
              </div>
            )}

            {openSpend && !isFinished(session) && (
              <SpendDialog
                open={openSpend}
                balance={balance}
                onAccept={() => decideSpend(openSpend.prompt, true)}
                onDecline={() => decideSpend(openSpend.prompt, false)}
              />
            )}

            {session.phase === "aborted" && (
              <div className="stp-overlay" role="alertdialog" aria-label="Aborted">
                <div className="stp-overlay-title">This attempt doesn’t count</div>
                <div className="stp-soft">{videoError ?? abortReasonText(session.abortReason)}</div>
                <div className="stp-small stp-muted">Nothing was saved.</div>
                <div className="stp-overlay-actions">
                  <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange">
                    Back to choices
                  </Link>
                  <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetry}>
                    Try again
                  </button>
                </div>
              </div>
            )}

            {session.phase === "complete" && (
              <CompleteSummary
                start={start}
                data={data}
                session={session}
                save={save}
                promptCount={prompts.length}
                onRetrySave={() => void commit(save.status === "error" ? save.commit : undefined)}
              />
            )}

            {exposureOnly && save.status !== "idle" && session.phase !== "complete" && (
              <LoopSaved
                save={save}
                previousSec={previousExposure(scene)}
                minMinutes={policy.minMinutes}
                onRetry={() => void saveLoop()}
                onAgain={props.onRetry}
              />
            )}
          </div>

          <Timeline
            session={session}
            scene={scene}
            videoTime={videoTime}
            furthest={furthest}
            durationSec={effectiveDuration}
            showAttention={policy.rules.includes("attention")}
          />
        </section>

        <aside className="stp-side" aria-label="Session status">
          <div className="stp-panel">
            <h2 className="stp-caps">State</h2>
            <div className={`stp-state stp-tone-${phase.tone}`}>{phase.label}</div>
            <div className="stp-small stp-muted stp-lh">{phase.hint}</div>
          </div>

          <CountsWhen
            session={session}
            policy={policy}
            prompts={prompts.length}
            previousExposureSec={previousExposure(scene)}
          />

          <div className="stp-panel">
            <h2 className="stp-caps">Sensors</h2>
            <div className="stp-row">
              <span>Attention: fallback (focus + activity)</span>
              <span className={attending ? "stp-blue" : "stp-orange"}>{attending ? "with you" : "away"}</span>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}

// --- overlays -------------------------------------------------------------------------

function SpendDialog(props: { open: OpenSpend; balance: number; onAccept: () => void; onDecline: () => void }) {
  const { prompt, deadlineMs } = props.open;
  const left = (deadlineMs - Date.now()) / 1000;
  const affordable = props.balance >= prompt.amount;
  return (
    <div className="stp-overlay is-light">
      <div className="stp-dialog" role="dialog" aria-modal="true" aria-labelledby="stp-spend-title">
        <div className="stp-dialog-head">
          <span className="stp-gold">
            <CoinIcon size={34} />
          </span>
          <div className="stp-col">
            <span id="stp-spend-title" className="stp-dialog-title">
              Send {formatCoins(prompt.amount)} stashcoins
            </span>
            <span className="stp-small stp-mono stp-muted">
              marker {formatDuration(prompt.window.start)} · confirm within {formatCountdown(left)}
            </span>
          </div>
        </div>
        <div className="stp-balance-row stp-mono">
          <span>balance</span>
          <span>
            {formatCoins(props.balance)} → {formatCoins(props.balance - prompt.amount)}
          </span>
        </div>
        {affordable ? (
          <HoldButton
            label="Hold to send"
            hint="Press and hold for a second (mouse, touch, or hold Space)"
            autoFocus
            onConfirm={props.onAccept}
          />
        ) : (
          <p className="stp-error stp-small">
            You have {formatCoins(props.balance)} stashcoins, not enough for this prompt.
          </p>
        )}
        <button type="button" className="stp-btn stp-btn-outline" onClick={props.onDecline}>
          Decline · this clip fails
        </button>
      </div>
    </div>
  );
}

function CompleteSummary(props: {
  start: StartSnapshot;
  data: PlayData;
  session: SessionState;
  save: SaveState;
  promptCount: number;
  onRetrySave: () => void;
}) {
  const { start, data, session, save } = props;
  const { Link } = router();
  const commit = save.status === "saved" || save.status === "error" ? save.commit : undefined;
  const saved = save.status === "saved";

  const completed = saved ? newlyCompleted(start.progress, data.progress) : [];
  const revealed = saved ? newlyVisible(start.visibility, data.visibility) : [];
  const nodes = data.graph.sceneNodes.get(start.scene.id) ?? [];
  const title =
    completed.length > 0
      ? `${completed.map(nodeLabel).join(", ")} complete`
      : nodes.length > 0
        ? `Counts toward ${nodes.map(nodeLabel).join(", ")}`
        : "Clip complete";

  const b = commit?.breakdown;
  const passed = session.prompts.filter((p) => p.passed).length;
  const quality = [
    start.policy.rules.includes("attention") ? `attention ${formatPercent(session.attendedFraction)}` : undefined,
    props.promptCount > 0 ? `prompts ${passed}/${props.promptCount}` : undefined,
  ]
    .filter((s) => s !== undefined)
    .join(", ");
  const before = start.ledger.balance;
  const after = commit ? before + commit.earnedNow - commit.spentNow : before;
  // daily series this scene is a part of, judged on the reloaded library
  const seriesLines = saved
    ? seriesForScene(data.library.series, start.scene.id).map((s) =>
        seriesSummaryLine(s, seriesStatus(s, data.graph.scenes, new Date(), data.dayStartHour)),
      )
    : [];

  return (
    <div className="stp-overlay is-dark">
      <div className="stp-summary" role="dialog" aria-labelledby="stp-summary-title">
        <div className="stp-col">
          <span className="stp-eyebrow">Clip counted</span>
          <span id="stp-summary-title" className="stp-summary-title">
            {title}
          </span>
        </div>
        {save.status === "saving" && (
          <p className="stp-soft" role="status">
            <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
            Saving…
          </p>
        )}
        {save.status === "error" && (
          <div role="alert" className="stp-col">
            <p className="stp-error">Could not save: {save.error}</p>
            <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetrySave}>
              Try saving again
            </button>
          </div>
        )}
        {b && commit && (
          <div className="stp-breakdown">
            <div className="stp-row">
              <span className="stp-soft">{baseLabel(start.scene.durationSec)}</span>
              <span className="stp-mono">{Number(b.base.toFixed(1))}</span>
            </div>
            <div className="stp-row">
              <span className="stp-soft">Quality{quality ? ` · ${quality}` : ""}</span>
              <span className="stp-mono">{formatFactor(b.quality)}</span>
            </div>
            {b.rewardMult !== 1 && (
              <div className="stp-row">
                <span className="stp-soft">Clip multiplier</span>
                <span className="stp-mono">{formatFactor(b.rewardMult)}</span>
              </div>
            )}
            {b.repeatFactor !== 1 && (
              <div className="stp-row">
                <span className="stp-soft">Repeat · watched {start.scene.completions} times before</span>
                <span className="stp-mono">{formatFactor(b.repeatFactor)}</span>
              </div>
            )}
            {b.streakBonus !== 1 && (
              <div className="stp-row">
                <span className="stp-soft">Streak · day {start.streak.days}</span>
                <span className="stp-mono">{formatFactor(b.streakBonus)}</span>
              </div>
            )}
            <div className="stp-row stp-row-sep">
              <span className="stp-soft">Earned</span>
              <span className="stp-mono stp-blue">{formatSignedCoins(commit.earnedNow)}</span>
            </div>
            {commit.spentNow > 0 && (
              <div className="stp-row">
                <span className="stp-soft">Spent in this clip</span>
                <span className="stp-mono stp-orange">{formatSignedCoins(-commit.spentNow)}</span>
              </div>
            )}
            <div className="stp-row stp-strong">
              <span>Balance</span>
              <span className="stp-mono stp-gold-text">
                {formatCoins(before)} → {formatCoins(after)}
              </span>
            </div>
          </div>
        )}
        {seriesLines.map((line) => (
          <div key={line} className="stp-fog-line stp-series-line">
            <span className="stp-fog-dot" aria-hidden="true" />
            {line}
          </div>
        ))}
        {saved && revealed.length > 0 && (
          <div className="stp-fog-line">
            <span className="stp-fog-dot" aria-hidden="true" />
            Out of the fog: {revealed.map((k) => fogLabel(k, data.visibility.get(k))).join(" · ")}
          </div>
        )}
        <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange stp-btn-lg">
          Choose next
        </Link>
      </div>
    </div>
  );
}

function LoopSaved(props: {
  save: SaveState;
  previousSec: number;
  minMinutes?: number;
  onRetry: () => void;
  onAgain: () => void;
}) {
  const { save } = props;
  const { Link } = router();
  return (
    <div className="stp-overlay is-dark">
      <div className="stp-summary" role="dialog" aria-labelledby="stp-loop-title">
        {save.status === "saving" && (
          <p className="stp-soft" role="status">
            <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
            Saving the minutes…
          </p>
        )}
        {save.status === "error" && (
          <div role="alert" className="stp-col">
            <p className="stp-error">Could not save the minutes: {save.error}</p>
            <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetry}>
              Try again
            </button>
          </div>
        )}
        {save.status === "saved" && (
          <>
            <div className="stp-col">
              <span className="stp-eyebrow">Loop saved</span>
              <span id="stp-loop-title" className="stp-summary-title">
                {formatMinutes(save.exposureSec ?? 0)} added
              </span>
            </div>
            <div className="stp-breakdown">
              <div className="stp-row">
                <span className="stp-soft">Total exposure</span>
                <span className="stp-mono">
                  {formatMinutes(props.previousSec + (save.exposureSec ?? 0))}
                  {props.minMinutes ? ` / ${props.minMinutes} min` : ""}
                </span>
              </div>
            </div>
          </>
        )}
        <div className="stp-overlay-actions">
          <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange">
            Choose next
          </Link>
          {save.status === "saved" && (
            <button type="button" className="stp-btn stp-btn-outline" onClick={props.onAgain}>
              Play again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- side panel and timeline ---------------------------------------------------------------

function CountsWhen(props: { session: SessionState; policy: WatchPolicy; prompts: number; previousExposureSec: number }) {
  const { session, policy } = props;
  const bar = (fraction: number) => (
    <div className="stp-bar" aria-hidden="true">
      <div style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
    </div>
  );
  const passed = session.prompts.filter((p) => p.passed).length;
  const answered = session.prompts.length;
  const need = promptsNeeded(policy, props.prompts);
  const exposureMin = (props.previousExposureSec + session.exposureSec) / 60;

  return (
    <div className="stp-panel">
      <h2 className="stp-caps">Counts when</h2>
      {policy.rules.includes("attention") && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Attended</span>
            <span className="stp-mono">
              {formatPercent(session.attendedFraction)} <span className="stp-muted">/ {formatPercent(policy.attentionMin)}</span>
            </span>
          </div>
          {bar(policy.attentionMin > 0 ? session.attendedFraction / policy.attentionMin : 1)}
        </div>
      )}
      {policy.rules.includes("prompts") && props.prompts > 0 && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Prompts followed</span>
            <span className="stp-mono">
              {passed} of {answered} <span className="stp-muted">/ need {need} of {props.prompts}</span>
            </span>
          </div>
          {bar(need > 0 ? passed / need : 1)}
        </div>
      )}
      {policy.rules.includes("exposure") && (
        <div className="stp-col stp-gap-sm">
          <div className="stp-row">
            <span>Exposure</span>
            <span className="stp-mono">
              {Math.floor(exposureMin)} min{policy.minMinutes ? <span className="stp-muted"> / {policy.minMinutes} min</span> : null}
            </span>
          </div>
          {policy.minMinutes ? bar(exposureMin / policy.minMinutes) : null}
        </div>
      )}
      <div className="stp-small stp-mono stp-muted">{policyLabel(policy)}</div>
    </div>
  );
}

function Timeline(props: {
  session: SessionState;
  scene: SceneInput;
  videoTime: number;
  furthest: number;
  durationSec: number;
  showAttention: boolean;
}) {
  const { session, scene, durationSec } = props;
  const segments = timelineSegments(session.attended, durationSec, Math.max(props.furthest, props.videoTime));
  const dots = timelineDots(scene.markers, session.prompts, session.spends, props.videoTime, durationSec);
  const head = durationSec > 0 ? Math.min(100, (props.videoTime / durationSec) * 100) : 0;
  return (
    <div className="stp-timeline">
      {props.showAttention && (
        <div className="stp-track" role="img" aria-label={`Attended ${formatPercent(session.attendedFraction)} of the clip`}>
          {segments.map((s, i) => (
            <div key={i} className={`stp-track-seg is-${s.kind}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} />
          ))}
          <div className="stp-playhead" style={{ left: `${head}%` }} />
        </div>
      )}
      {dots.length > 0 && (
        <div className="stp-dots">
          {dots.map((d) => (
            <div
              key={d.markerId}
              className={`stp-tl-dot is-${d.kind} is-${d.state}`}
              style={{ left: `${d.left}%` }}
              title={`${d.title} · ${d.state}`}
            />
          ))}
          {!props.showAttention && <div className="stp-playhead" style={{ left: `${head}%` }} />}
        </div>
      )}
      <div className="stp-legend">
        <span className="stp-mono stp-text">
          {formatDuration(props.videoTime)} / {formatDuration(durationSec)}
        </span>
        {props.showAttention && (
          <>
            <span><span className="stp-seg-swatch is-attended" />attended</span>
            <span><span className="stp-seg-swatch is-missed" />not attended</span>
          </>
        )}
        {dots.some((d) => d.kind === "prompt") && (
          <>
            <span><span className="stp-dot-swatch is-passed" />prompt met</span>
            <span><span className="stp-dot-swatch is-failed" />missed</span>
          </>
        )}
        {dots.some((d) => d.kind === "spend") && (
          <span><span className="stp-dot-swatch is-accepted" />spent</span>
        )}
        {dots.length > 0 && (
          <span><span className="stp-dot-swatch is-active" />active</span>
        )}
      </div>
    </div>
  );
}
