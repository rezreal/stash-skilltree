import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCK_CLASS, LOCK_STYLE_ID, OVERLAY_ATTR, isPauseKey, lockUserPause, type PauseLockEnv } from "../../src/stashplayer/pauseLock.ts";
import { createHost, inOverlay, placeHost } from "../../src/stashplayer/overlayDom.ts";
import type { VideoHandle, VideoJsLike } from "../../src/stashplayer/videoHandle.ts";

// --- a few fake elements -------------------------------------------------------

class El {
  tagName: string;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  children: El[] = [];
  parentNode: El | null = null;
  isContentEditable = false;
  constructor(tagName: string, opts: { classes?: string[]; attrs?: Record<string, string> } = {}) {
    this.tagName = tagName.toUpperCase();
    for (const c of opts.classes ?? []) this.classes.add(c);
    for (const [k, v] of Object.entries(opts.attrs ?? {})) this.attrs.set(k, v);
  }
  get classList() {
    return { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c) };
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  appendChild(c: El) {
    c.parentNode?.removeChild(c);
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  insertBefore(c: El, ref: El | null) {
    c.parentNode?.removeChild(c);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: El) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  matches(sel: string): boolean {
    return sel.split(",").some((s) => {
      s = s.trim();
      if (s.startsWith(".")) return this.classes.has(s.slice(1));
      if (s.startsWith("[")) return this.attrs.has(s.slice(1, -1));
      return this.tagName === s.toUpperCase();
    });
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parentNode) if (e.matches(sel)) return e;
    return null;
  }
  contains(n: unknown): boolean {
    for (let e = n as El | null; e; e = e.parentNode) if (e === this) return true;
    return false;
  }
  querySelector(sel: string): El | null {
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }
}

function tree() {
  const videoPlayer = new El("div", { classes: ["VideoPlayer"] });
  const wrapper = videoPlayer.appendChild(new El("div", { classes: ["video-wrapper"] }));
  const root = wrapper.appendChild(new El("video-js", { classes: ["video-js"] }));
  const tech = root.appendChild(new El("video", { classes: ["vjs-tech"] }));
  const poster = root.appendChild(new El("div", { classes: ["vjs-poster"] }));
  const bar = root.appendChild(new El("div", { classes: ["vjs-control-bar"] }));
  const playBtn = bar.appendChild(new El("button", { classes: ["vjs-play-control"] }));
  const fsBtn = bar.appendChild(new El("button", { classes: ["vjs-fullscreen-control"] }));
  const scrubber = videoPlayer.appendChild(new El("div", { classes: ["scrubber"] }));
  const outside = new El("button");
  return { videoPlayer, wrapper, root, tech, poster, bar, playBtn, fsBtn, scrubber, outside };
}

const key = (k: string, target: unknown, extra: Record<string, unknown> = {}) => ({ key: k, target, ...extra });

// --- isPauseKey ------------------------------------------------------------------

test("Space, k and media keys inside the player area are pause keys", () => {
  const t = tree();
  assert.equal(isPauseKey(key(" ", t.root), t.videoPlayer), true);
  assert.equal(isPauseKey(key("x", t.root, { code: "Space" }), t.videoPlayer), true);
  assert.equal(isPauseKey(key("k", t.tech), t.videoPlayer), true);
  assert.equal(isPauseKey(key("MediaPlayPause", t.root), t.videoPlayer), true);
  assert.equal(isPauseKey(key(" ", t.scrubber), t.videoPlayer), true, "stash's onKeyDownCapture covers the scrubber too");
  assert.equal(isPauseKey(key(" ", t.fsBtn), t.videoPlayer), true, "stash toggles on Space even on a focused button");
});

test("keys outside the area, in fields, with modifiers or from the overlay are left alone", () => {
  const t = tree();
  assert.equal(isPauseKey(key(" ", t.outside), t.videoPlayer), false);
  assert.equal(isPauseKey(key(" ", t.root), null), false);
  const input = t.root.appendChild(new El("input", { attrs: { type: "text" } }));
  assert.equal(isPauseKey(key(" ", input), t.videoPlayer), false);
  const checkbox = t.root.appendChild(new El("input", { attrs: { type: "checkbox" } }));
  assert.equal(isPauseKey(key(" ", checkbox), t.videoPlayer), true);
  assert.equal(isPauseKey(key(" ", t.root, { ctrlKey: true }), t.videoPlayer), false);
  assert.equal(isPauseKey(key("K", t.root, { shiftKey: true }), t.videoPlayer), false);
  const overlay = t.root.appendChild(new El("div", { attrs: { [OVERLAY_ATTR]: "" } }));
  const btn = overlay.appendChild(new El("button"));
  assert.equal(isPauseKey(key(" ", btn), t.videoPlayer), false);
  assert.equal(isPauseKey(key("Escape", t.root), t.videoPlayer), false);
  assert.equal(isPauseKey(key("ArrowRight", t.root), t.videoPlayer), false);
});

