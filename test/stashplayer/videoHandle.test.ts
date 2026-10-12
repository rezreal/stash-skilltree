import { test } from "node:test";
import assert from "node:assert/strict";
import { createVideoHandle, type PauseCause, type VideoHandleEnv, type VideoJsLike } from "../../src/stashplayer/videoHandle.ts";

class FakeVideo {
  tagName = "VIDEO";
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  muted = false;
  volume = 1;
  listeners = new Map<string, Set<(ev: Event) => void>>();
  playCalls = 0;
  pauseCalls = 0;
  addEventListener(name: string, fn: (ev: Event) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }
  removeEventListener(name: string, fn: (ev: Event) => void) {
    this.listeners.get(name)?.delete(fn);
  }
  count(name: string) {
    return this.listeners.get(name)?.size ?? 0;
  }
  fire(name: string) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn({ type: name } as Event);
  }
  play() {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.pauseCalls++;
    this.paused = true;
  }
}

class FakeRoot {
  tagName = "VIDEO-JS";
  parentNode: object;
  player?: unknown;
  video: FakeVideo | null;
  constructor(video: FakeVideo | null, parent: object = { id: "wrapper" }) {
    this.video = video;
    this.parentNode = parent;
  }
  querySelector(sel: string) {
    return sel === "video" ? this.video : null;
  }
}

