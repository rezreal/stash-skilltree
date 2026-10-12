// The Skilltree session UI over stash's scene player, rendered by
// registerStashPlayerPatch inside the player's OverlayHost:
// - SkilltreeStashOverlay: finds the scene in the tree (the shared,
//   cached play data, so coming from the choice screen doesn't reload) and
//   holds playback while the library loads; clips outside the tree get a
//   clear message and no session.
// - SessionOverlay: one session (useSkilltreeSession) with a compact top
//   banner (state, notices, coins, score chip -> sensors panel, Stop), the
//   overlays, a slim timeline above the control bar, the gaze dot, snap
//   flashes and the gaze callout. The pause lock follows the policy.
// - Live checks (src/checks) and the track rule (src/player/useTrack.ts),
//   decisions in ./checksWiring.ts: the camera gate before the session when
//   the webcam is required, presence AND gaze as the tick's attention (gaze
//   suspended during gaze prompts), prompt checks on the video clock, the
//   distance-sensor guide over the video and its score fed to the session.
// Resources: the webcam is reference counted by the checks module and turns
// off ~1 s after the session ends or the overlay unmounts (leaving the scene
// page); usePromptChecks frees the microphone and the speech / vision models
// when the session ends or unmounts; the distance sensor stays connected
// (shared across pages), only this clip's subscription ends.
import type { ReactNode } from "react";
import type { SceneInput } from "../core/types.ts";
import { CameraGate, useCameraPermission } from "../checks/CameraGate.tsx";
import { ChecksSensorRows } from "../checks/ChecksSensorRows.tsx";
import { PromptBanner } from "../checks/PromptBanner.tsx";
import { checksSettings } from "../checks/settings.ts";
import { usePromptChecks, type PromptChecks } from "../checks/usePromptChecks.ts";
import { useViewerPresence, type ViewerPresence } from "../checks/useViewerPresence.ts";
import { isTerminal } from "../play/index.ts";
import { router } from "../player/api.ts";
import { CoinIcon, PLAY_ROUTE } from "../player/common.tsx";
import { FlashOverlay } from "../player/FlashOverlay.tsx";
import { formatCoins, formatCountdown } from "../player/format.ts";
import { GazeDot } from "../player/GazeDot.tsx";
import { SensorsPanel } from "../player/SensorsPanel.tsx";
import { TrackGuide } from "../player/TrackGuide.tsx";
import { usePlayData, type PlayData } from "../player/usePlayData.ts";
import { useSnapEvents, useSnapFlashIntensity } from "../player/useSnapEvents.ts";
import { useTrackSession, type TrackHandle } from "../player/useTrack.ts";
import { phaseView, previousExposure } from "../player/view.ts";
import { OverlayInteractive } from "../stashplayer/OverlayHost.tsx";
import type { StashPlayerContext } from "../stashplayer/patch.tsx";
import { lockUserPause } from "../stashplayer/pauseLock.ts";
import { lockPlaybackRate } from "../stashplayer/rateLock.ts";
import type { VideoHandle } from "../stashplayer/videoHandle.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";
import {
  attentionTexts,
  needsCameraGate,
  presenceWanted,
  sessionAdjuster,
  sessionAttending,
  TRACK_REPORT_MS,
  trackScoreToReport,
} from "./checksWiring.ts";
import { bannerNotice, findTreeScene, scoreChipView, viewPauseCause, wantsPauseLock } from "./controller.ts";
import { GazeCallout, useGazeCallout } from "./GazeCallout.tsx";
import { AbortedOverlay, CompleteSummary, InattentionOverlay, LoopSaved, SpendDialog } from "./overlays.tsx";
import { CountsWhen, SlimTimeline, useRecentChange } from "./panels.tsx";
import { useSkilltreeSession } from "./useSkilltreeSession.ts";

/** the root of everything we draw inside the player (scopes the play CSS) */
function Root(props: { children?: ReactNode }) {
  return <div className="skilltree-play stp-sp">{props.children}</div>;
}

function Notice(props: { tone?: "warning" | "error"; children?: ReactNode; interactive?: boolean }) {
  const cls = `stp-sp-message${props.tone ? ` is-${props.tone}` : ""}`;
  if (props.interactive) return <OverlayInteractive className={cls}>{props.children}</OverlayInteractive>;
  return (
    <div className={cls} role="status">
      {props.children}
    </div>
  );
}

