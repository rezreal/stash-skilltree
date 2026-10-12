import { test } from "node:test";
import assert from "node:assert/strict";
import { SEEK_LOCK_CLASS, SEEK_LOCK_STYLE_ID, isSeekKey, lockSeeking, seekByPlugin, type SeekLockEnv } from "../../src/stashplayer/seekLock.ts";
import type { VideoHandle } from "../../src/stashplayer/videoHandle.ts";

function fakeEnv() {
  const nodes: { id: string; textContent: string | null }[] = [];
  const keyListeners: ((e: Event) => void)[] = [];
  let ms = 0;
  const env: SeekLockEnv = {
    document: {
      getElementById: (id) => nodes.find((n) => n.id === id) ?? null,
      createElement: () => ({ id: "", textContent: null }),
      head: { appendChild: (n) => nodes.push(n as { id: string; textContent: string | null }) },
    },
    window: {
      addEventListener: (_t, fn) => keyListeners.push(fn),
      removeEventListener: (_t, fn) => keyListeners.splice(keyListeners.indexOf(fn), 1),
    },
    now: () => ms,
  };
  return { env, nodes, keyListeners, advance: (sec: number) => (ms += sec * 1000) };
}

function fakeHandle(duration = 600) {
  const listeners = new Map<string, (() => void)[]>();
  const classes = new Set<string>();
  const container = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
  const fire = (name: string) => (listeners.get(name) ?? []).forEach((f) => f());
  const state = { time: 0, paused: true };
  const player = {
    currentTime(sec?: number) {
      if (sec !== undefined) {
        state.time = sec;
        fire("seeking");
      }
      return state.time;
    },
  };
  const handle = {
    player: () => player,
    container: () => container,
    currentTime: () => state.time,
    duration: () => duration,
    paused: () => state.paused,
    onEvent(name: string, cb: () => void) {
      const list = listeners.get(name) ?? [];
      list.push(cb);
      listeners.set(name, list);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb));
    },
    onContainerChange: () => () => undefined,
  } as unknown as VideoHandle;
  const play = () => {
    state.paused = false;
    fire("play");
  };
  /** playback moves on by sec (wall and media time) */
  const tick = (f: ReturnType<typeof fakeEnv>, sec: number) => {
    f.advance(sec);
    state.time += sec;
    fire("timeupdate");
  };
  return { handle, player, state, classes, fire, play, tick };
}

function started(f = fakeEnv(), duration?: number) {
  const h = fakeHandle(duration);
  const release = lockSeeking(h.handle, f.env);
  h.play();
  h.tick(f, 0.25);
  return { f, h, release };
}

test("a seek by the viewer is set straight back", () => {
  const { f, h } = started();
  h.tick(f, 10);
  h.player.currentTime(200);
  assert.equal(h.state.time, 10.25);
  h.player.currentTime(2);
  assert.equal(h.state.time, 10.25, "backwards too");
});

test("a jump without a seeking event (a transcode reload) is caught on the next timeupdate", () => {
  const { f, h } = started();
  h.tick(f, 5);
  h.state.time = 300;
  h.fire("timeupdate");
  assert.equal(h.state.time, 5.25);
});

test("normal playback and stalls pass", () => {
  const { f, h } = started();
  for (let i = 0; i < 20; i++) h.tick(f, 0.25);
  assert.equal(h.state.time, 5.25);
  // a long gap between timeupdates (a background tab) while playing
  h.tick(f, 8);
  assert.equal(h.state.time, 13.25);
});

test("a pause doesn't bank time for a jump forward", () => {
  const { f, h } = started();
  h.state.paused = true;
  f.advance(60);
  h.state.paused = false;
  h.fire("play");
  h.state.time += 30;
  h.fire("timeupdate");
  assert.equal(h.state.time, 0.25);
});

test("the session's own seeks pass", () => {
  const { f, h } = started();
  h.tick(f, 40);
  seekByPlugin(h.handle, 12);
  assert.equal(h.state.time, 12);
  h.tick(f, 0.25);
  assert.equal(h.state.time, 12.25, "playback goes on from there");
  h.player.currentTime(100);
  assert.equal(h.state.time, 12.25, "the allowance was used up");
});

test("stash's start position before playback is left alone", () => {
  const f = fakeEnv();
  const h = fakeHandle();
  lockSeeking(h.handle, f.env);
  h.player.currentTime(90); // ?t=90
  assert.equal(h.state.time, 90);
  h.play();
  h.tick(f, 0.25);
  h.player.currentTime(0);
  assert.equal(h.state.time, 90.25);
});

test("a loop's wrap to the start is not a seek", () => {
  const { f, h } = started(undefined, 20);
  for (let i = 0; i < 79; i++) h.tick(f, 0.25);
  assert.equal(h.state.time, 20);
  h.player.currentTime(0);
  assert.equal(h.state.time, 0);
});

test("class and style on lock, removed on release; seeks stick again", () => {
  const { f, h, release } = started();
  assert.equal(f.nodes[0]?.id, SEEK_LOCK_STYLE_ID);
  assert.ok(h.classes.has(SEEK_LOCK_CLASS));
  assert.equal(f.keyListeners.length, 2);
  release();
  assert.ok(!h.classes.has(SEEK_LOCK_CLASS));
  assert.equal(f.keyListeners.length, 0);
  h.player.currentTime(300);
  assert.equal(h.state.time, 300);
});

test("seek keys count only inside the player area and outside text fields", () => {
  const inside = { closest: () => null, tagName: "DIV" };
  const field = { closest: () => null, tagName: "INPUT", getAttribute: () => "text" };
  const area = { contains: (n: unknown) => n === inside || n === field };
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "0", "7", "j", "L", "MediaFastForward"]) {
    assert.ok(isSeekKey({ key, target: inside }, area), key);
  }
  for (const key of [" ", "ArrowUp", "f", "m", "MediaTrackNext"]) assert.ok(!isSeekKey({ key, target: inside }, area), key);
  assert.ok(!isSeekKey({ key: "ArrowLeft", target: field }, area));
  assert.ok(!isSeekKey({ key: "ArrowLeft", target: {} }, area));
  assert.ok(!isSeekKey({ key: "ArrowLeft", target: inside, ctrlKey: true }, area));
});
