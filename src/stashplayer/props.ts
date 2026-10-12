// How the "before" patch rewrites ScenePlayer's props in Skilltree mode.
// Pure, so it can be tested without React or stash.
import { parseSkilltreeMode, type SkilltreeMode } from "./handoff.ts";

/** the parts of stash's GQL.SceneDataFragment this module reads */
export interface StashScene {
  id: string;
  resume_time?: number | null;
  [key: string]: unknown;
}

/** IScenePlayerProps in stash v0.31.0 (ScenePlayer.tsx:221-231) */
export interface ScenePlayerProps {
  scene: StashScene;
  hideScrubberOverride: boolean;
  autoplay?: boolean;
  permitLoop?: boolean;
  initialTimestamp: number;
  sendSetTimestamp: (setTimestamp: (value: number) => void) => void;
  onComplete: () => void;
  onNext: () => void;
  onPrevious: () => void;
  [key: string]: unknown;
}

/**
 * Stable no-ops. They must keep their identity across renders: ScenePlayer
 * re-runs `player.on("ended", onComplete) / player.off("ended")` whenever
 * onComplete changes, and that off() drops every "ended" handler on the
 * player, stash's activity tracker included.
 */
const noComplete = () => undefined;
const noNext = () => undefined;
const noPrevious = () => undefined;

/** the mode, if the location asks for it AND it is this player's scene */
export function modeForScene(
  scene: { id?: unknown } | undefined,
  location: { pathname: string; search: string },
): SkilltreeMode | undefined {
  const mode = parseSkilltreeMode(location);
  if (!mode || scene?.id === undefined || String(scene.id) !== mode.sceneId) return undefined;
  return mode;
}

/**
 * Props for a Skilltree session:
 * - scene.resume_time = 0, so ScenePlayer doesn't "continue from" the last
 *   position (it uses resume_time whenever initialTimestamp is 0). The copy is
 *   cached per scene object: ScenePlayer re-renders on every timeupdate and a
 *   new scene object each time would re-run its scene effects (markers are
 *   cleared and re-added, interactive handlers re-bound).
 * - initialTimestamp = startAt (stash also reads `t` itself; kept in step).
 * - onComplete / onNext / onPrevious do nothing: no queue advance at the end,
 *   no skip buttons or media keys leaving the clip mid-session.
 * - permitLoop only for loops: a short clip under stash's "maximum loop
 *   duration" would otherwise loop forever and never fire "ended".
 * Everything else (autoplay, scrubber, sources) stays stash's.
 */
export function skilltreePlayerProps(
  props: ScenePlayerProps,
  mode: SkilltreeMode,
  cache: WeakMap<object, StashScene>,
): ScenePlayerProps {
  let scene = props.scene;
  if (scene && scene.resume_time) {
    let copy = cache.get(scene);
    if (!copy) {
      copy = { ...scene, resume_time: 0 };
      cache.set(scene, copy);
    }
    scene = copy;
  }
  return {
    ...props,
    scene,
    initialTimestamp: mode.startAt > 0 ? mode.startAt : 0,
    permitLoop: mode.loop,
    onComplete: noComplete,
    onNext: noNext,
    onPrevious: noPrevious,
  };
}