test("Enter is blocked on the player itself and the play buttons, not on other buttons", () => {
  const t = tree();
  assert.equal(isPauseKey(key("Enter", t.root), t.videoPlayer), true);
  assert.equal(isPauseKey(key("Enter", t.playBtn), t.videoPlayer), true);
  assert.equal(isPauseKey(key("Enter", t.fsBtn), t.videoPlayer), false);
});

// --- lockUserPause ---------------------------------------------------------------

function fakeEnv() {
  const winListeners = new Set<string>();
  const handlers = new Map<string, ((e: Event) => void)[]>();
  const head: unknown[] = [];
  const byId = new Map<string, unknown>();
  const session = new Map<string, (() => void) | null>();
  const env: PauseLockEnv = {
    window: {
      addEventListener: (type, fn, capture) => {
        assert.equal(capture, true);
        winListeners.add(type);
        handlers.set(type, [...(handlers.get(type) ?? []), fn]);
      },
      removeEventListener: (type, fn) => {
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((f) => f !== fn),
        );
      },
    },
    document: {
      getElementById: (id) => byId.get(id) ?? null,
      createElement: () => ({ id: "", textContent: "" }),
      head: {
        appendChild: (n) => {
          head.push(n);
          byId.set((n as { id: string }).id, n);
          return n;
        },
      },
    },
    mediaSession: { setActionHandler: (a, h) => void session.set(a, h) },
  };
  const fire = (type: string, e: Record<string, unknown>) => {
    const ev = {
      ...e,
      prevented: false,
      stopped: false,
      preventDefault() {
        ev.prevented = true;
      },
      stopPropagation() {
        ev.stopped = true;
      },
    };
    for (const fn of handlers.get(type) ?? []) fn(ev as unknown as Event);
    return ev;
  };
  return { env, head, session, fire, count: (type: string) => (handlers.get(type) ?? []).length };
}

function fakeHandle(container: El | null, player: VideoJsLike | null) {
  const containerCbs: ((c: HTMLElement | null) => void)[] = [];
  const playCbs: (() => void)[] = [];
  const state = { container, player, paused: false };
  const handle = {
    container: () => state.container as unknown as HTMLElement | null,
    player: () => state.player,
    paused: () => state.paused,
    onContainerChange: (cb: (c: HTMLElement | null) => void) => {
      containerCbs.push(cb);
      return () => containerCbs.splice(containerCbs.indexOf(cb), 1);
    },
    onEvent: (_name: string, cb: () => void) => {
      playCbs.push(cb);
      return () => playCbs.splice(playCbs.indexOf(cb), 1);
    },
  } as unknown as VideoHandle;
  return {
    handle,
    state,
    changeContainer: (c: El | null, p: VideoJsLike | null) => {
      state.container = c;
      state.player = p;
      for (const cb of [...containerCbs]) cb(c as unknown as HTMLElement | null);
    },
    firePlay: () => playCbs.forEach((cb) => cb()),
    listenerCount: () => containerCbs.length + playCbs.length,
  };
}

function playerWithClick() {
  let plays = 0;
  let pauses = 0;
  let paused = false;
  const p = {
    options_: { userActions: { hotkeys: () => undefined } as Record<string, unknown> },
    paused: () => paused,
    play: () => {
      plays++;
      paused = false;
      return Promise.resolve();
    },
    pause: () => {
      pauses++;
      paused = true;
    },
  } as unknown as VideoJsLike;
  return {
    p,
    setPaused: (v: boolean) => {
      paused = v;
    },
    plays: () => plays,
    pauses: () => pauses,
  };
}

