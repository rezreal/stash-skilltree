// The focus blur of gaze prompts (focusBlur.ts): a WebGL canvas over the
// video that redraws each frame through the blur shader (focusShader.ts), the
// target region (eyes, face, hands, ...) sharp and the picture around it more
// blurred the further away and the longer the prompt runs. While the blur is
// off the canvas is hidden and the video shows as usual.
//
// Rendered inside the session overlay root (over the video, under the bar,
// the prompt banner and the gaze dot), like the eyes-closed dim. The video's
// own CSS filter (stash's Filters panel: colour, blur) is copied onto the
// canvas so the picture looks the same; a video stash rotates or scales
// (its transforms) is left alone, since the canvas can't line up with it.
// rAF-driven while a prompt runs or the blur eases out; idle otherwise.
import type { PromptSpec, Region } from "../prompts/types.ts";
import { videoContentRect } from "../prompts/regions.ts";
import {
  FOCUS_FADE_OUT_MS,
  FOCUS_LOST_MS,
  focusCanvasSize,
  focusEllipse,
  focusRamp,
  ringUnit,
  smoothEllipse,
  type FocusEllipse,
} from "./focusBlur.ts";
import { createFocusRenderer, type FocusRenderer } from "./focusShader.ts";

export interface FocusBlurProps {
  /** the active gaze prompt with a region (wantsFocusBlur); undefined eases the blur out */
  spec: PromptSpec | undefined;
  /** the prompt's target region now (viewport px) */
  regionFor: (spec: PromptSpec) => Region | undefined;
  /** current video time in seconds; undefined while there is no video */
  getVideoTime: () => number | undefined;
  getVideo: () => HTMLVideoElement | null;
  /** blur sigma at full reach and full ramp, CSS px (focusBlurPx); 0 renders nothing */
  strength: number;
}

/** below this the blur is invisible: the canvas is hidden and the video shows */
const MIN_LEVEL = 0.01;

interface LoopState {
  raf: number;
  lastMs?: number;
  /** performance.now() the region was last found */
  seenMs: number;
  ellipse?: FocusEllipse;
  /** 0..1 applied: follows the ramp up, eases out over FOCUS_FADE_OUT_MS */
  level: number;
  renderer?: FocusRenderer;
  /** the canvas the renderer draws into (a remount brings a new one) */
  rendererCanvas?: HTMLCanvasElement;
  /** WebGL2 missing or the video can't be drawn: off for this mount */
  failed: boolean;
  /** performance.now() the current prompt run started, for the "no region" note */
  startedMs?: number;
  /** the "no region" note was logged for this run */
  noted: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** the video can be drawn as it is shown: a frame is there and stash doesn't rotate or scale it */
function drawable(video: HTMLVideoElement | null): video is HTMLVideoElement {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
  const transform = getComputedStyle(video).transform;
  return !transform || transform === "none";
}

export function FocusBlur(props: FocusBlurProps) {
  const { strength } = props;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const getters = React.useRef(props);
  getters.current = props;
  const loop = React.useRef<LoopState>({ raf: 0, seenMs: -Infinity, level: 0, failed: false, noted: false });
  const active = props.spec !== undefined && strength > 0;

  const frame = React.useCallback((now: number): void => {
    const st = loop.current;
    st.raf = 0;
    const canvas = canvasRef.current;
    if (!canvas || st.failed) return;
    const dt = st.lastMs === undefined ? 0 : now - st.lastMs;
    st.lastMs = now;
    const { spec, regionFor, getVideoTime, getVideo, strength: px } = getters.current;
    const cr = canvas.getBoundingClientRect();

    if (spec) {
      st.startedMs ??= now;
      const target = focusEllipse(regionFor(spec), { x: cr.left, y: cr.top });
      if (target) {
        st.seenMs = now;
        st.ellipse = smoothEllipse(st.ellipse, target, dt);
      } else if (!st.noted && st.ellipse === undefined && now - st.startedMs > FOCUS_LOST_MS * 2) {
        st.noted = true;
        console.info(`[skilltree] focus blur: no ${spec.target ?? "target"} region found on the video yet (video analysis off, still loading, or nobody detected)`);
      }
    }
    let t: number | undefined;
    try {
      t = getVideoTime();
    } catch {
      t = undefined;
    }
    const found = st.ellipse !== undefined && now - st.seenMs < FOCUS_LOST_MS;
    const goal = spec && found ? focusRamp(spec, t) : 0;
    st.level = goal >= st.level ? goal : Math.max(goal, st.level - dt / FOCUS_FADE_OUT_MS);

    let shown = false;
    const video = getVideo();
    if (st.ellipse && st.level >= MIN_LEVEL && px > 0 && cr.width > 0 && cr.height > 0 && drawable(video)) {
      try {
        if (st.rendererCanvas !== canvas) {
          st.renderer?.dispose();
          st.renderer = createFocusRenderer(canvas);
          st.rendererCanvas = canvas;
        }
        if (!st.renderer) throw new Error("WebGL2 is not available");
        const size = focusCanvasSize(cr.width, cr.height, window.devicePixelRatio || 1);
        const vr = video.getBoundingClientRect();
        const c = videoContentRect({
          left: vr.left - cr.left,
          top: vr.top - cr.top,
          width: vr.width,
          height: vr.height,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        });
        const k = size.scale;
        const e = st.ellipse;
        shown = st.renderer.draw(video, {
          width: size.width,
          height: size.height,
          content: { x: c.left * k, y: c.top * k, w: c.width * k, h: c.height * k },
          ellipse: { cx: e.cx * k, cy: e.cy * k, rx: e.rx * k, ry: e.ry * k },
          unit: ringUnit(e) * k,
          sigma: px * st.level * k,
        });
        if (!shown) throw new Error("the video frame can't be drawn (cross-origin video or lost context)");
        const filter = getComputedStyle(video).filter;
        canvas.style.filter = filter && filter !== "none" ? filter : "";
      } catch (err) {
        st.failed = true;
        shown = false;
        console.warn(`[skilltree] focus blur off: ${message(err)}`);
      }
    }
    canvas.style.visibility = shown ? "visible" : "hidden";

    // runs while the prompt does and until the blur has eased out
    if (!st.failed && ((spec && px > 0) || st.level > 0)) st.raf = requestAnimationFrame(frame);
    else {
      st.lastMs = undefined;
      st.ellipse = undefined;
      st.level = 0;
      st.startedMs = undefined;
      st.noted = false;
    }
  }, []);

  // a prompt starts: wake the loop (it stops by itself once eased out)
  React.useEffect(() => {
    const st = loop.current;
    if (active && !st.raf && !st.failed) st.raf = requestAnimationFrame(frame);
  }, [active, frame]);
  React.useEffect(
    () => () => {
      const st = loop.current;
      cancelAnimationFrame(st.raf);
      st.raf = 0;
      st.renderer?.dispose();
      st.renderer = undefined;
      st.rendererCanvas = undefined;
    },
    [],
  );

  if (!(strength > 0)) return null;
  return <canvas ref={canvasRef} className="stp-sp-focus" aria-hidden="true" />;
}
