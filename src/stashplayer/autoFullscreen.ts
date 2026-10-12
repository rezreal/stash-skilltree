// Ranked clips start fullscreen. The viewer's "Watch" click on the choice
// screen is still a fresh user activation when stash's scene page mounts
// the player (an in-app navigation keeps it; Chrome for about 5 s), and
// browsers only allow fullscreen with one. So the session asks the player to
// go fullscreen as soon as it is there.
//
// Without the activation (page reloaded, a slow load, the sensor picker used
// it up) the request is not made, nothing else happens, and stash's own
// fullscreen button still works. Exposure loops are left alone: they may run
// in a background tab. Pure apart from the injected environment.
import type { VideoHandle } from "./videoHandle.ts";

export type FullscreenOutcome = "entered" | "already" | "no-activation" | "no-player" | "refused";

export interface FullscreenEnv {
  document: { fullscreenElement: unknown; fullscreenEnabled?: boolean };
  /** navigator.userActivation; undefined where the browser doesn't expose it */
  userActivation?: { isActive: boolean };
  /** waits between looks for the player, ms */
  sleep?: (ms: number) => Promise<void>;
}

/** how long to wait for the player to appear, ms */
export const PLAYER_WAIT_MS = 2000;
const STEP_MS = 100;

export function wantsAutoFullscreen(mode: { loop: boolean }, setting: boolean): boolean {
  return setting && !mode.loop;
}

const hasActivation = (env: FullscreenEnv): boolean => env.userActivation?.isActive !== false;

/**
 * Puts the player (or its container) into fullscreen while the activation
 * lasts. Never rejects.
 */
export async function enterFullscreen(
  handle: Pick<VideoHandle, "player" | "container">,
  env: FullscreenEnv = browserEnv(),
): Promise<FullscreenOutcome> {
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (env.document.fullscreenElement) return "already";
  if (env.document.fullscreenEnabled === false) return "refused";
  for (let waited = 0; ; waited += STEP_MS) {
    if (!hasActivation(env)) return "no-activation";
    const player = handle.player();
    const container = handle.container();
    try {
      if (player?.requestFullscreen) {
        await player.requestFullscreen();
        return "entered";
      }
      if (container) {
        await container.requestFullscreen();
        return "entered";
      }
    } catch {
      return "refused";
    }
    if (waited >= PLAYER_WAIT_MS) return "no-player";
    await sleep(STEP_MS);
  }
}

function browserEnv(): FullscreenEnv {
  const nav = globalThis.navigator as (Navigator & { userActivation?: { isActive: boolean } }) | undefined;
  const env: FullscreenEnv = { document: globalThis.document };
  if (nav?.userActivation) env.userActivation = nav.userActivation;
  return env;
}
