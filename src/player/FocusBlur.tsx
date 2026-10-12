// The focus blur of gaze prompts (focusBlur.ts): a few backdrop-filter
// layers over the video, each masked with a radial gradient that leaves the
// target region (eyes, face, hands, ...) sharp, so the picture blurs more the
// further it is from the region and more the longer the prompt runs. The browser does the blur on the GPU; the
// video element itself is untouched.
//
// Rendered inside the session overlay root (over the video, under the bar,
// the prompt banner and the gaze dot), like the eyes-closed dim. The layers
// are plain siblings with no opacity, filter or mask on an ancestor between
// them and the video: any of those would make the ancestor a backdrop root
// and the layers would blur nothing. rAF-driven while a prompt runs or the
// blur eases out; idle otherwise.
import type { PromptSpec, Region } from "../prompts/types.ts";
import {
  FOCUS_FADE_OUT_MS,
  FOCUS_LOST_MS,
  FOCUS_RINGS,
  focusRamp,
  focusEllipse,
  focusLayers,
  smoothEllipse,
  type FocusEllipse,
} from "./focusBlur.ts";

export interface FocusBlurProps {
  /** the active gaze prompt with a region (wantsFocusBlur); undefined eases the blur out */
  spec: PromptSpec | undefined;
  /** the prompt's target region now (viewport px) */
  regionFor: (spec: PromptSpec) => Region | undefined;
  /** current video time in seconds; undefined while there is no video */
  getVideoTime: () => number | undefined;
  /** blur of the outermost layer at full ramp, CSS px (focusBlurPx); 0 renders nothing */
  strength: number;
}

/** blur below this (px) is not drawn */
const MIN_BLUR_PX = 0.3;

function setLayer(el: HTMLElement, blurPx: number, mask: string | undefined): void {
  if (blurPx < MIN_BLUR_PX || mask === undefined) {
    el.style.visibility = "hidden";
    el.style.removeProperty("backdrop-filter");
    el.style.removeProperty("-webkit-backdrop-filter");
    return;
  }
  const filter = `blur(${blurPx}px)`;
  el.style.visibility = "visible";
  el.style.setProperty("backdrop-filter", filter);
  el.style.setProperty("-webkit-backdrop-filter", filter);
  el.style.setProperty("mask-image", mask);
  el.style.setProperty("-webkit-mask-image", mask);
}

interface LoopState {
  raf: number;
  lastMs?: number;
  /** performance.now() the region was last found */
  seenMs: number;
  ellipse?: FocusEllipse;
  /** 0..1 applied: follows the ramp up, eases out over FOCUS_FADE_OUT_MS */
  level: number;
}

export function FocusBlur(props: FocusBlurProps) {
  const { strength } = props;
  const layersRef = React.useRef<(HTMLSpanElement | null)[]>([]);
  const getters = React.useRef(props);
  getters.current = props;
  const loop = React.useRef<LoopState>({ raf: 0, seenMs: -Infinity, level: 0 });
  const active = props.spec !== undefined && strength > 0;

  const frame = React.useCallback((now: number): void => {
    const st = loop.current;
    st.raf = 0;
    const dt = st.lastMs === undefined ? 0 : now - st.lastMs;
    st.lastMs = now;
    const { spec, regionFor, getVideoTime, strength: px } = getters.current;
    const layers = layersRef.current;
    const first = layers[0];
    if (!first) return;

    if (spec) {
      const r = first.getBoundingClientRect();
      const target = focusEllipse(regionFor(spec), { x: r.left, y: r.top });
      if (target) {
        st.seenMs = now;
        st.ellipse = smoothEllipse(st.ellipse, target, dt);
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

    const stack = st.ellipse && st.level > 0 ? focusLayers(st.ellipse, px * st.level) : undefined;
    layers.forEach((el, i) => {
      if (el) setLayer(el, stack?.[i]?.blurPx ?? 0, stack?.[i]?.mask);
    });
    // runs while the prompt does and until the blur has eased out
    if ((spec && px > 0) || st.level > 0) st.raf = requestAnimationFrame(frame);
    else {
      st.lastMs = undefined;
      st.ellipse = undefined;
    }
  }, []);

  // a prompt starts: wake the loop (it stops by itself once eased out)
  React.useEffect(() => {
    const st = loop.current;
    if (active && !st.raf) st.raf = requestAnimationFrame(frame);
  }, [active, frame]);
  React.useEffect(() => () => cancelAnimationFrame(loop.current.raf), []);

  if (!(strength > 0)) return null;
  return (
    <>
      {FOCUS_RINGS.map((_, i) => (
        <span
          key={i}
          className="stp-sp-focus"
          ref={(el) => {
            layersRef.current[i] = el;
          }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
