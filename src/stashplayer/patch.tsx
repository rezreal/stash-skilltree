// Skilltree sessions on stash's own scene player.
//
// Design note - findings against stash v0.31.0 (video.js 7.21):
//
// ScenePlayer (ui/v2.5/src/components/ScenePlayer/ScenePlayer.tsx)
// - PatchComponent("ScenePlayer", ...) at :233. Props (:221): scene,
//   hideScrubberOverride, autoplay, permitLoop, initialTimestamp,
//   sendSetTimestamp, onComplete, onNext, onPrevious. Mounted once by
//   SceneLoader (Scenes/SceneDetails/Scene.tsx:1034, key="ScenePlayer"); a
//   scene change on /scenes/:id keeps the component and the video.js player
//   and only reloads the sources (:577, guarded by sceneId.current).
// - Renders <div class="VideoPlayer"><div class="video-wrapper"/>...scrubber
//   </div>; its init effect (:336) appends <video-js id="VideoJsPlayer"> to the
//   wrapper and calls videojs() on it. The effect re-runs (new root, new
//   <video>) when showAbLoopControls / enableChromecast change (develop: also
//   autostartVideo).
// - Sources (:622): every scene.sceneStreams entry goes to the source
//   selector; direct streams first, transcodes as fallbacks on decode errors
//   (source-selector.ts). Transcodes are "offset" sources (live.ts): seeking
//   reloads the stream with ?start=, so only player.currentTime() is the
//   real time. All of them play on the Html5 tech in the same <video>; the
//   element is replaced only on a tech change (Chromecast) or player re-init.
// - Start position (:687): initialTimestamp, else scene.resume_time unless
//   "always start from beginning" is set; initialTimestamp 0 counts as unset.
//   Autoplay (:706, :889): autoplay prop (?autoplay=true), the autostart
//   button/config, or initialTimestamp > 0; waits for the Handy script.
// - End (:908): player.on("ended", onComplete) -> SceneLoader.onComplete
//   (Scene.tsx:972) advances the queue when "continue" is on; with no queue
//   parameters (qs/qfp) there is nothing to advance to. NB the cleanup is
//   player.off("ended"), which drops every "ended" handler on the player.
// - Activity (:816 + track-activity.ts): while playing, every 10 s and on
//   pause/end, sceneSaveActivity(resume_time, playDuration); once the played
//   share reaches minimumPlayPercent (default 0), sceneIncrementPlayCount
//   once per load. resume_time is reset to 0 at >= 98 % watched.
// - Fullscreen: player.requestFullscreen() calls requestFullscreen on the
//   video.js root, so document.fullscreenElement === <video-js> (iOS uses
//   native video fullscreen, where no overlay can show).
// - Handy: ScenePlayer forwards video.js "playing" -> interactiveClient.play(
//   player.currentTime()) (plus a second sync 1 s later) and "pause" ->
//   interactiveClient.pause() (:540). Those are the tech's relays of the
//   native media events, so pausing/playing via the media element or the
//   player keeps Handy (and the Funscript Axis Router's patched client) in
//   step; seeks resync through the next "playing".
//
// patch.tsx (before/instead/after): before(props, ...rest) returns the new
// argument list; after(props..., result) returns the new result; both run
// inside ScenePlayer's render, so they must not call hooks. We use both:
// - before: in Skilltree mode, rewrite props (props.ts): resume_time 0,
//   inert onComplete/onNext/onPrevious, no looping (except loops).
// - after: append our slot as a sibling: <>{result}<SkilltreeSlot/></>.
//   React unwraps a top-level unkeyed fragment, so stash's <div
//   class="VideoPlayer"> keeps its fiber (and the imperatively created
//   video.js player) whether or not the slot is there. `instead` would also
//   work but makes us responsible for calling next(); nothing here needs it.
// Outside Skilltree mode both patches return their input unchanged.
//
// Not preventable (without breaking stash):
// - stash's activity tracking: it still records play duration, a resume
//   position (an aborted session leaves resume_time where it stopped; a
//   finished one resets it) and adds one play when playback starts (with the
//   default minimumPlayPercent 0). sceneIncrementPlayCount and our
//   sceneAddPlay (src/play/commit.ts) both call AddViews on the server, so a
//   completed session would count two plays. Recommendation: drop our
//   sceneAddPlay when playback runs on stash's player; stash's own count is
//   the user's configured notion of "played".
// - opening the scene page normally while a session runs elsewhere, stash
//   hotkeys that don't pause (seek, rate, O-counter), the queue panel.
// - entering the mode on an already mounted player for the same scene (no
//   source reload, so no start at 0); "Watch" always comes from our route.
import type { ReactNode } from "react";
import { interactivePlayer, playerRoot, stashPlayerApi } from "./api.ts";
import type { SkilltreeMode } from "./handoff.ts";
import { OverlayHost } from "./OverlayHost.tsx";
import { lockUserPause } from "./pauseLock.ts";
import { modeForScene, skilltreePlayerProps, type ScenePlayerProps, type StashScene } from "./props.ts";
import { createVideoHandle, type VideoHandle } from "./videoHandle.ts";

