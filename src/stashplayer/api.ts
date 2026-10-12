// The parts of window.PluginApi the stash-player integration needs on top of
// src/ui/pluginApi.ts (ReactDOM, InteractiveUtils).
import type * as ReactTypes from "react";
import { pluginApi, type PluginApiShape } from "../ui/pluginApi.ts";

export interface StashPlayerApi {
  ReactDOM: {
    createPortal(children: ReactTypes.ReactNode, container: Element): ReactTypes.ReactPortal;
  };
  patch: PluginApiShape["patch"];
  utils: {
    /** stash's hooks/Interactive/utils.ts; getPlayer() = videojs.getPlayer("VideoJsPlayer") */
    InteractiveUtils?: { getPlayer?: () => unknown };
  };
}

export function stashPlayerApi(): StashPlayerApi {
  return pluginApi() as unknown as StashPlayerApi;
}

/** ScenePlayer/util.ts: the id of the video.js root (<video-js>) */
export const VIDEO_PLAYER_ID = "VideoJsPlayer";

export function playerRoot(): Element | null {
  return document.getElementById(VIDEO_PLAYER_ID);
}

export function interactivePlayer(): unknown {
  return stashPlayerApi().utils?.InteractiveUtils?.getPlayer?.();
}
