// "The viewer can't pause" for stash's player in Skilltree mode.
//
// What is blocked while the clip plays (starting/resuming stays possible):
// - control bar play/pause button and stash's big play/pause button: hidden
//   (visibility, so the control bar doesn't reflow) while the root has
//   .vjs-playing; video.js hides its own big play button once started
// - click on the video: userActions.click becomes "play if paused" (video.js
//   otherwise toggles, Player#handleTechClick_)
// - Space / Enter / k / media play-pause keys inside the player area: a
//   capture listener on window stops them before stash's onKeyDownCapture
//   on .VideoPlayer (Space, ScenePlayer.tsx:958) and video.js hotkeys
//   (stash's handleHotkeys: Space/Enter) see them. Enter on other buttons
//   (fullscreen, volume...) still works; Escape is never touched.
// - OS / browser media controls: stash's media-session plugin maps "pause"
//   to player.pause(); while locked our handler ignores it.
// What can't be blocked: the browser or OS pausing the element itself
// (audio focus loss on mobile, headphones unplugged, no mediaSession
// support), stash's scrubber pausing while it is dragged (it resumes), other
// plugins calling pause(). Those arrive as VideoHandle pause events with cause
// "other", so the session treats them as pauseByUser and resumes.
import { overrideUserAction } from "./playerOptions.ts";
import type { VideoHandle, VideoJsLike } from "./videoHandle.ts";

export const LOCK_CLASS = "skilltree-nopause";
export const LOCK_STYLE_ID = "skilltree-stashplayer-nopause";
/** elements carrying this attribute (our overlay host) are left alone */
export const OVERLAY_ATTR = "data-skilltree-overlay";

