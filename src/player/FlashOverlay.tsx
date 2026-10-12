// Snap flashes: a white layer over the video that flashes and fades out at
// each snap of the funscript's "snap" axis while the clip plays.
//
// Self-contained, like GazeDot: it only needs the video container and the
// current video time as functions, so it works over our own <video> or over
// stash's ScenePlayer. The layer is portalled into the container, so it stays
// visible when the container is fullscreen; the container must be positioned.
//
// Photosensitivity: at most 3 flashes in any 1-second window (WCAG 2.3.1),
// extra snaps are skipped; seeking never replays snaps (see snapCursor). With
// prefers-reduced-motion the flash becomes a much dimmer, slower pulse (CSS)
// and the cap drops to 1 per second.
import type * as ReactTypes from "react";
import { snapCursor } from "../funscript/snap.ts";
import { createFlashLimiter, MAX_FLASHES_PER_SECOND } from "./flash.ts";

interface FlashOverlayProps {
  getContainer: () => HTMLElement | null;
  /** current video time in seconds; undefined while there is no video */
  getVideoTime: () => number | undefined;
  /** snap times in ms, ascending (snapEvents output) */
  events: number[];
  /** peak opacity 0..1; 0 renders nothing */
  intensity: number;
}

interface ReactDomLike {
  createPortal(children: ReactTypes.ReactNode, container: Element): ReactTypes.ReactPortal;
}

function reactDom(): ReactDomLike | undefined {
  return (window as unknown as { PluginApi?: { ReactDOM?: ReactDomLike } }).PluginApi?.ReactDOM;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION) : undefined);
  const [reduced, setReduced] = React.useState(() => query()?.matches ?? false);
  React.useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export function FlashOverlay(props: FlashOverlayProps) {
  const { events, intensity } = props;
  const reduced = useReducedMotion();
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  /** bumped per flash; remounting the pulse restarts its CSS animation */
  const [flashes, setFlashes] = React.useState(0);

  const getters = React.useRef(props);
  getters.current = props;
  const containerRef = React.useRef<HTMLElement | null>(null);

  const enabled = intensity > 0 && events.length > 0;

  React.useEffect(() => {
    if (!enabled) return;
    const cursor = snapCursor(events);
    const limiter = createFlashLimiter({ maxPerSecond: reduced ? 1 : MAX_FLASHES_PER_SECOND });
    let last: number | undefined;
    let raf = 0;
    const frame = () => {
      const el = getters.current.getContainer();
      if (el !== containerRef.current) {
        containerRef.current = el;
        setContainer(el);
      }
      const t = getters.current.getVideoTime();
      if (t === undefined || !Number.isFinite(t)) {
        last = undefined;
      } else {
        // several snaps inside one frame make one flash
        if (last !== undefined && cursor.crossed(last, t).length > 0 && limiter.allow(performance.now())) {
          setFlashes((n) => n + 1);
        }
        last = t;
      }
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [enabled, events, reduced]);

  if (!enabled || !container || flashes === 0) return null;
  const layer = (
    <div className="stp-snap-flash" style={{ opacity: intensity }} aria-hidden="true">
      <div key={flashes} className={`stp-snap-flash-pulse${reduced ? " is-reduced" : ""}`} />
    </div>
  );
  const dom = reactDom();
  return dom ? dom.createPortal(layer, container) : layer;
}
