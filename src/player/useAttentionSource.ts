// Where attention comes from, per tick: gaze over the target element while
// an eye tracker is connected, otherwise the fallback (focus + activity).
// Independent of the player's markup: the caller passes a function that
// returns the element to watch (its rect is read on every tick, so
// fullscreen and resizes are followed) and calls read() from its own clock.
import { createGazeAttention } from "../gaze/index.ts";
import type { GazeStatus } from "../gaze/types.ts";
import { fallbackAttending } from "../play/index.ts";
import { createAttentionAdapter, type AttentionAdapter } from "./attentionAdapter.ts";
import { chooseAttention, INITIAL_READING, sameReading, type AttentionReading } from "./gazeView.ts";
import { gazeStatusNow, useGaze, type GazeHandle } from "./useGaze.ts";

export interface AttentionSource {
  /** decides attention now (Date.now() ms for the fallback's idle clock) */
  read: (nowMs?: number) => AttentionReading;
  /** the last reading, for display; re-renders only when it changes */
  reading: AttentionReading;
  /** the tracker's status (undefined when gazeSource is off) */
  status: GazeStatus | undefined;
  gaze: GazeHandle;
}

export function useAttentionSource(getTarget: () => Element | null, idleSec: number): AttentionSource {
  const gaze = useGaze();
  const [classifier] = React.useState(() => createGazeAttention());
  const adapter = React.useRef<AttentionAdapter | undefined>(undefined);
  const targetRef = React.useRef(getTarget);
  targetRef.current = getTarget;
  const idleRef = React.useRef(idleSec);
  idleRef.current = idleSec;
  const selectedRef = React.useRef(gaze.settings.source !== "off");
  selectedRef.current = gaze.settings.source !== "off";

  const [reading, setReading] = React.useState<AttentionReading>(INITIAL_READING);
  const last = React.useRef(reading);

  // every sample goes to the classifier, not only the rendered ones
  React.useEffect(
    () => gaze.subscribe((s) => classifier.push({ t: s.t, point: s.point, valid: s.valid })),
    [gaze.subscribe, classifier],
  );

  React.useEffect(() => {
    const a = createAttentionAdapter();
    adapter.current = a;
    return () => {
      a.cleanup();
      adapter.current = undefined;
    };
  }, []);

  const read = React.useCallback(
    (nowMs: number = Date.now()) => {
      const signals = adapter.current?.read();
      const fallback = signals ? fallbackAttending({ ...signals, nowMs, idleSec: idleRef.current }) : true;
      const status = gazeStatusNow();
      let verdict;
      if (status?.connection === "connected") {
        const el = targetRef.current();
        if (el) {
          const r = el.getBoundingClientRect();
          verdict = classifier.attending({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, performance.now());
        }
      }
      const next = chooseAttention({
        selected: selectedRef.current,
        connection: status?.connection,
        gaze: verdict,
        fallback,
        ...(signals ? { page: { visible: signals.visible, focused: signals.focused, fullscreen: signals.fullscreen } } : {}),
      });
      if (!sameReading(next, last.current)) setReading(next);
      last.current = next;
      return next;
    },
    [classifier],
  );

  return { read, reading, status: gaze.status, gaze };
}