class FakeObserver {
  static all: FakeObserver[] = [];
  target: unknown = null;
  connected = false;
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeObserver.all.push(this);
  }
  observe(target: unknown) {
    this.target = target;
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

function fakePlayer(root: FakeRoot, over: Partial<VideoJsLike> = {}): VideoJsLike & { scrubbingNow: boolean } {
  const p: VideoJsLike & { scrubbingNow: boolean } = {
    scrubbingNow: false,
    currentTime: () => 100 + (root.video?.currentTime ?? 0), // offset middleware
    duration: () => 600,
    paused: () => root.video?.paused ?? true,
    ended: () => root.video?.ended ?? false,
    muted: () => root.video?.muted ?? false,
    volume: () => root.video?.volume ?? 1,
    play: () => root.video?.play(),
    pause: () => root.video?.pause(),
    el: () => root as unknown as Element,
    isDisposed: () => false,
    scrubbing: (): boolean => p.scrubbingNow,
    ...over,
  };
  return p;
}

function setup(rootInit: FakeRoot | null, extra: Partial<VideoHandleEnv> = {}) {
  FakeObserver.all = [];
  let root: FakeRoot | null = rootInit;
  let t = 10_000;
  const body = { id: "body" };
  const handle = createVideoHandle(() => root as unknown as Element | null, {
    MutationObserver: FakeObserver,
    fallbackScope: () => body as unknown as Node,
    now: () => t,
    ...extra,
  });
  return {
    handle,
    body,
    setRoot: (r: FakeRoot | null) => {
      root = r;
    },
    advance: (ms: number) => {
      t += ms;
    },
    observer: () => FakeObserver.all.filter((o) => o.connected),
    mutate: () => {
      for (const o of FakeObserver.all.filter((x) => x.connected)) o.cb();
    },
  };
}

test("reads the media element when there is no video.js player", () => {
  const v = new FakeVideo();
  v.currentTime = 12;
  v.duration = 300;
  v.muted = true;
  v.volume = 0.5;
  const { handle } = setup(new FakeRoot(v));
  assert.equal(handle.currentTime(), 12);
  assert.equal(handle.duration(), 300);
  assert.equal(handle.paused(), true);
  assert.equal(handle.muted(), true);
  assert.equal(handle.volume(), 0.5);
  assert.equal(handle.video(), v as unknown);
});

test("prefers the video.js player on the root (offset-corrected time and file duration)", () => {
  const v = new FakeVideo();
  v.currentTime = 5;
  v.duration = Number.POSITIVE_INFINITY;
  const root = new FakeRoot(v);
  root.player = fakePlayer(root);
  const { handle } = setup(root);
  assert.equal(handle.currentTime(), 105);
  assert.equal(handle.duration(), 600);
});

test("a disposed player, or one belonging to another element, is ignored", () => {
  const v = new FakeVideo();
  v.currentTime = 7;
  const root = new FakeRoot(v);
  root.player = fakePlayer(root, { isDisposed: () => true });
  const other = fakePlayer(new FakeRoot(new FakeVideo()));
  const { handle } = setup(root, { getPlayer: () => other });
  assert.equal(handle.currentTime(), 7);
  assert.equal(handle.player(), null);
});

test("falls back to getPlayer when it owns this root", () => {
  const root = new FakeRoot(new FakeVideo());
  const p = fakePlayer(root);
  const { handle } = setup(root, { getPlayer: () => p });
  assert.equal(handle.player(), p);
});

test("unknown duration is NaN, missing elements give safe defaults", () => {
  const { handle } = setup(null);
  assert.ok(Number.isNaN(handle.duration()));
  assert.equal(handle.currentTime(), 0);
  assert.equal(handle.paused(), true);
  assert.equal(handle.video(), null);
  assert.equal(handle.container(), null);
});

test("play and pause go through the player when present", async () => {
  const v = new FakeVideo();
  const root = new FakeRoot(v);
  let playerPlays = 0;
  const p = fakePlayer(root, {
    play: () => {
      playerPlays++;
      return v.play();
    },
  });
  root.player = p;
  const { handle } = setup(root);
  assert.equal(await handle.play(), true);
  assert.equal(playerPlays, 1);
  handle.pause();
  assert.equal(v.paused, true);
});

test("play never rejects", async () => {
  const v = new FakeVideo();
  v.play = () => Promise.reject(new Error("NotAllowedError"));
  const { handle } = setup(new FakeRoot(v));
  assert.equal(await handle.play(), false);
  assert.equal(await setup(null).handle.play(), false);
});

test("events follow a replaced <video> element", () => {
  const v1 = new FakeVideo();
  const root = new FakeRoot(v1);
  const { handle, mutate } = setup(root);
  const seen: string[] = [];
  handle.onEvent("timeupdate", (ev) => seen.push(`a:${ev.type}`));
  v1.fire("timeupdate");
  assert.deepEqual(seen, ["a:timeupdate"]);

  const v2 = new FakeVideo();
  root.video = v2;
  mutate();
  assert.equal(v1.count("timeupdate"), 0);
  v1.fire("timeupdate");
  v2.fire("timeupdate");
  assert.deepEqual(seen, ["a:timeupdate", "a:timeupdate"]);
});

test("rebinding also happens on the next access without an observer", () => {
  const v1 = new FakeVideo();
  const root = new FakeRoot(v1);
  const { handle } = setup(root, { MutationObserver: undefined });
  let n = 0;
  handle.onEvent("ended", () => n++);
  const v2 = new FakeVideo();
  root.video = v2;
  handle.currentTime();
  v2.fire("ended");
  assert.equal(n, 1);
  assert.equal(v1.count("ended"), 0);
});

test("a root that appears late is picked up; the observer moves from the fallback scope to the wrapper", () => {
  const ctx = setup(null);
  let n = 0;
  const changes: unknown[] = [];
  ctx.handle.onEvent("play", () => n++);
  ctx.handle.onContainerChange((c) => changes.push(c));
  assert.equal(ctx.observer().length, 1);
  assert.equal(ctx.observer()[0].target, ctx.body);

  const v = new FakeVideo();
  const wrapper = { id: "wrapper" };
  const root = new FakeRoot(v, wrapper);
  ctx.setRoot(root);
  ctx.mutate();
  assert.deepEqual(changes, [root]);
  assert.equal(ctx.observer().length, 1);
  assert.equal(ctx.observer()[0].target, wrapper);
  v.fire("play");
  assert.equal(n, 1);
});

test("a re-created player (new root) is reported and followed", () => {
  const wrapper = { id: "wrapper" };
  const r1 = new FakeRoot(new FakeVideo(), wrapper);
  const ctx = setup(r1);
  const changes: unknown[] = [];
  ctx.handle.onContainerChange((c) => changes.push(c));
  assert.equal(ctx.handle.container(), r1 as unknown);
  const r2 = new FakeRoot(new FakeVideo(), wrapper);
  ctx.setRoot(r2);
  ctx.mutate();
  assert.deepEqual(changes, [r2]);
  assert.equal(ctx.handle.container(), r2 as unknown);
});

test("the observer only runs while someone listens", () => {
  const ctx = setup(new FakeRoot(new FakeVideo()));
  ctx.handle.currentTime();
  assert.equal(ctx.observer().length, 0);
  const off = ctx.handle.onEvent("pause", () => undefined);
  assert.equal(ctx.observer().length, 1);
  off();
  assert.equal(ctx.observer().length, 0);
});

test("unsubscribing removes the native listener; internal ones stay while bound", () => {
  const v = new FakeVideo();
  const { handle } = setup(new FakeRoot(v));
  const off = handle.onEvent("timeupdate", () => undefined);
  assert.equal(v.count("timeupdate"), 1);
  off();
  assert.equal(v.count("timeupdate"), 0);
  assert.equal(v.count("pause"), 1);
});

test("dispose removes every listener and stops observing", () => {
  const v = new FakeVideo();
  const ctx = setup(new FakeRoot(v));
  ctx.handle.onEvent("ended", () => undefined);
  ctx.handle.onPause(() => undefined);
  ctx.handle.dispose();
  for (const name of ["ended", "pause", "play", "loadstart", "seeking"]) assert.equal(v.count(name), 0, name);
  assert.equal(ctx.observer().length, 0);
  assert.equal(ctx.handle.container(), null);
});

// --- pause causes ---------------------------------------------------------------

function pauseSetup() {
  const v = new FakeVideo();
  const root = new FakeRoot(v);
  const p = fakePlayer(root);
  root.player = p;
  const ctx = setup(root);
  const causes: PauseCause[] = [];
  ctx.handle.onPause((c) => causes.push(c));
  return { ...ctx, v, p, causes };
}

test("pause({ byPlugin }) marks only the next pause event", async () => {
  const s = pauseSetup();
  await s.handle.play();
  s.v.fire("play");
  s.handle.pause({ byPlugin: true });
  s.v.fire("pause");
  s.v.paused = false;
  s.v.fire("pause"); // the viewer, later
  assert.deepEqual(s.causes, ["plugin", "other"]);
});

test("a plugin pause while already paused leaves no stale flag", () => {
  const s = pauseSetup();
  s.handle.pause({ byPlugin: true }); // already paused: no event will come
  s.v.fire("pause");
  assert.deepEqual(s.causes, ["other"]);
});

test("a play event clears a pending plugin pause", async () => {
  const s = pauseSetup();
  await s.handle.play();
  s.handle.pause({ byPlugin: true });
  s.v.fire("play"); // the pause never produced an event, playback went on
  s.v.fire("pause");
  assert.deepEqual(s.causes, ["other"]);
});

test("a plain pause() is not marked", async () => {
  const s = pauseSetup();
  await s.handle.play();
  s.handle.pause();
  s.v.fire("pause");
  assert.deepEqual(s.causes, ["other"]);
});

test("the pause right before 'ended' is classified as end", () => {
  const s = pauseSetup();
  s.v.ended = true;
  s.v.fire("pause");
  assert.deepEqual(s.causes, ["end"]);
});

test("video.js progress-bar scrubbing and source reloads are seeks", () => {
  const s = pauseSetup();
  s.p.scrubbingNow = true;
  s.v.fire("pause");
  s.p.scrubbingNow = false;
  s.advance(5000);
  s.v.fire("loadstart"); // live.ts reloads the transcode with ?start=
  s.advance(500);
  s.v.fire("pause");
  s.advance(3000);
  s.v.fire("pause");
  assert.deepEqual(s.causes, ["seek", "seek", "other"]);
});

test("onEvent('pause') subscribers still get every pause", () => {
  const s = pauseSetup();
  let n = 0;
  s.handle.onEvent("pause", () => n++);
  s.v.fire("pause");
  assert.equal(n, 1);
  assert.deepEqual(s.causes, ["other"]);
});