export const LOCK_CSS = `
.video-js.${LOCK_CLASS}.vjs-playing .vjs-play-control,
.video-js.${LOCK_CLASS}.vjs-playing .vjs-big-play-pause-button,
.video-js.${LOCK_CLASS}.vjs-playing .vjs-big-play-button {
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

export interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  closest?(selector: string): ElementLike | null;
}

export interface KeyLike {
  key: string;
  code?: string;
  target: unknown;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

const TEXT_INPUT_EXEMPT = ["button", "checkbox", "hidden", "radio", "reset", "submit"];
const PAUSE_BUTTONS = ".vjs-play-control, .vjs-big-play-button, .vjs-big-play-pause-button";

export function isEditable(el: ElementLike): boolean {
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") return !TEXT_INPUT_EXEMPT.includes((el.getAttribute?.("type") ?? "text").toLowerCase());
  return false;
}

function isButtonLike(el: ElementLike): boolean {
  const tag = (el.tagName ?? "").toLowerCase();
  if (tag === "button" || tag === "a" || tag === "input") return true;
  const role = el.getAttribute?.("role");
  return role === "button" || role === "menuitem" || role === "menuitemradio" || role === "slider";
}

/**
 * Would this key toggle playback (and so pause it)? Only keys whose target is
 * inside `area` (stash's .VideoPlayer) count; typing in a field and anything
 * inside our overlay is left alone.
 */
export function isPauseKey(e: KeyLike, area: { contains(node: unknown): boolean } | null): boolean {
  const target = e.target as ElementLike | null;
  if (!area || !target || !area.contains(target)) return false;
  if (target.closest?.(`[${OVERLAY_ATTR}]`)) return false;
  if (isEditable(target)) return false;
  if (e.key === "MediaPlayPause" || e.key === "MediaPause") return true;
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  if (e.key === " " || e.key === "Spacebar" || e.code === "Space") return true;
  if ((e.key === "k" || e.key === "K") && !e.shiftKey) return true;
  if (e.key === "Enter") return !isButtonLike(target) || !!target.closest?.(PAUSE_BUTTONS);
  return false;
}

interface ListenerTarget {
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void;
}

export interface PauseLockEnv {
  window: ListenerTarget;
  document: {
    getElementById(id: string): unknown;
    createElement(tag: string): { id: string; textContent: string | null };
    head: { appendChild(node: unknown): unknown } | null;
  };
  mediaSession?: { setActionHandler(action: string, handler: (() => void) | null): void };
}

function browserEnv(): PauseLockEnv {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: PauseLockEnv["mediaSession"] }) : undefined;
  return {
    window: window as unknown as ListenerTarget,
    document: document as unknown as PauseLockEnv["document"],
    mediaSession: nav?.mediaSession,
  };
}

function ensureStyle(doc: PauseLockEnv["document"]): void {
  if (doc.getElementById(LOCK_STYLE_ID) || !doc.head) return;
  const style = doc.createElement("style");
  style.id = LOCK_STYLE_ID;
  style.textContent = LOCK_CSS;
  doc.head.appendChild(style);
}

interface ContainerLike {
  classList?: { add(c: string): void; remove(c: string): void };
  closest?(selector: string): unknown;
  contains?(node: unknown): boolean;
}

/** stash's .VideoPlayer (player + scrubber), or the player root itself */
export function playerArea(container: HTMLElement | null): { contains(node: unknown): boolean } | null {
  const c = container as unknown as ContainerLike | null;
  if (!c) return null;
  const outer = c.closest?.(".VideoPlayer") as ContainerLike | null | undefined;
  const area = outer ?? c;
  return typeof area.contains === "function" ? (area as { contains(node: unknown): boolean }) : null;
}

/** "play if paused" - a click on the video can start but never pause */
function clickPlaysOnly(this: VideoJsLike): void {
  if (this.paused()) void Promise.resolve(this.play()).catch(() => undefined);
}

/**
 * Applies the lock and follows container replacements. Returns the unlock
 * function; everything is restored on unlock.
 */
export function lockUserPause(handle: VideoHandle, env: PauseLockEnv = browserEnv()): () => void {
  ensureStyle(env.document);

  let applied: { container: HTMLElement | null; restoreClick?: () => void } | undefined;

  const ignorePause = () => undefined;
  const setPauseHandler = (fn: (() => void) | null) => {
    try {
      env.mediaSession?.setActionHandler("pause", fn);
    } catch {
      // action not supported
    }
  };

  function apply(): void {
    const container = handle.container();
    const player = handle.player();
    if (applied && applied.container === container) {
      // a re-created player on the same root is unlikely; the click override still follows it
      if (!applied.restoreClick && player) applied.restoreClick = overrideUserAction(player, "click", clickPlaysOnly);
      // media-session.ts sets its handlers on player.ready, which can come after us
      setPauseHandler(ignorePause);
      return;
    }
    release();
    (container as unknown as ContainerLike | null)?.classList?.add(LOCK_CLASS);
    applied = {
      container,
      restoreClick: player ? overrideUserAction(player, "click", clickPlaysOnly) : undefined,
    };
    // stash's media-session plugin sets its handlers when a player becomes ready
    setPauseHandler(ignorePause);
  }

  function release(): void {
    if (!applied) return;
    (applied.container as unknown as ContainerLike | null)?.classList?.remove(LOCK_CLASS);
    applied.restoreClick?.();
    applied = undefined;
  }

  const onKey = (e: Event) => {
    const k = e as unknown as KeyLike & Event;
    if (handle.paused()) return; // the toggle would play: fine
    if (!isPauseKey(k, playerArea(handle.container()))) return;
    e.preventDefault();
    e.stopPropagation();
    (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
  };

  apply();
  const offContainer = handle.onContainerChange(() => apply());
  // the player may become reachable after the container (video.js sets el.player during creation)
  const offPlay = handle.onEvent("play", () => apply());
  env.window.addEventListener("keydown", onKey, true);
  env.window.addEventListener("keyup", onKey, true);

  return () => {
    offContainer();
    offPlay();
    env.window.removeEventListener("keydown", onKey, true);
    env.window.removeEventListener("keyup", onKey, true);
    release();
    // stash's own mapping (media-session.ts): pause -> player.pause()
    setPauseHandler(() => handle.player()?.pause());
  };
}
