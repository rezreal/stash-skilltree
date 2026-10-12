import { test } from "node:test";
import assert from "node:assert/strict";
import { enterFullscreen, PLAYER_WAIT_MS, wantsAutoFullscreen, type FullscreenEnv } from "../../src/stashplayer/autoFullscreen.ts";
import type { VideoHandle, VideoJsLike } from "../../src/stashplayer/videoHandle.ts";

type Handle = Pick<VideoHandle, "player" | "container">;

function env(over: Partial<FullscreenEnv> = {}): FullscreenEnv & { slept: number } {
  const e = {
    document: { fullscreenElement: null, fullscreenEnabled: true },
    userActivation: { isActive: true },
    slept: 0,
    ...over,
  };
  e.sleep = async (ms: number) => {
    e.slept += ms;
  };
  return e;
}

function playerHandle(request: () => Promise<void> | void): { handle: Handle; calls: () => number } {
  let n = 0;
  const player = {
    requestFullscreen: () => {
      n++;
      return request();
    },
  } as unknown as VideoJsLike;
  return { handle: { player: () => player, container: () => null }, calls: () => n };
}

test("wantsAutoFullscreen: watched clips with the setting on, never loops", () => {
  assert.equal(wantsAutoFullscreen({ loop: false }, true), true);
  assert.equal(wantsAutoFullscreen({ loop: true }, true), false);
  assert.equal(wantsAutoFullscreen({ loop: false }, false), false);
});

test("asks the video.js player while the click still counts", async () => {
  const { handle, calls } = playerHandle(async () => undefined);
  assert.equal(await enterFullscreen(handle, env()), "entered");
  assert.equal(calls(), 1);
});

test("falls back to the container without a player", async () => {
  let n = 0;
  const container = { requestFullscreen: async () => void n++ } as unknown as HTMLElement;
  assert.equal(await enterFullscreen({ player: () => null, container: () => container }, env()), "entered");
  assert.equal(n, 1);
});

test("asks nothing without a user activation or when already fullscreen", async () => {
  const { handle, calls } = playerHandle(async () => undefined);
  assert.equal(await enterFullscreen(handle, env({ userActivation: { isActive: false } })), "no-activation");
  assert.equal(await enterFullscreen(handle, env({ document: { fullscreenElement: {} } })), "already");
  assert.equal(await enterFullscreen(handle, env({ document: { fullscreenElement: null, fullscreenEnabled: false } })), "refused");
  assert.equal(calls(), 0);
});

test("a refusal is reported, not thrown", async () => {
  const { handle } = playerHandle(async () => {
    throw new TypeError("Permissions check failed");
  });
  assert.equal(await enterFullscreen(handle, env()), "refused");
  const sync = playerHandle(() => {
    throw new Error("nope");
  });
  assert.equal(await enterFullscreen(sync.handle, env()), "refused");
});

test("waits a little for the player, then gives up", async () => {
  let tries = 0;
  const player = { requestFullscreen: async () => undefined } as unknown as VideoJsLike;
  const later: Handle = { player: () => (++tries >= 3 ? player : null), container: () => null };
  const e = env();
  assert.equal(await enterFullscreen(later, e), "entered");
  assert.equal(e.slept, 200);

  const never = env();
  assert.equal(await enterFullscreen({ player: () => null, container: () => null }, never), "no-player");
  assert.equal(never.slept, PLAYER_WAIT_MS);
});

test("stops waiting once the activation has run out", async () => {
  const activation = { isActive: true };
  const e = env({ userActivation: activation });
  let tries = 0;
  const handle: Handle = {
    player: () => {
      if (++tries === 2) activation.isActive = false;
      return null;
    },
    container: () => null,
  };
  assert.equal(await enterFullscreen(handle, e), "no-activation");
});