export interface StashPlayerContext {
  sceneId: string;
  /** seconds the clip starts at (0 unless the handoff URL said otherwise) */
  startAt: number;
  /** an exposure loop (skilltree=loop / test-loop) */
  loop: boolean;
  /** test mode (skilltree=test / test-loop): the session runs but saves nothing */
  test: boolean;
  handle: VideoHandle;
  /** stash's scene data as ScenePlayer got it (resume_time already 0) */
  scene: StashScene;
}

export interface StashPlayerPatchOptions {
  /**
   * Block the viewer's pause affordances (see pauseLock.ts). Default: on for
   * watched clips, off for loops - matching WatchPolicy.allowUserPause.
   */
  lockPause?: boolean | ((ctx: StashPlayerContext) => boolean);
}

let registered = false;

export function registerStashPlayerPatch(
  render: (ctx: StashPlayerContext) => ReactNode,
  options: StashPlayerPatchOptions = {},
): void {
  if (registered) return;
  registered = true;
  const api = stashPlayerApi();
  const sceneCache = new WeakMap<object, StashScene>();

  api.patch.before("ScenePlayer", (props: ScenePlayerProps, ...rest: unknown[]) => {
    const mode = modeForScene(props?.scene, window.location);
    return [mode ? skilltreePlayerProps(props, mode, sceneCache) : props, ...rest];
  });

  api.patch.after("ScenePlayer", (...args: unknown[]) => {
    const props = args[0] as ScenePlayerProps;
    const result = args[args.length - 1] as ReactNode;
    const mode = modeForScene(props?.scene, window.location);
    if (!mode) return result;
    return (
      <>
        {result}
        <SkilltreeSlot key={`skilltree:${mode.sceneId}`} mode={mode} scene={props.scene} render={render} options={options} />
      </>
    );
  });
}

function SkilltreeSlot(props: {
  mode: SkilltreeMode;
  scene: StashScene;
  render: (ctx: StashPlayerContext) => ReactNode;
  options: StashPlayerPatchOptions;
}) {
  const { mode, scene, render, options } = props;
  const [handle] = React.useState(() => createVideoHandle(playerRoot, { getPlayer: interactivePlayer }));
  React.useEffect(() => () => handle.dispose(), [handle]);

  const ctx = React.useMemo<StashPlayerContext>(
    () => ({ sceneId: mode.sceneId, startAt: mode.startAt, loop: mode.loop, test: mode.test, handle, scene }),
    [mode.sceneId, mode.startAt, mode.loop, mode.test, handle, scene],
  );

  const lock = typeof options.lockPause === "function" ? options.lockPause(ctx) : (options.lockPause ?? !mode.loop);
  React.useEffect(() => (lock ? lockUserPause(handle) : undefined), [handle, lock]);

  return <OverlayHost handle={handle}>{render(ctx)}</OverlayHost>;
}
