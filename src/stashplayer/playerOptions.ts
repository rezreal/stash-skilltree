// Temporary overrides of video.js `userActions` (click, hotkeys, ...).
// video.js reads player.options_.userActions.<name> at event time
// (Player#handleTechClick_, Player#handleKeyDown in 7.21), so changing it on
// a live player takes effect immediately. Stash sets
// userActions = { hotkeys: handleHotkeys } at creation (ScenePlayer.tsx:371).
import type { VideoJsLike } from "./videoHandle.ts";

/** sets userActions[name] = value; the returned function puts the old value back */
export function overrideUserAction(player: VideoJsLike, name: string, value: unknown): () => void {
  const opts = (player.options_ ??= {});
  const actions = (opts.userActions ??= {});
  const had = Object.prototype.hasOwnProperty.call(actions, name);
  const previous = actions[name];
  actions[name] = value;
  return () => {
    // someone else replaced it in the meantime: leave theirs
    if (actions[name] !== value) return;
    if (had) actions[name] = previous;
    else delete actions[name];
  };
}

/** the current value, e.g. stash's hotkeys function, for wrapping */
export function userAction(player: VideoJsLike, name: string): unknown {
  return player.options_?.userActions?.[name];
}