export function SkilltreeStashOverlay(props: { ctx: StashPlayerContext }) {
  const { handle, sceneId } = props.ctx;
  const { state, reload } = usePlayData();
  const [attempt, setAttempt] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  // the camera gate: only when the webcam is required (default); playback is
  // held until a person is in view of the running camera
  const webcamRequired = checksSettings(usePluginSettings()).webcamRequired;
  const [gatePassed, setGatePassed] = React.useState(false);
  const scene = state.status === "ready" ? findTreeScene(state.data, sceneId) : undefined;
  const gate = !!scene && needsCameraGate(webcamRequired, gatePassed);
  const waiting = state.status === "loading" || gate;

  // the session can't watch yet: hold playback until the library (and the gate) are there
  React.useEffect(() => {
    if (!waiting) return;
    let held = false;
    const hold = () => {
      if (handle.paused()) return;
      held = true;
      handle.pause({ byPlugin: true });
    };
    hold();
    const off = handle.onEvent("play", hold);
    return () => {
      off();
      if (held) void handle.play();
    };
  }, [handle, waiting]);

  const retry = React.useCallback(() => {
    try {
      handle.player()?.currentTime(0);
    } catch {
      // no player: the new session starts wherever the video is
    }
    // the ended session turned the camera off: the gate checks it again
    setGatePassed(false);
    setAttempt((n) => n + 1);
  }, [handle]);

  if (state.status === "loading") {
    return (
      <Root>
        <Notice>
          <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
          Skilltree: {state.message}
        </Notice>
      </Root>
    );
  }
  if (state.status === "error") {
    return (
      <Root>
        <Notice tone="error" interactive>
          <span role="alert">Skilltree could not load the library: {state.error}</span>
          <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={() => void reload()}>
            Retry
          </button>
        </Notice>
      </Root>
    );
  }
  if (!scene) {
    if (dismissed) return null;
    return (
      <Root>
        <NotInTree onDismiss={() => setDismissed(true)} />
      </Root>
    );
  }
  if (gate) {
    // takes its own clicks (.stc-gate sets pointer-events: auto)
    return (
      <Root>
        <CameraGate required onReady={() => setGatePassed(true)} />
      </Root>
    );
  }
  return (
    <Root>
      <SessionOverlay
        key={`${scene.id}#${attempt}`}
        handle={handle}
        scene={scene}
        data={state.data}
        reload={reload}
        onRetry={retry}
      />
    </Root>
  );
}

function NotInTree(props: { onDismiss: () => void }) {
  const { Link } = router();
  return (
    <Notice tone="warning" interactive>
      <span role="alert">
        <span className="stp-strong">This clip isn’t part of the tree.</span> It plays as usual; nothing is tracked or saved.
      </span>
      <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange stp-btn-sm">
        Back to choices
      </Link>
      <button type="button" className="stp-sp-close" onClick={props.onDismiss} aria-label="Dismiss">
        ×
      </button>
    </Notice>
  );
}

