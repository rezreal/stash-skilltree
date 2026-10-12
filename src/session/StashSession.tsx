// The Skilltree session UI over stash's scene player, rendered by
// registerStashPlayerPatch inside the player's OverlayHost:
// - SkilltreeStashOverlay: finds the scene in the tree (the shared,
//   cached play data, so coming from the choice screen doesn't reload) and
//   holds playback while the library loads; clips outside the tree get a
//   clear message and no session.
// - Test mode (skilltree=test / test-loop, ctx.test): any scene runs a
//   session. One outside the cached library is loaded on demand
//   (loadSceneById: the library's fields and mapping, so its policy comes
//   from its tags and the loaded policy tags as usual). Everything runs -
//   camera gate, presence, prompt checks, track guide, snap flashes, pause
//   and speed locks - but the session gets persist: false, so it has no
//   writer (./writes.ts) and its end is a preview. The top bar shows TEST.
// - SessionOverlay: one session (useSkilltreeSession) with a compact top
//   banner (state, notices, coins, score chip -> sensors panel, Stop), the
//   overlays, a slim timeline above the control bar, the gaze dot, snap
//   flashes and the gaze callout. The pause lock follows the policy.
//   Opt-in: the viewer's own camera as a picture-in-picture (CameraPip).
// - Live checks (src/checks) and the track rule (src/player/useTrack.ts),
//   decisions in ./checksWiring.ts: the camera gate before the session when
//   the webcam is required, presence AND gaze as the tick's attention (an
//   active gaze prompt replaces the gaze-on-video target: "close your eyes"
//   pauses while the eyes are open), prompt checks on the video clock, the
//   distance-sensor guide over the video and its score fed to the session.
// - Gaze regions (src/checks/useGazeRegions.ts): with an eye tracker, the
//   time the gaze spends on each body region of the person in the clip,
//   shown in the summary and added to the clip's performers once saved.
// - Ranked clips (not exposure loops) go fullscreen on arrival while the
//   Watch click still counts as a user activation (../stashplayer/autoFullscreen.ts).
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
import { checksSettings, parseBool } from "../checks/settings.ts";
import { useGazeRegions } from "../checks/useGazeRegions.ts";
import { usePromptChecks, type PromptChecks } from "../checks/usePromptChecks.ts";
import { useViewerPresence, type ViewerPresence } from "../checks/useViewerPresence.ts";
import { isTerminal } from "../play/index.ts";
import { router } from "../player/api.ts";
import { CoinIcon, PLAY_ROUTE } from "../player/common.tsx";
import { FlashOverlay } from "../player/FlashOverlay.tsx";
import { formatCoins, formatCountdown } from "../player/format.ts";
import { GazeDot } from "../player/GazeDot.tsx";
import { SensorsPanel } from "../player/SensorsPanel.tsx";
import { eyesClosedDimOpacity } from "../player/flash.ts";
import { FocusBlur } from "../player/FocusBlur.tsx";
import { focusBlurPx, wantsFocusBlur } from "../player/focusBlur.ts";
import { trackGlowIntensity } from "../player/trackView.ts";
import { SensorStatusChip } from "../player/SensorStatusChip.tsx";
import { TrackGuide } from "../player/TrackGuide.tsx";
import { loadShowCamera, saveShowCamera } from "../player/storage.ts";
import { usePlayData, type PlayData } from "../player/usePlayData.ts";
import { useSnapEvents, useSnapFlashIntensity } from "../player/useSnapEvents.ts";
import { useTrackSession, type TrackHandle } from "../player/useTrack.ts";
import { phaseView, previousExposure } from "../player/view.ts";
import { OverlayInteractive } from "../stashplayer/OverlayHost.tsx";
import type { StashPlayerContext } from "../stashplayer/patch.tsx";
import { lockUserPause } from "../stashplayer/pauseLock.ts";
import { enterFullscreen, wantsAutoFullscreen } from "../stashplayer/autoFullscreen.ts";
import { lockPlaybackRate } from "../stashplayer/rateLock.ts";
import { lockSeeking } from "../stashplayer/seekLock.ts";
import type { VideoHandle } from "../stashplayer/videoHandle.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";
import { loadSceneById } from "../stash/testSearch.ts";
import type { StashClient } from "../stash/client.ts";
import {
  attentionTexts,
  needsCameraGate,
  presenceWanted,
  sessionAdjuster,
  sessionAttending,
  TRACK_REPORT_MS,
  trackScoreToReport,
} from "./checksWiring.ts";
import { bannerNotice, findTreeScene, ruleResults, scoreChipView, viewPauseCause, wantsPauseLock } from "./controller.ts";
import { CameraPip } from "./CameraPip.tsx";
import { GazeCallout, useGazeCallout } from "./GazeCallout.tsx";
import { GazeRegionsSummary, usePerformerRegions } from "./GazeRegionsSummary.tsx";
import { calloutAim } from "./gazeCallout.ts";
import { AbortedOverlay, CompleteSummary, InattentionOverlay, LoopSaved, SpendDialog, TEST_NOT_SAVED } from "./overlays.tsx";
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

