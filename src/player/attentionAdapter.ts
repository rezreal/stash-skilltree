// DOM side of the fallback attention signal: page visibility, focus,
// fullscreen and the last mouse/keyboard/touch activity. The decision itself
// (fallbackAttending in src/play) stays pure; this only reads the browser.

export interface AttentionSignals {
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
  lastActivityMs: number;
}

export interface AttentionAdapter {
  read(): AttentionSignals;
  /** removes every listener the adapter added */
  cleanup(): void;
}

interface EventTargetLike {
  addEventListener(type: string, fn: () => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: () => void, opts?: EventListenerOptions): void;
}

export interface AttentionEnv {
  target: EventTargetLike;
  document: {
    visibilityState: string;
    hasFocus(): boolean;
    fullscreenElement: unknown;
  };
  now(): number;
}

/** events that count as the viewer being present */
export const ACTIVITY_EVENTS = ["mousemove", "pointerdown", "keydown", "touchstart", "wheel"] as const;

function browserEnv(): AttentionEnv {
  return { target: window, document, now: () => Date.now() };
}

export function createAttentionAdapter(env: AttentionEnv = browserEnv()): AttentionAdapter {
  let lastActivityMs = env.now();
  const onActivity = () => {
    lastActivityMs = env.now();
  };
  const opts: AddEventListenerOptions = { passive: true, capture: true };
  for (const type of ACTIVITY_EVENTS) env.target.addEventListener(type, onActivity, opts);

  return {
    read() {
      const doc = env.document;
      return {
        visible: doc.visibilityState === "visible",
        focused: doc.hasFocus(),
        fullscreen: doc.fullscreenElement != null,
        lastActivityMs,
      };
    },
    cleanup() {
      for (const type of ACTIVITY_EVENTS) env.target.removeEventListener(type, onActivity, { capture: true });
    },
  };
}
