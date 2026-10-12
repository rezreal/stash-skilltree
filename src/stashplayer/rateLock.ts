// Playback speed is fixed at 1x while a Skilltree session runs. Watching at
// 2x would halve the time a clip demands attention, so the speed menu is
// hidden and any change of rate - from the menu, a hotkey, the media
// session or another plugin - is set straight back.
import type { VideoHandle } from "./videoHandle.ts";

export const RATE_LOCK_CLASS = "skilltree-norate";
export const RATE_LOCK_STYLE_ID = "skilltree-stashplayer-norate";

export const RATE_LOCK_CSS = `
.video-js.${RATE_LOCK_CLASS} .vjs-playback-rate {
  display: none !important;
}
`;

/** the parts of video.js used here (playbackRate is a getter/setter) */
interface RatePlayer {
  playbackRate?(rate?: number): number;
  defaultPlaybackRate?(rate?: number): number;
}

interface RateMedia {
  playbackRate: number;
  defaultPlaybackRate: number;
}

export interface RateLockEnv {
  document: {
    getElementById(id: string): unknown;
    createElement(tag: string): { id: string; textContent: string | null };
    head: { appendChild(node: unknown): unknown } | null;
  };
}

interface ContainerLike {
  classList?: { add(c: string): void; remove(c: string): void };
}

function ensureStyle(doc: RateLockEnv["document"]): void {
  if (doc.getElementById(RATE_LOCK_STYLE_ID) || !doc.head) return;
  const style = doc.createElement("style");
  style.id = RATE_LOCK_STYLE_ID;
  style.textContent = RATE_LOCK_CSS;
  doc.head.appendChild(style);
}

function currentRate(handle: VideoHandle): number | undefined {
  const player = handle.player() as unknown as RatePlayer | null;
  if (player?.playbackRate) return player.playbackRate();
  const video = handle.video() as unknown as RateMedia | null;
  return video ? video.playbackRate : undefined;
}

/** Sets the rate back to 1 through video.js when reachable, so its menu agrees. */
export function resetRate(handle: VideoHandle): void {
  const player = handle.player() as unknown as RatePlayer | null;
  if (player?.playbackRate) {
    player.playbackRate(1);
    player.defaultPlaybackRate?.(1);
  }
  const video = handle.video() as unknown as RateMedia | null;
  if (video) {
    if (video.playbackRate !== 1) video.playbackRate = 1;
    if (video.defaultPlaybackRate !== 1) video.defaultPlaybackRate = 1;
  }
}

export function lockPlaybackRate(handle: VideoHandle, env?: RateLockEnv): () => void {
  const doc = env?.document ?? (typeof document !== "undefined" ? (document as unknown as RateLockEnv["document"]) : undefined);
  if (doc) ensureStyle(doc);

  let container: ContainerLike | null = null;
  const apply = () => {
    const next = handle.container() as unknown as ContainerLike | null;
    if (next !== container) {
      container?.classList?.remove(RATE_LOCK_CLASS);
      next?.classList?.add(RATE_LOCK_CLASS);
      container = next;
    }
    if (currentRate(handle) !== 1) resetRate(handle);
  };

  apply();
  const offRate = handle.onEvent("ratechange", () => {
    if (currentRate(handle) !== 1) resetRate(handle);
  });
  // a new source or a re-created player may come up with its own rate
  const offPlay = handle.onEvent("play", apply);
  const offMeta = handle.onEvent("loadedmetadata", apply);
  const offContainer = handle.onContainerChange(apply);

  return () => {
    offRate();
    offPlay();
    offMeta();
    offContainer();
    container?.classList?.remove(RATE_LOCK_CLASS);
    container = null;
  };
}
