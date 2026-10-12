// DOM side of OverlayHost: where the host element goes inside video.js.
import { OVERLAY_ATTR } from "./pauseLock.ts";

interface NodeLike {
  parentNode: NodeLike | null;
  appendChild(node: NodeLike): unknown;
  insertBefore(node: NodeLike, ref: NodeLike | null): unknown;
  removeChild(node: NodeLike): unknown;
  querySelector?(selector: string): NodeLike | null;
  contains?(node: unknown): boolean;
}

export const OVERLAY_CLASS = "skilltree-stash-overlay";

/** fills the player, lets clicks through; children opt in with pointer-events: auto */
export const OVERLAY_STYLE: Record<string, string> = {
  position: "absolute",
  top: "0",
  right: "0",
  bottom: "0",
  left: "0",
  pointerEvents: "none",
  overflow: "hidden",
};

export function createHost(doc: { createElement(tag: string): HTMLElement }): HTMLElement {
  const host = doc.createElement("div");
  host.className = OVERLAY_CLASS;
  host.setAttribute(OVERLAY_ATTR, "");
  Object.assign(host.style, OVERLAY_STYLE);
  return host;
}

/**
 * Puts the host into the video.js root, right before the control bar: above
 * the video, poster, captions, spinner and big play button, below the
 * control bar, error display and video.js dialogs (same z-level, DOM order).
 * The root is what video.js makes fullscreen, so the overlay stays visible.
 * Without a container the host is detached. Returns true if it moved.
 */
export function placeHost(host: NodeLike, container: NodeLike | null): boolean {
  if (!container) {
    if (host.parentNode) {
      host.parentNode.removeChild(host);
      return true;
    }
    return false;
  }
  const bar = container.querySelector?.(".vjs-control-bar") ?? null;
  const ref = bar && bar.parentNode === container ? bar : null;
  if (host.parentNode === container) return false;
  if (host.parentNode) host.parentNode.removeChild(host);
  if (ref) container.insertBefore(host, ref);
  else container.appendChild(host);
  return true;
}

/** is this element inside an overlay host (used to keep player hotkeys out of overlay input) */
export function inOverlay(target: unknown): boolean {
  const el = target as { closest?(s: string): unknown } | null;
  return !!el?.closest?.(`[${OVERLAY_ATTR}]`);
}
