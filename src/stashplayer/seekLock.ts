// No seeking while a ranked Skilltree session runs: skipping ahead would earn
// a clip without watching it, and jumping back would watch a part twice.
//
// - stash's progress bar takes no pointer input and its scrubber (the
//   thumbnail strip under the player) is hidden
// - seek keys inside the player area (arrows, digits, Home/End, j/l) are
//   stopped before stash's and video.js's hotkeys see them
// - anything that still moves the playhead - the markers panel, OS media
//   controls, another plugin, stash's transcode seeks that reload the source
//   without a "seeking" event - is set straight back to where playback was
// The session's own seeks (prompt replays) go through seekByPlugin.
// A native loop's wrap from the end back to the start is not a seek.
import { OVERLAY_ATTR, isEditable, playerArea, type ElementLike, type KeyLike } from "./pauseLock.ts";
import type { VideoHandle } from "./videoHandle.ts";

export const SEEK_LOCK_CLASS = "skilltree-noseek";
export const SEEK_LOCK_STYLE_ID = "skilltree-stashplayer-noseek";

export const SEEK_LOCK_CSS = `
.video-js.${SEEK_LOCK_CLASS} .vjs-progress-control {
  pointer-events: none !important;
}
.VideoPlayer:has(.video-js.${SEEK_LOCK_CLASS}) .scrubber-wrapper {
  display: none !important;
}
`;

/** a jump of more than this (seconds, beyond the time played) is a seek */
export const SEEK_TOLERANCE_SEC = 1.5;

/** where seekByPlugin is taking each handle */
const pluginTargets = new WeakMap<VideoHandle, number>();

/** Seeks on the session's behalf; a seek lock lets this one through. */
export function seekByPlugin(handle: VideoHandle, sec: number): void {
  const to = Math.max(0, sec);
  pluginTargets.set(handle, to);
  try {
    handle.player()?.currentTime(to);
  } catch {
    // player between dispose and removal
    pluginTargets.delete(handle);
  }
}

/** Would this key move the playhead? Same area rules as isPauseKey. */
export function isSeekKey(e: KeyLike, area: { contains(node: unknown): boolean } | null): boolean {
  const target = e.target as ElementLike | null;
  if (!area || !target || !area.contains(target)) return false;
  if (target.closest?.(`[${OVERLAY_ATTR}]`)) return false;
  if (isEditable(target)) return false;
  if (e.key === "MediaTrackNext" || e.key === "MediaTrackPrevious") return false; // stash: next/previous scene
  if (e.key === "MediaFastForward" || e.key === "MediaRewind") return true;
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") return true;
  if (/^[0-9]$/.test(e.key)) return true;
  return e.key === "j" || e.key === "J" || e.key === "l" || e.key === "L";
}

interface ListenerTarget {
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
}

export interface SeekLockEnv {
  window?: ListenerTarget;
  document?: {
    getElementById(id: string): unknown;
    createElement(tag: string): { id: string; textContent: string | null };
    head: { appendChild(node: unknown): unknown } | null;
  };
  now?: () => number;
}

function browserEnv(): SeekLockEnv {
  const g = globalThis as unknown as { window?: ListenerTarget; document?: SeekLockEnv["document"] };
  return { window: g.window, document: g.document, now: () => Date.now() };
}

function ensureStyle(doc: NonNullable<SeekLockEnv["document"]>): void {
  if (doc.getElementById(SEEK_LOCK_STYLE_ID) || !doc.head) return;
  const style = doc.createElement("style");
  style.id = SEEK_LOCK_STYLE_ID;
  style.textContent = SEEK_LOCK_CSS;
  doc.head.appendChild(style);
}

interface ContainerLike {
  classList?: { add(c: string): void; remove(c: string): void };
}

/**
 * Applies the lock and follows container replacements. Returns the unlock
 * function; everything is restored on unlock. Enforcement starts with the
 * first moment of playback, so stash's start position (?t=) is left alone.
 */
export function lockSeeking(handle: VideoHandle, envIn: SeekLockEnv = {}): () => void {
  const env = { ...browserEnv(), ...envIn };
  const now = env.now ?? (() => Date.now());
  if (env.document) ensureStyle(env.document);

  /** where playback legitimately is; undefined until it has played */
  let last: number | undefined;
  let lastAtMs = now();
  let reverting = false;

  let container: ContainerLike | null = null;
  const apply = () => {
    const next = handle.container() as unknown as ContainerLike | null;
    if (next === container) return;
    container?.classList?.remove(SEEK_LOCK_CLASS);
    next?.classList?.add(SEEK_LOCK_CLASS);
    container = next;
  };

  const accept = (t: number) => {
    last = t;
    lastAtMs = now();
  };

  const isLoopWrap = (from: number, to: number) => {
    const d = handle.duration();
    return Number.isFinite(d) && from >= d - SEEK_TOLERANCE_SEC && to <= SEEK_TOLERANCE_SEC;
  };

  /** accepts the playhead at t, or sends it back to where playback was */
  const check = (t: number, playedSec: number): void => {
    const target = pluginTargets.get(handle);
    if (target !== undefined && Math.abs(t - target) <= SEEK_TOLERANCE_SEC) {
      pluginTargets.delete(handle);
      accept(t);
      return;
    }
    if (last === undefined) return;
    const delta = t - last;
    if (delta >= -SEEK_TOLERANCE_SEC && delta <= playedSec + SEEK_TOLERANCE_SEC) {
      accept(t);
      return;
    }
    if (isLoopWrap(last, t)) {
      accept(t);
      return;
    }
    if (reverting) return;
    reverting = true;
    try {
      handle.player()?.currentTime(last);
    } catch {
      // player between dispose and removal
    } finally {
      reverting = false;
    }
  };

  apply();
  const offSeeking = handle.onEvent("seeking", () => check(handle.currentTime(), 0));
  const offTime = handle.onEvent("timeupdate", () => {
    const t = handle.currentTime();
    if (last === undefined) {
      // the first moment of playback; before it, stash may still be positioning the clip
      if (!handle.paused()) accept(t);
      return;
    }
    // a paused player doesn't advance: only wall time since the last sample while playing counts
    check(t, handle.paused() ? 0 : (now() - lastAtMs) / 1000);
  });
  const offPlay = handle.onEvent("play", () => {
    lastAtMs = now();
    apply();
  });
  const offContainer = handle.onContainerChange(apply);

  const onKey = (e: Event) => {
    if (!isSeekKey(e as unknown as KeyLike, playerArea(handle.container()))) return;
    e.preventDefault();
    e.stopPropagation();
    (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
  };
  env.window?.addEventListener("keydown", onKey, true);
  env.window?.addEventListener("keyup", onKey, true);

  return () => {
    offSeeking();
    offTime();
    offPlay();
    offContainer();
    env.window?.removeEventListener("keydown", onKey, true);
    env.window?.removeEventListener("keyup", onKey, true);
    container?.classList?.remove(SEEK_LOCK_CLASS);
    container = null;
  };
}
