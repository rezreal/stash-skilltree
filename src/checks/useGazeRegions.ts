// The gaze region heatmap of one session (src/prompts/regionHeatmap.ts):
// MediaPipe pose + face on the clip at HEATMAP_ANALYSIS_HZ, and every gaze
// sample classified into the body region it falls on.
//
// - Runs only while enabled (the settings, session not finished) and a real
//   eye tracker is connected (the mouse stand-in would only map the pointer).
//   Samples count while counting() says so (the clip plays, the window is
//   in front).
// - Frames the prompt checks analyse anyway (around gaze prompts, ~10 Hz)
//   come in through feedPerson and replace the own analysis meanwhile, so
//   the clip is never analysed twice.
// - MediaPipe loads when first needed and is freed when the hook is disabled
//   or unmounts; the totals stay (seconds() still reads them for the summary).
// - After a seek the old regions are dropped until the next analysis.
import type { VideoBox, PersonFrame } from "../prompts/types.ts";
import { createRegionHeatmap, regionMap, type RegionHeatmap, type RegionSeconds } from "../prompts/regionHeatmap.ts";
import { clampRate, nextDelay } from "../perception/time.ts";
import { createVision, type PersonAnalyzer, type Vision } from "../perception/vision.ts";
import { subscribeGaze, useGaze } from "../player/useGaze.ts";
import { videoBoxOf } from "./usePromptChecks.ts";

/** own analyses per second (pose + face) */
export const HEATMAP_ANALYSIS_HZ = 2;
/** a video time jump larger than this (s) between analyses is a seek */
const SEEK_SEC = 1.5;
/** an analysis keeps failing: give up for this session */
const MAX_FAILURES = 20;

export interface GazeRegionsInput {
  enabled: boolean;
  getVideoTime: () => number | undefined;
  getVideo: () => HTMLVideoElement | null;
  /** gaze counts now: the clip plays and the window is in front */
  counting: () => boolean;
}

export interface GazeRegions {
  /** a frame analysed elsewhere (the prompt checks) */
  feedPerson(frame: PersonFrame, box: VideoBox | undefined): void;
  /** seconds per region so far */
  seconds(): RegionSeconds;
  /** a real eye tracker is connected (otherwise nothing is counted) */
  tracker: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useGazeRegions(input: GazeRegionsInput): GazeRegions {
  const inputRef = React.useRef(input);
  inputRef.current = input;
  const heatmapRef = React.useRef<RegionHeatmap | undefined>(undefined);
  heatmapRef.current ??= createRegionHeatmap();
  const heatmap = heatmapRef.current;

  const gaze = useGaze();
  const tracker = gaze.status?.connection === "connected" && gaze.status.kind !== "mouse";
  const on = input.enabled && tracker;

  /** performance.now() of the last frame fed from the prompt checks */
  const fedAtRef = React.useRef(-Infinity);
  /** video time of the regions in use */
  const regionsVtRef = React.useRef<number | undefined>(undefined);

  const feedPerson = React.useCallback(
    (frame: PersonFrame, box: VideoBox | undefined) => {
      if (!box) return;
      const now = performance.now();
      fedAtRef.current = now;
      regionsVtRef.current = frame.videoTime;
      heatmap.setRegions(now, regionMap(frame, box));
    },
    [heatmap],
  );

  // gaze samples -> the heatmap
  React.useEffect(() => {
    if (!on) return;
    return subscribeGaze((s) => {
      let counting = false;
      try {
        counting = inputRef.current.counting();
      } catch {
        counting = false;
      }
      heatmap.push(s, counting);
    });
  }, [on, heatmap]);

  // own analysis at a low rate
  React.useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let vision: Vision | undefined;
    let bound: { video: HTMLVideoElement; analyzer: PersonAnalyzer } | undefined;
    let binding = false;
    let failures = 0;
    let failed = false;
    const rate = clampRate(HEATMAP_ANALYSIS_HZ, HEATMAP_ANALYSIS_HZ);
    const intervalMs = 1000 / rate;

    const fail = (what: string, err: unknown): void => {
      failed = true;
      console.warn(`[skilltree] gaze regions: ${what}: ${message(err)}`);
    };

    createVision().then(
      (v) => {
        if (stopped) v.dispose();
        else vision = v;
      },
      (err: unknown) => fail("MediaPipe could not be loaded", err),
    );

    const bind = (video: HTMLVideoElement): void => {
      if (!vision || binding || bound?.video === video) return;
      bound?.analyzer.dispose();
      bound = undefined;
      binding = true;
      const v = vision;
      v.personAnalyzer(video, { pose: true, face: true, hands: false }).then(
        (analyzer) => {
          binding = false;
          if (stopped || vision !== v) analyzer.dispose();
          else bound = { video, analyzer };
        },
        (err: unknown) => {
          binding = false;
          fail("the models could not be created", err);
        },
      );
    };

    const tick = (): void => {
      timer = undefined;
      if (stopped || failed) return;
      const started = performance.now();
      const cur = inputRef.current;
      let t: number | undefined;
      try {
        t = cur.getVideoTime();
      } catch {
        t = undefined;
      }
      const video = cur.getVideo();
      if (t !== undefined && Number.isFinite(t) && video) {
        const vt = regionsVtRef.current;
        if (vt !== undefined && Math.abs(t - vt) > SEEK_SEC) {
          heatmap.setRegions(started, undefined);
          regionsVtRef.current = undefined;
        }
        bind(video);
        // the prompt checks are analysing: use their frames
        const fedRecently = started - fedAtRef.current < intervalMs * 1.5;
        let counting = false;
        try {
          counting = cur.counting();
        } catch {
          counting = false;
        }
        if (counting && !fedRecently && bound?.video === video) {
          const frame = bound.analyzer.analyze(t, started, { pose: true, face: true, hands: false });
          const box = videoBoxOf(video);
          if (frame && box) {
            failures = 0;
            regionsVtRef.current = t;
            heatmap.setRegions(performance.now(), regionMap(frame, box));
          } else if (bound.analyzer.lastError !== undefined && ++failures >= MAX_FAILURES) {
            fail("video analysis keeps failing", bound.analyzer.lastError);
          }
        }
      }
      if (!stopped && !failed) timer = setTimeout(tick, nextDelay(rate, started, performance.now()));
    };
    timer = setTimeout(tick, 0);

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      bound?.analyzer.dispose();
      bound = undefined;
      vision?.dispose();
      vision = undefined;
      heatmap.setRegions(performance.now(), undefined);
      regionsVtRef.current = undefined;
    };
  }, [on, heatmap]);

  const seconds = React.useCallback(() => heatmap.seconds(), [heatmap]);
  return { feedPerson, seconds, tracker };
}
