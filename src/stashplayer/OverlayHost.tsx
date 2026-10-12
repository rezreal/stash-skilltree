// Renders children inside stash's video.js root, so they sit over the video
// and stay visible in fullscreen (video.js makes that root the fullscreen
// element). The host fills the player and lets clicks through
// (pointer-events: none); interactive children set pointer-events: auto,
// e.g. by wrapping themselves in <OverlayInteractive>.
import type { ReactNode } from "react";
import { stashPlayerApi } from "./api.ts";
import { createHost, inOverlay, placeHost } from "./overlayDom.ts";
import { overrideUserAction, userAction } from "./playerOptions.ts";
import type { VideoHandle, VideoJsLike } from "./videoHandle.ts";

export function OverlayHost(props: { handle: VideoHandle; className?: string; children?: ReactNode }) {
  const { handle, className } = props;
  const [host] = React.useState(() => createHost(document));

  React.useEffect(() => {
    if (className) host.classList.add(...className.split(/\s+/).filter(Boolean));
    return () => {
      if (className) host.classList.remove(...className.split(/\s+/).filter(Boolean));
    };
  }, [host, className]);

  React.useEffect(() => {
    // keys typed into the overlay must not drive the player: wrap stash's
    // video.js hotkeys (Space/Enter/arrows/digits/f/m...) so they skip events
    // from inside the host. Their bubbling is not stopped: React (attached at
    // the app root) still has to see them, and so do window listeners (Esc).
    let guarded: VideoJsLike | null = null;
    let restoreHotkeys: (() => void) | undefined;
    const guard = () => {
      const p = handle.player();
      if (p === guarded) return;
      restoreHotkeys?.();
      restoreHotkeys = undefined;
      guarded = p;
      const original = p ? userAction(p, "hotkeys") : undefined;
      if (!p || typeof original !== "function") return;
      restoreHotkeys = overrideUserAction(p, "hotkeys", function (this: VideoJsLike, event: Event) {
        if (inOverlay(event.target)) return;
        return (original as (this: VideoJsLike, e: Event) => unknown).call(this, event);
      });
    };
    const place = () => {
      placeHost(host, handle.container());
      guard();
    };
    place();
    const offContainer = handle.onContainerChange(place);
    // video.js sets root.player during creation; catch it once media starts loading
    const offLoad = handle.onEvent("loadstart", guard);
    return () => {
      offContainer();
      offLoad();
      restoreHotkeys?.();
      placeHost(host, null);
    };
  }, [handle, host]);

  return stashPlayerApi().ReactDOM.createPortal(<>{props.children}</>, host);
}

/** a box inside the overlay that takes clicks */
export function OverlayInteractive(props: { className?: string; style?: Record<string, string | number>; children?: ReactNode }) {
  return (
    <div className={props.className} style={{ pointerEvents: "auto", ...props.style }}>
      {props.children}
    </div>
  );
}