type OnDemandScene =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; scene: SceneInput }
  | { status: "missing" }
  | { status: "error"; error: string };

/** test mode: a scene outside the library, loaded from stash when `sceneId` is set */
function useOnDemandScene(client: StashClient | undefined, sceneId: string | undefined): { state: OnDemandScene; retry: () => void } {
  const [state, setState] = React.useState<OnDemandScene>({ status: "idle" });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!client || sceneId === undefined) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    loadSceneById(client, sceneId).then(
      (scene) => {
        if (live) setState(scene ? { status: "ready", scene } : { status: "missing" });
      },
      (err: unknown) => {
        if (live) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [client, sceneId, attempt]);
  return { state, retry: React.useCallback(() => setAttempt((n) => n + 1), []) };
}

export function SkilltreeStashOverlay(props: { ctx: StashPlayerContext }) {
  const { handle, sceneId, test } = props.ctx;
  const { state, reload } = usePlayData();
  const [attempt, setAttempt] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const pluginSettings = usePluginSettings();
  // the camera gate: only when the webcam is required (default); playback is
  // held until a person is in view of the running camera
  const webcamRequired = checksSettings(pluginSettings).webcamRequired;
  // ranked clips start fullscreen while the Watch click still counts (the gate shows in it too)
  const autoFullscreen = wantsAutoFullscreen(props.ctx, parseBool(pluginSettings.autoFullscreen, true));
  const fullscreenTried = React.useRef(false);
  React.useEffect(() => {
    if (!autoFullscreen || fullscreenTried.current) return;
    fullscreenTried.current = true;
    void enterFullscreen(handle);
  }, [handle, autoFullscreen]);
  const [gatePassed, setGatePassed] = React.useState(false);
  const treeScene = state.status === "ready" ? findTreeScene(state.data, sceneId) : undefined;
  // test mode: any scene; one outside the library is loaded on demand
  const onDemand = useOnDemandScene(
    state.status === "ready" ? state.data.client : undefined,
    test && state.status === "ready" && !treeScene ? sceneId : undefined,
  );
  const scene = treeScene ?? (onDemand.state.status === "ready" ? onDemand.state.scene : undefined);
  const gate = !!scene && needsCameraGate(webcamRequired, gatePassed);
  const sceneLoading = test && !scene && (onDemand.state.status === "loading" || onDemand.state.status === "idle");
  const waiting = state.status === "loading" || sceneLoading || gate;

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
  if (!scene && test) {
    if (onDemand.state.status === "error" || onDemand.state.status === "missing") {
      return (
        <Root>
          <Notice tone="error" interactive>
            <span role="alert">
              <span className="stp-test-tag">TEST</span>{" "}
              {onDemand.state.status === "error"
                ? `Skilltree could not load the scene: ${onDemand.state.error}`
                : "Stash has no scene with this id."}
            </span>
            {onDemand.state.status === "error" && (
              <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={onDemand.retry}>
                Retry
              </button>
            )}
          </Notice>
        </Root>
      );
    }
    return (
      <Root>
        <Notice>
          <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
          <span className="stp-test-tag">TEST</span> Skilltree: loading the scene…
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
        test={test}
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
  /** test mode: the session runs without a writer (persist: false) */
  test: boolean;
}) {
  const { handle, data, test } = props;
  const rawSettings = usePluginSettings();
  const settings = checksSettings(rawSettings);
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
        prompt: checksRef.current?.promptAttention(),
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

  const s = useSkilltreeSession({
    scene: props.scene,
    handle,
    data,
    reload: props.reload,
    adjustAttention,
    beforeEnd,
    persist: !test,
  });
  const { session, policy, scene, openSpend, attention, exposureOnly } = s;
  reportTrackRef.current = s.reportTrack;
  const finished = isTerminal(session);
  const snaps = useSnapEvents(scene.id, scene.interactive);
  const flashIntensity = useSnapFlashIntensity();
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [showCamera, setShowCameraState] = React.useState(loadShowCamera);
  const setShowCamera = React.useCallback((on: boolean) => {
    setShowCameraState(on);
    saveShowCamera(on);
  }, []);

  // watched clips can't be paused by the viewer while the session runs; loops can
  const lock = wantsPauseLock(policy, session.phase);
  React.useEffect(() => (lock ? lockUserPause(handle) : undefined), [handle, lock]);
  // ranked play runs at 1x: a faster clip would ask for less attention
  React.useEffect(() => lockPlaybackRate(handle), [handle]);
  // ranked play can't seek while it runs; test mode can, to try checks out of order
  const seekLocked = !test && !finished;
  React.useEffect(() => (seekLocked ? lockSeeking(handle) : undefined), [handle, seekLocked]);

  const getContainer = React.useCallback(() => handle.container(), [handle]);
  const getVideoTime = React.useCallback(() => (handle.video() ? handle.currentTime() : undefined), [handle]);
  const getVideo = React.useCallback(() => handle.video(), [handle]);

  // --- checks: webcam presence + prompt checks ---
  const viewer = useViewerPresence({ enabled: presenceWanted({ required, permission, finished }) });
  viewerRef.current = viewer;
  // where the gaze lands on the person: counted while the clip plays in front
  const readingRef = React.useRef(attention.reading);
  readingRef.current = attention.reading;
  const regionsCounting = React.useCallback(
    () => !handle.paused() && !handle.ended() && !readingRef.current.background,
    [handle],
  );
  const regions = useGazeRegions({
    enabled: settings.videoAnalysis && settings.gazeRegions && !finished,
    getVideoTime,
    getVideo,
    counting: regionsCounting,
  });
  // no getVideoBox: the hook measures the <video> itself
  const checks = usePromptChecks({
    scene,
    enabled: settings.promptsEnabled && !finished,
    getVideoTime,
    getVideo,
    viewer,
    onResult: s.reportPrompt,
    onSeek: s.seek,
    onPersonFrame: regions.feedPerson,
  });
  checksRef.current = checks;
  const performerRegions = usePerformerRegions({
    ended: s.save.status === "saved" || s.save.status === "preview",
    seconds: regions.seconds,
    save: s.saveGazeRegions,
    reload: props.reload,
    performerIds: scene.performerIds,
  });
  const regionsSummary: ReactNode = <GazeRegionsSummary state={performerRegions} performers={data.graph.performers} />;

  // --- track: the distance-sensor guide and its score ---
  const runningRef = React.useRef(!finished);
  runningRef.current = !finished;
  const isPlaying = React.useCallback(() => runningRef.current && !handle.paused() && !handle.ended(), [handle]);
  const { track } = useTrackSession(scene.id, getVideoTime, {
    // only clips tagged with the track rule; a funscript alone isn't enough
    enabled: policy.rules.includes("track"),
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
  // the leading gaze prompt replaces the gaze-on-video target while active
  const prompt = checks.promptAttention();
  const dimOpacity = eyesClosedDimOpacity(rawSettings.eyesClosedDim);
  const dimOn = !finished && dimOpacity > 0 && prompt?.spec.target === "eyes_closed";
  const focusSpec = !finished && wantsFocusBlur(prompt?.spec) ? prompt?.spec : undefined;
  const texts = attentionTexts(attention.reading, presence, required, prompt);
  const attendingNow = sessionAttending(attention.reading, presence, { required, prompt });

  const phase = phaseView(session.phase, policy, viewPauseCause(!!openSpend, session.pausedBy));
  const pauseAttemptRecent = useRecentChange(session.pauseAttempts, 4000);
  const notice = bannerNotice({
    phase: session.phase,
    spendOpen: !!openSpend,
    pauseAttemptRecent,
    graceText: texts.grace,
    exposureOnly,
    test,
  });
  const chip = scoreChipView(session, policy, attendingNow);

  const showInattention = session.phase === "paused" && session.pausedBy === "inattention" && !openSpend;
  const graceWarning = session.phase === "grace" && !openSpend;
  // during a gaze prompt the callout points at the target region (hidden for eyes_closed / off_screen)
  const aim = prompt ? calloutAim(prompt.spec.target, checks.regionFor(prompt.spec)) : "video";
  const callout = useGazeCallout(
    (showInattention || graceWarning) && aim !== "hide",
    getContainer,
    typeof aim === "object" ? aim : undefined,
  );
  const pauseText = texts.pause;
  const abortIn =
    session.pausedSinceMs !== undefined ? policy.abortSec - (Date.now() - session.pausedSinceMs) / 1000 : policy.abortSec;

  const promptBanner: ReactNode = checks.specs.length > 0 ? <PromptBanner checks={checks} /> : null;
  const sensorRows: ReactNode = <ChecksSensorRows viewer={viewer} status={checks.status} />;
  const cameraOn = viewer.state === "on";

  const stopLabel = exposureOnly && s.persists ? "Stop & save" : "Stop";
  // test mode: what decided the clip, for the summary and the aborted overlay
  const testResults = !s.persists && finished ? ruleResults(session, s.prompts.length) : undefined;
  const loopSaveShown = exposureOnly && s.save.status !== "idle" && session.phase !== "complete";

  return (
    <>
      {/* a light dim while an "eyes closed" prompt runs: the cue to close them, and what a peek sees */}
      <div
        className={`stp-sp-dim${dimOn ? " is-on" : ""}`}
        style={dimOn ? { opacity: dimOpacity } : undefined}
        aria-hidden="true"
      />
      {/* a gaze prompt on a region: everything around it blurs, more the longer the prompt runs */}
      <FocusBlur
        spec={focusSpec}
        regionFor={checks.regionFor}
        getVideoTime={getVideoTime}
        strength={focusBlurPx(rawSettings.focusBlur)}
      />
      <GazeDot getContainer={getContainer} />
      <FlashOverlay getContainer={getContainer} getVideoTime={getVideoTime} events={snaps} intensity={flashIntensity} />
      {!finished && track && (
        <TrackGuide getContainer={getContainer} getVideoTime={getVideoTime} track={track} glow={trackGlowIntensity(rawSettings.trackGlow)} />
      )}

      <div className={`stp-sp-top${notice?.tone === "warning" ? " is-alert" : ""}`}>
        <div className="stp-sp-bar">
          {!s.persists && (
            <span className="stp-test-tag" title={`${TEST_NOT_SAVED}: every check runs, nothing is written`}>
              TEST
            </span>
          )}
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
            {track && !finished && <SensorStatusChip onOpen={() => setPanelOpen(true)} />}
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
            {cameraOn && (
              <label className="stp-toggle stp-small">
                <input type="checkbox" checked={showCamera} onChange={(e) => setShowCamera(e.currentTarget.checked)} />
                Show my camera
              </label>
            )}
          </OverlayInteractive>
        )}
      </div>

      {!finished && promptBanner && <div className="stp-sp-prompt">{promptBanner}</div>}
      {!finished && showCamera && cameraOn && <CameraPip viewer={viewer} onHide={() => setShowCamera(false)} />}

      {showInattention && <InattentionOverlay text={pauseText} abortInSec={abortIn} compact={!!callout} />}
      {callout && (
        <GazeCallout
          state={callout}
          title={showInattention ? pauseText.title : texts.grace}
          detail={
            showInattention
              ? `${texts.back} · aborts in ${formatCountdown(abortIn)}`
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

      {session.phase === "aborted" && (
        <AbortedOverlay reason={session.abortReason} onRetry={props.onRetry} testResults={testResults} />
      )}

      {session.phase === "complete" && (
        <CompleteSummary
          start={s.start}
          data={data}
          session={session}
          save={s.save}
          promptCount={s.prompts.length}
          onRetrySave={s.retrySave}
          testResults={testResults}
        >
          {regionsSummary}
        </CompleteSummary>
      )}

      {loopSaveShown && (
        <LoopSaved
          save={s.save}
          previousSec={previousExposure(scene)}
          minMinutes={policy.minMinutes}
          onRetry={s.retryLoopSave}
          onAgain={props.onRetry}
        >
          {regionsSummary}
        </LoopSaved>
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
