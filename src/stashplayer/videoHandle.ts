// A handle on stash's video.js player that survives element swaps.
//
// Findings (stash v0.31.0, video.js 7.21):
// - The player root is <video-js id="VideoJsPlayer" class="video-js ...">,
//   appended by ScenePlayer into its <div class="video-wrapper">. video.js
//   puts `el.player = player` on that root (Player#createEl), so the video.js
//   API is reachable without importing video.js. Stash also exposes the same
//   player as PluginApi.utils.InteractiveUtils.getPlayer().
// - The <video class="vjs-tech"> inside it is kept across source changes
//   (direct stream, transcodes, DASH and HLS all run on the Html5 tech). It is
//   replaced when the tech changes (Chromecast and back) or when ScenePlayer
//   re-creates the whole player (its init effect re-runs on some config
//   changes), which also replaces the root. So nothing is cached here:
//   every access re-queries, and native listeners are moved to the new
//   element when a MutationObserver (or the next access) sees a different one.
// - Time and duration must come from video.js when it is there: for
//   transcoded streams stash's offset middleware (ScenePlayer/live.ts) seeks
//   by reloading the source with ?start=, so the raw element's currentTime
//   restarts at 0 after each such seek and its duration is unknown;
//   player.currentTime()/duration() add the offset back.
// - Events are taken from the media element (addEventListener), not from
//   player.on(): ScenePlayer calls player.off("ended") (all handlers) whenever
//   its onComplete prop changes, and live.ts fires synthetic tech "pause"
//   events during offset seeks that are not real pauses.

export interface VideoJsLike {
  currentTime(seconds?: number): number;
  duration(): number;
  paused(): boolean;
  ended(): boolean;
  muted(): boolean;
  volume(): number;
  play(): Promise<void> | undefined | void;
  pause(): void;
  el(): Element;
  isDisposed?(): boolean;
  scrubbing?(): boolean;
  /** fullscreen of the player's root (video.js keeps its own state in sync) */
  requestFullscreen?(): Promise<void> | void;
  isFullscreen?(): boolean;
  options_?: { userActions?: Record<string, unknown> };
}

/**
 * Why a pause happened:
 * - plugin: pause({ byPlugin: true }) asked for it
 * - end: the clip reached its end (the element pauses right before "ended")
 * - seek: video.js pauses while the progress bar is dragged, and stash's
 *   transcode seeks reload the source; resumed by stash itself
 * - other: anything else - the viewer (control bar, click, keys, media keys),
 *   stash's scrubber, the browser
 */
export type PauseCause = "plugin" | "end" | "seek" | "other";

export interface VideoHandle {
  /** the current <video>, or null while there is none */
  video(): HTMLVideoElement | null;
  /** the video.js root (the element that goes fullscreen), or null */
  container(): HTMLElement | null;
  /** the video.js player when reachable */
  player(): VideoJsLike | null;
  /** resolves true if playback started; never rejects */
  play(): Promise<boolean>;
  /** byPlugin marks the resulting "pause" event as ours (see onPause) */
  pause(opts?: { byPlugin?: boolean }): void;
  currentTime(): number;
  /** seconds; NaN while unknown */
  duration(): number;
  paused(): boolean;
  ended(): boolean;
  muted(): boolean;
  volume(): number;
  /** native media event on whichever <video> is current; returns an unsubscribe */
  onEvent(name: string, cb: (ev: Event) => void): () => void;
  /** "pause" with its cause */
  onPause(cb: (cause: PauseCause, ev: Event) => void): () => void;
  /** called with the new container whenever the video.js root is replaced */
  onContainerChange(cb: (container: HTMLElement | null) => void): () => void;
  /** re-checks the DOM now (normally done by the observer) */
  refresh(): void;
  dispose(): void;
}

interface ObserverLike {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
}

export interface VideoHandleEnv {
  MutationObserver?: new (cb: () => void) => ObserverLike;
  /** observed while the root doesn't exist yet */
  fallbackScope?: () => Node | null;
  /** another way to the player, e.g. PluginApi.utils.InteractiveUtils.getPlayer */
  getPlayer?: () => unknown;
  now?: () => number;
}