test("lockUserPause marks the container, makes clicks play-only and installs the style once", () => {
  const t = tree();
  const pl = playerWithClick();
  const { env, head } = fakeEnv();
  const h = fakeHandle(t.root, pl.p);
  const unlock = lockUserPause(h.handle, env);
  assert.ok(t.root.classes.has(LOCK_CLASS));
  assert.equal(head.length, 1);
  assert.equal((head[0] as { id: string }).id, LOCK_STYLE_ID);

  const click = pl.p.options_!.userActions!.click as (this: VideoJsLike) => void;
  assert.equal(typeof click, "function");
  click.call(pl.p); // playing: no pause
  assert.equal(pl.pauses(), 0);
  pl.setPaused(true);
  click.call(pl.p); // paused: plays
  assert.equal(pl.plays(), 1);

  lockUserPause(h.handle, env)();
  assert.equal(head.length, 1, "style not duplicated");

  unlock();
  assert.ok(!t.root.classes.has(LOCK_CLASS));
  assert.ok(!("click" in pl.p.options_!.userActions!));
  assert.equal(h.listenerCount(), 0);
});

test("pause keys are swallowed only while playing; Escape always passes", () => {
  const t = tree();
  const { env, fire, count } = fakeEnv();
  const h = fakeHandle(t.root, playerWithClick().p);
  const unlock = lockUserPause(h.handle, env);
  const ev = fire("keydown", { key: " ", target: t.root });
  assert.equal(ev.prevented && ev.stopped, true);
  assert.equal(fire("keyup", { key: " ", target: t.root }).stopped, true);
  assert.equal(fire("keydown", { key: "Escape", target: t.root }).stopped, false);
  h.state.paused = true;
  assert.equal(fire("keydown", { key: " ", target: t.root }).stopped, false, "Space may start/resume");
  unlock();
  assert.equal(count("keydown"), 0);
  assert.equal(count("keyup"), 0);
});

test("the media-session pause action is ignored while locked and mapped back on unlock", () => {
  const t = tree();
  const pl = playerWithClick();
  const { env, session } = fakeEnv();
  const h = fakeHandle(t.root, pl.p);
  const unlock = lockUserPause(h.handle, env);
  session.get("pause")!();
  assert.equal(pl.pauses(), 0);
  // stash's plugin re-registers its handler on player.ready; the next play takes it back
  session.set("pause", () => pl.p.pause());
  h.firePlay();
  session.get("pause")!();
  assert.equal(pl.pauses(), 0);
  unlock();
  session.get("pause")!();
  assert.equal(pl.pauses(), 1);
});

test("the lock follows a re-created player", () => {
  const t1 = tree();
  const t2 = tree();
  const p1 = playerWithClick();
  const p2 = playerWithClick();
  const { env } = fakeEnv();
  const h = fakeHandle(null, null);
  const unlock = lockUserPause(h.handle, env);
  h.changeContainer(t1.root, p1.p);
  assert.ok(t1.root.classes.has(LOCK_CLASS));
  h.changeContainer(t2.root, p2.p);
  assert.ok(!t1.root.classes.has(LOCK_CLASS));
  assert.ok(!("click" in p1.p.options_!.userActions!));
  assert.ok(t2.root.classes.has(LOCK_CLASS));
  assert.equal(typeof p2.p.options_!.userActions!.click, "function");
  unlock();
  assert.ok(!t2.root.classes.has(LOCK_CLASS));
});

// --- overlay placement -------------------------------------------------------------

test("the overlay host goes right before the control bar and follows container changes", () => {
  const t = tree();
  const doc = {
    createElement: (tag: string) => {
      const e = new El(tag) as unknown as HTMLElement & { style: Record<string, string>; className: string };
      (e as unknown as { style: object }).style = {};
      (e as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute = (k, v) => (e as unknown as El).attrs.set(k, v);
      return e;
    },
  };
  const host = createHost(doc) as unknown as El & { style: Record<string, string> };
  assert.equal(host.style.pointerEvents, "none");
  assert.equal(host.style.position, "absolute");

  assert.equal(placeHost(host, t.root), true);
  assert.deepEqual(t.root.children, [t.tech, t.poster, host, t.bar]);
  assert.equal(t.root.children.indexOf(host), t.root.children.indexOf(t.bar) - 1);
  assert.equal(placeHost(host, t.root), false, "already there");

  const t2 = tree();
  assert.equal(placeHost(host, t2.root), true);
  assert.ok(!t.root.children.includes(host));
  assert.ok(t2.root.children.includes(host));

  assert.equal(placeHost(host, null), true);
  assert.equal(host.parentNode, null);
  assert.equal(placeHost(host, null), false);

  const bare = new El("video-js");
  placeHost(host, bare);
  assert.equal(bare.children[0], host, "appended when there is no control bar");

  const inner = host.appendChild(new El("button"));
  assert.equal(inOverlay(inner), true);
  assert.equal(inOverlay(t2.fsBtn), false);
});
