import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LOCK_CLASS, RATE_LOCK_STYLE_ID, lockPlaybackRate, type RateLockEnv } from "../../src/stashplayer/rateLock.ts";
import type { VideoHandle } from "../../src/stashplayer/videoHandle.ts";

function fakeDoc() {
  const nodes: { id: string; textContent: string | null }[] = [];
  const doc: RateLockEnv["document"] = {
    getElementById: (id) => nodes.find((n) => n.id === id) ?? null,
    createElement: () => ({ id: "", textContent: null }),
    head: { appendChild: (n) => nodes.push(n as { id: string; textContent: string | null }) },
  };
  return { doc, nodes };
}

function fakeContainer() {
  const classes = new Set<string>();
  return { classes, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
}

function fakeHandle(withPlayer: boolean) {
  const listeners = new Map<string, (() => void)[]>();
  const video = { playbackRate: 1, defaultPlaybackRate: 1 };
  let rate = 1;
  const player = withPlayer
    ? {
        playbackRate(r?: number) {
          if (r !== undefined) {
            rate = r;
            video.playbackRate = r;
          }
          return rate;
        },
        defaultPlaybackRate(r?: number) {
          if (r !== undefined) video.defaultPlaybackRate = r;
          return video.defaultPlaybackRate;
        },
      }
    : null;
  const container = fakeContainer();
  const handle = {
    video: () => video,
    player: () => player,
    container: () => container,
    onEvent(name: string, cb: () => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb));
    },
    onContainerChange: () => () => undefined,
  } as unknown as VideoHandle;
  const fire = (name: string) => (listeners.get(name) ?? []).forEach((f) => f());
  const setRate = (r: number) => {
    if (player) player.playbackRate(r);
    else video.playbackRate = r;
    fire("ratechange");
  };
  return { handle, video, container, fire, setRate, listeners };
}

test("a changed rate is set straight back to 1 through video.js", () => {
  const { doc, nodes } = fakeDoc();
  const h = fakeHandle(true);
  const release = lockPlaybackRate(h.handle, { document: doc });
  assert.equal(nodes[0]?.id, RATE_LOCK_STYLE_ID);
  assert.ok(h.container.classes.has(RATE_LOCK_CLASS));
  h.setRate(2);
  assert.equal(h.video.playbackRate, 1);
  release();
  assert.ok(!h.container.classes.has(RATE_LOCK_CLASS));
  h.setRate(1.5);
  assert.equal(h.video.playbackRate, 1.5, "released: rate changes stick again");
});

test("without a reachable video.js player the element is reset", () => {
  const { doc } = fakeDoc();
  const h = fakeHandle(false);
  h.video.playbackRate = 2;
  lockPlaybackRate(h.handle, { document: doc });
  assert.equal(h.video.playbackRate, 1, "an existing rate is reset on lock");
  h.setRate(0.5);
  assert.equal(h.video.playbackRate, 1);
});

test("the style is added once for several locks", () => {
  const { doc, nodes } = fakeDoc();
  lockPlaybackRate(fakeHandle(true).handle, { document: doc });
  lockPlaybackRate(fakeHandle(true).handle, { document: doc });
  assert.equal(nodes.length, 1);
});