/** a pause this soon after a source reload or seek counts as part of the seek */
const SEEK_PAUSE_WINDOW_MS = 2000;

const INTERNAL_EVENTS = ["pause", "play", "loadstart", "seeking"] as const;

function defaultEnv(): VideoHandleEnv {
  const g = globalThis as unknown as { MutationObserver?: VideoHandleEnv["MutationObserver"]; document?: Document };
  return {
    MutationObserver: g.MutationObserver,
    fallbackScope: () => g.document?.body ?? null,
    now: () => Date.now(),
  };
}

function isPlayer(p: unknown): p is VideoJsLike {
  if (!p || typeof p !== "object") return false;
  const v = p as Partial<VideoJsLike>;
  if (typeof v.currentTime !== "function" || typeof v.play !== "function" || typeof v.el !== "function") return false;
  return !(typeof v.isDisposed === "function" && v.isDisposed());
}

export function createVideoHandle(getRoot: () => Element | null, envIn: VideoHandleEnv = {}): VideoHandle {
  const env = { ...defaultEnv(), ...envIn };
  const now = env.now ?? (() => Date.now());

  const listeners = new Map<string, Set<(ev: Event) => void>>();
  const pauseListeners = new Set<(cause: PauseCause, ev: Event) => void>();
  const containerListeners = new Set<(c: HTMLElement | null) => void>();

  let boundEl: HTMLVideoElement | null = null;
  const boundFns = new Map<string, (ev: Event) => void>();
  let lastRoot: Element | null | undefined = undefined;
  let observer: ObserverLike | null = null;
  let observed: Node | null = null;
  let disposed = false;

  let pluginPausePending = false;
  let lastSeekMs = Number.NEGATIVE_INFINITY;

  const root = (): Element | null => (disposed ? null : getRoot());

  function findVideo(r: Element | null): HTMLVideoElement | null {
    if (!r) return null;
    if (r.tagName?.toLowerCase() === "video") return r as HTMLVideoElement;
    return (r.querySelector("video") as HTMLVideoElement | null) ?? null;
  }

  function findPlayer(r: Element | null): VideoJsLike | null {
    if (!r) return null;
    const own = (r as unknown as { player?: unknown }).player;
    if (isPlayer(own)) return own;
    const other = env.getPlayer?.();
    if (isPlayer(other) && other.el() === r) return other;
    return null;
  }

  function classify(): PauseCause {
    if (pluginPausePending) {
      pluginPausePending = false;
      return "plugin";
    }
    if (ended()) return "end";
    const p = findPlayer(root());
    if (p?.scrubbing?.()) return "seek";
    if (now() - lastSeekMs <= SEEK_PAUSE_WINDOW_MS) return "seek";
    return "other";
  }

  function dispatch(name: string, ev: Event): void {
    if (name === "pause") {
      const cause = classify();
      for (const cb of [...pauseListeners]) cb(cause, ev);
    } else if (name === "play") {
      pluginPausePending = false;
    } else if (name === "loadstart" || name === "seeking") {
      lastSeekMs = now();
    }
    const set = listeners.get(name);
    if (set) for (const cb of [...set]) cb(ev);
  }

  function bindName(el: HTMLVideoElement, name: string): void {
    if (boundFns.has(name)) return;
    const fn = (ev: Event) => dispatch(name, ev);
    boundFns.set(name, fn);
    el.addEventListener(name, fn);
  }

  function unbindAll(): void {
    if (boundEl) for (const [name, fn] of boundFns) boundEl.removeEventListener(name, fn);
    boundFns.clear();
    boundEl = null;
  }

  function wantedNames(): string[] {
    return [...new Set<string>([...INTERNAL_EVENTS, ...listeners.keys()])];
  }

  /** moves listeners and the observer to whatever is current; notifies container changes */
  function sync(): void {
    if (disposed) return;
    const r = root();
    const v = findVideo(r);
    if (v !== boundEl) {
      unbindAll();
      if (v) {
        boundEl = v;
        for (const name of wantedNames()) bindName(v, name);
      }
    }
    if (r !== lastRoot) {
      const first = lastRoot === undefined;
      lastRoot = r;
      if (!first) for (const cb of [...containerListeners]) cb(r as HTMLElement | null);
    }
    updateObserver(r);
  }

  function hasSubscribers(): boolean {
    return listeners.size > 0 || pauseListeners.size > 0 || containerListeners.size > 0;
  }

  function updateObserver(r: Element | null): void {
    const Ctor = env.MutationObserver;
    if (!Ctor || !hasSubscribers() || disposed) {
      stopObserver();
      return;
    }
    // the root's parent (stash's .video-wrapper) also sees the root being replaced
    const target = (r?.parentNode as Node | null) ?? r ?? env.fallbackScope?.() ?? null;
    if (target === observed) return;
    stopObserver();
    if (!target) return;
    observer = new Ctor(() => sync());
    observer.observe(target, { childList: true, subtree: true });
    observed = target;
  }

  function stopObserver(): void {
    observer?.disconnect();
    observer = null;
    observed = null;
  }

  function current<T>(fromPlayer: (p: VideoJsLike) => T, fromVideo: (v: HTMLVideoElement) => T, fallback: T): T {
    sync();
    const r = root();
    const p = findPlayer(r);
    if (p) {
      try {
        return fromPlayer(p);
      } catch {
        // a player between dispose and removal; fall through to the element
      }
    }
    const v = findVideo(r);
    return v ? fromVideo(v) : fallback;
  }

  function ended(): boolean {
    return current(
      (p) => p.ended(),
      (v) => v.ended,
      false,
    );
  }

  function paused(): boolean {
    return current(
      (p) => p.paused(),
      (v) => v.paused,
      true,
    );
  }

  function subscribe<T>(set: Set<T>, cb: T): () => void {
    set.add(cb);
    sync();
    return () => {
      set.delete(cb);
      updateObserver(root());
    };
  }

  return {
    video: () => {
      sync();
      return findVideo(root());
    },
    container: () => {
      sync();
      return root() as HTMLElement | null;
    },
    player: () => findPlayer(root()),
    play: async () => {
      sync();
      const r = root();
      const p = findPlayer(r);
      const v = findVideo(r);
      try {
        if (p) await p.play();
        else if (v) await v.play();
        else return false;
        return true;
      } catch {
        return false;
      }
    },
    pause: (opts) => {
      sync();
      const r = root();
      const p = findPlayer(r);
      const v = findVideo(r);
      if (!p && !v) return;
      // only a pause that will produce an event may leave the flag set
      if (opts?.byPlugin && !paused()) pluginPausePending = true;
      if (p) p.pause();
      else v!.pause();
    },
    currentTime: () =>
      current(
        (p) => p.currentTime(),
        (v) => v.currentTime,
        0,
      ),
    duration: () => {
      const d = current(
        (p) => p.duration(),
        (v) => v.duration,
        Number.NaN,
      );
      return Number.isFinite(d) && d > 0 ? d : Number.NaN;
    },
    paused,
    ended,
    muted: () =>
      current(
        (p) => p.muted(),
        (v) => v.muted,
        false,
      ),
    volume: () =>
      current(
        (p) => p.volume(),
        (v) => v.volume,
        1,
      ),
    onEvent: (name, cb) => {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(cb);
      sync();
      if (boundEl) bindName(boundEl, name);
      return () => {
        const s = listeners.get(name);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) {
          listeners.delete(name);
          if (boundEl && !(INTERNAL_EVENTS as readonly string[]).includes(name)) {
            const fn = boundFns.get(name);
            if (fn) boundEl.removeEventListener(name, fn);
            boundFns.delete(name);
          }
        }
        updateObserver(root());
      };
    },
    onPause: (cb) => subscribe(pauseListeners, cb),
    onContainerChange: (cb) => subscribe(containerListeners, cb),
    refresh: sync,
    dispose: () => {
      disposed = true;
      stopObserver();
      unbindAll();
      listeners.clear();
      pauseListeners.clear();
      containerListeners.clear();
    },
  };
}
