// A small dot where the eye tracker says you look, drawn over a container
// (the video stage). Rendered inside that container, which must be
// positioned; the container is passed as a function so the dot can be
// mounted wherever the video lives. Shown only with "Show gaze" on and a
// tracker connected. Smoothed for display; decisions use the raw samples.
import type { ViewportPoint } from "../gaze/types.ts";
import { smoothPoint } from "../gaze/index.ts";
import { useGaze, useGazePoint, useShowGaze } from "./useGaze.ts";

export function GazeDot(props: { getContainer: () => HTMLElement | null }) {
  const gaze = useGaze();
  const [show] = useShowGaze();
  const enabled = show && gaze.status?.connection === "connected";
  const sample = useGazePoint(enabled);
  const smoothed = React.useRef<{ p: ViewportPoint; t: number } | undefined>(undefined);

  if (!enabled || !sample) {
    smoothed.current = undefined;
    return null;
  }
  const prev = smoothed.current;
  if (sample.point) {
    const p = smoothPoint(prev?.p, sample.point, prev ? sample.t - prev.t : 0);
    smoothed.current = { p, t: sample.t };
  }
  const at = smoothed.current;
  const el = props.getContainer();
  if (!at || !el) return null;
  const r = el.getBoundingClientRect();
  return (
    <div
      className={`stp-gaze-dot${sample.point ? "" : " is-lost"}`}
      style={{ transform: `translate(${at.p.x - r.left}px, ${at.p.y - r.top}px)` }}
      aria-hidden="true"
    />
  );
}
