// Hooks for snap flashes, independent of which player shows the video:
// the scene's snap times (from the funscript's "snap" axis) and the
// brightness setting.
import { findAxis } from "../funscript/parse.ts";
import { loadFunscript } from "../funscript/load.ts";
import { snapEvents } from "../funscript/snap.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";
import { snapFlashIntensity } from "./flash.ts";

export const SNAP_AXIS_NAMES = ["snap", "snaps"];

const NONE: number[] = [];

/**
 * Snap times (ms) of the scene's funscript, empty while loading, when the
 * scene has no funscript or no snap axis, or when `enabled` is false (pass
 * the scene's `interactive` flag to skip the request for scenes without one).
 */
export function useSnapEvents(sceneId: string, enabled: boolean): number[] {
  const [events, setEvents] = React.useState<number[]>(NONE);
  React.useEffect(() => {
    setEvents(NONE);
    if (!enabled) return;
    let live = true;
    loadFunscript(sceneId)
      .then((f) => {
        const axis = f && findAxis(f, SNAP_AXIS_NAMES);
        if (live && axis) setEvents(snapEvents(axis));
      })
      .catch(() => undefined); // no flashes is the safe failure
    return () => {
      live = false;
    };
  }, [sceneId, enabled]);
  return events;
}

/** peak opacity 0..1 from the snapFlash setting (default 60 %, 0 = off) */
export function useSnapFlashIntensity(): number {
  return snapFlashIntensity(usePluginSettings().snapFlash);
}