function SessionOverlay(props: {
  handle: VideoHandle;
  scene: SceneInput;
  data: PlayData;
  reload: () => Promise<void>;
  onRetry: () => void;
}) {
  const { handle, data } = props;
  const settings = checksSettings(usePluginSettings());
  const required = settings.webcamRequired;
  const permission = useCameraPermission();

  // the session reads these on its ticks and at the clip's end; they are
  // created after it (they depend on its phase and callbacks)
  const viewerRef = React.useRef<ViewerPresence | undefined>(undefined);
  const checksRef = React.useRef<PromptChecks | undefined>(undefined);
  const trackRef = React.useRef<TrackHandle | undefined>(undefined);
  const requiredRef = React.useRef(required);
  requiredRef.current = required;
  const adjustAttention = React.useMemo(
    () =>
      sessionAdjuster(() => ({
        presence: viewerRef.current?.present(),
        required: requiredRef.current,
        gazePromptActive: checksRef.current?.gazePromptActive ?? false,
      })),
    [],
  );
  const lastTrackRef = React.useRef<number | undefined>(undefined);
  const reportTrackRef = React.useRef<(score: number) => void>(() => undefined);
  const flushTrack = React.useCallback(() => {
    const score = trackScoreToReport(trackRef.current, lastTrackRef.current);
    if (score === undefined) return;
    lastTrackRef.current = score;
    reportTrackRef.current(score);
  }, []);
  // the clip ended: open prompt windows report, the final track score goes in
  const beforeEnd = React.useCallback(() => {
    checksRef.current?.finish();
    flushTrack();
  }, [flushTrack]);

  const s = useSkilltreeSession({ scene: props.scene, handle, data, reload: props.reload, adjustAttention, beforeEnd });
  const { session, policy, scene, openSpend, attention, exposureOnly } = s;
  reportTrackRef.current = s.reportTrack;
  const finished = isTerminal(session);
  const snaps = useSnapEvents(scene.id, scene.interactive);
  const flashIntensity = useSnapFlashIntensity();
  const [panelOpen, setPanelOpen] = React.useState(false);

  // watched clips can't be paused by the viewer while the session runs; loops can
  const lock = wantsPauseLock(policy, session.phase);
  React.useEffect(() => (lock ? lockUserPause(handle) : undefined), [handle, lock]);
  // ranked play runs at 1x: a faster clip would ask for less attention
  React.useEffect(() => lockPlaybackRate(handle), [handle]);

  const getContainer = React.useCallback(() => handle.container(), [handle]);
  const getVideoTime = React.useCallback(() => (handle.video() ? handle.currentTime() : undefined), [handle]);
  const getVideo = React.useCallback(() => handle.video(), [handle]);

  // --- checks: webcam presence + prompt checks ---
  const viewer = useViewerPresence({ enabled: presenceWanted({ required, permission, finished }) });
  viewerRef.current = viewer;
  // no getVideoBox: the hook measures the <video> itself
  const checks = usePromptChecks({
    scene,
    enabled: settings.promptsEnabled && !finished,
    getVideoTime,
    getVideo,
    viewer,
    onResult: s.reportPrompt,
    onSeek: s.seek,
  });
  checksRef.current = checks;

  // --- track: the distance-sensor guide and its score ---
  const runningRef = React.useRef(!finished);
  runningRef.current = !finished;
  const isPlaying = React.useCallback(() => runningRef.current && !handle.paused() && !handle.ended(), [handle]);
  const { track } = useTrackSession(scene.id, getVideoTime, {
    enabled: policy.rules.includes("track") || scene.interactive,
    isPlaying,
  });
  trackRef.current = track;
  // only while scored (calibrated sensor sending): no sensor -> the track rule stays unscored
  React.useEffect(() => {
    if (!track || finished) return;
    const id = window.setInterval(flushTrack, TRACK_REPORT_MS);
    return () => window.clearInterval(id);
  }, [track, finished, flushTrack]);

  const presence = viewer.present();
  const texts = attentionTexts(attention.reading, presence, required);
  const attendingNow = sessionAttending(attention.reading, presence, { required, gazePromptActive: checks.gazePromptActive });

  const phase = phaseView(session.phase, policy, viewPauseCause(!!openSpend, session.pausedBy));
  const pauseAttemptRecent = useRecentChange(session.pauseAttempts, 4000);
  const notice = bannerNotice({
    phase: session.phase,
    spendOpen: !!openSpend,
    pauseAttemptRecent,
    graceText: texts.grace,
    exposureOnly,
  });
  const chip = scoreChipView(session, policy, attendingNow);

  const showInattention = session.phase === "paused" && session.pausedBy === "inattention" && !openSpend;
  const graceWarning = session.phase === "grace" && !openSpend;
  const callout = useGazeCallout(showInattention || graceWarning, getContainer);
  const pauseText = texts.pause;
  const abortIn =
    session.pausedSinceMs !== undefined ? policy.abortSec - (Date.now() - session.pausedSinceMs) / 1000 : policy.abortSec;

  const promptBanner: ReactNode = checks.specs.length > 0 ? <PromptBanner checks={checks} /> : null;
  const sensorRows: ReactNode = <ChecksSensorRows viewer={viewer} status={checks.status} />;

  const stopLabel = exposureOnly ? "Stop & save" : "Stop";
  const loopSaveShown = exposureOnly && s.save.status !== "idle" && session.phase !== "complete";

  return (
    <>
      <GazeDot getContainer={getContainer} />
      <FlashOverlay getContainer={getContainer} getVideoTime={getVideoTime} events={snaps} intensity={flashIntensity} />
      {!finished && track && <TrackGuide getContainer={getContainer} getVideoTime={getVideoTime} track={track} />}

      <div className={`stp-sp-top${notice?.tone === "warning" ? " is-alert" : ""}`}>
        <div className="stp-sp-bar">
          <span className={`stp-sp-state stp-tone-${phase.tone}`} title={phase.hint}>
            <span className="stp-sp-state-dot" aria-hidden="true" />
            {phase.label}
          </span>
          {notice && (
            <span className={`stp-sp-notice is-${notice.tone}`} role="status">
              {notice.text}
            </span>
          )}
          <span className="stp-spacer" />
          <span className="stp-sp-coins" aria-label={`${formatCoins(s.balance)} stashcoins`}>
            <CoinIcon size={14} strokeWidth={2.4} />
            <span className="stp-mono">{formatCoins(s.balance)}</span>
          </span>
          <OverlayInteractive className="stp-sp-actions">
            <button
              type="button"
              className={`stp-sp-chip stp-tone-${chip.tone}`}
              onClick={() => setPanelOpen((o) => !o)}
              aria-expanded={panelOpen}
              aria-label={`${chip.value} ${chip.label}; sensors and score`}
              title="Sensors and score"
            >
              <span className="stp-sp-chip-dot" aria-hidden="true" />
              <span className="stp-mono">{chip.value}</span>
            </button>
            <button
              type="button"
              className="stp-sp-stop"
              onClick={s.stop}
              disabled={finished || s.save.status !== "idle"}
              aria-keyshortcuts="Escape"
              title={`${stopLabel} (Esc)`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="1" />
              </svg>
              <span>{stopLabel}</span>
              <span className="stp-sp-key">Esc</span>
            </button>
          </OverlayInteractive>
        </div>
        {panelOpen && (
          <OverlayInteractive className="stp-sp-panel">
            <div className="stp-sp-panel-head">
              <span className={`stp-strong stp-tone-${phase.tone}`}>{phase.label}</span>
              <button type="button" className="stp-sp-close" onClick={() => setPanelOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <p className="stp-small stp-muted stp-lh stp-sp-hint">{phase.hint}</p>
            <CountsWhen session={session} policy={policy} prompts={s.prompts.length} previousExposureSec={previousExposure(scene)} />
            <SensorsPanel
              reading={attention.reading}
              snapFlashes={flashIntensity > 0 ? snaps.length : 0}
              distanceSensor={policy.rules.includes("track")}
              track={track}
            />
            {sensorRows}
          </OverlayInteractive>
        )}
      </div>

      {!finished && promptBanner && <div className="stp-sp-prompt">{promptBanner}</div>}

      {showInattention && <InattentionOverlay text={pauseText} abortInSec={abortIn} compact={!!callout} />}
      {callout && (
        <GazeCallout
          state={callout}
          title={showInattention ? pauseText.title : texts.grace}
          detail={
            showInattention
              ? `Look back at the video · aborts in ${formatCountdown(abortIn)}`
              : "The clip pauses if you stay away."
          }
        />
      )}

      {openSpend && !finished && (
        <SpendDialog
          open={openSpend}
          balance={s.balance}
          onAccept={() => s.decideSpend(openSpend.prompt, true)}
          onDecline={() => s.decideSpend(openSpend.prompt, false)}
        />
      )}

      {session.phase === "aborted" && <AbortedOverlay reason={session.abortReason} onRetry={props.onRetry} />}

      {session.phase === "complete" && (
        <CompleteSummary
          start={s.start}
          data={data}
          session={session}
          save={s.save}
          promptCount={s.prompts.length}
          onRetrySave={s.retrySave}
        />
      )}

      {loopSaveShown && (
        <LoopSaved
          save={s.save}
          previousSec={previousExposure(scene)}
          minMinutes={policy.minMinutes}
          onRetry={s.retryLoopSave}
          onAgain={props.onRetry}
        />
      )}

      {!finished && !loopSaveShown && (
        <SlimTimeline
          session={session}
          scene={scene}
          videoTime={s.videoTime}
          furthest={s.furthest}
          durationSec={s.durationSec}
          showAttention={policy.rules.includes("attention")}
        />
      )}
    </>
  );
}
