// Where the viewer looks on the person in the video: dwell time per body
// region in one session (summed per performer by src/play/gazeRegions.ts).
// Pure and time-injected; src/checks/useGazeRegions.ts analyses the clip at
// a low rate and feeds the frames and the gaze samples.
//
// Each analysed frame gives the main person's regions (targetRegion, the
// geometry of the gaze prompts, with personOnly; each hand on its own, so
// the space between them isn't "hands"). Regions overlap (eyes in
// the face, chest in the torso), so a gaze point gets the first region in
// HEATMAP_REGIONS that contains it: the most specific one. On the person but
// in none of them is "person", elsewhere on the video "video", outside the
// video "off".
//
// Dwell time: each valid gaze sample adds the time since the previous sample
// to its region. Gaps longer than maxGapMs (a stalled tracker) add nothing,
// nor do invalid samples (blinks), samples the caller doesn't count (video
// paused, window in the background, no real tracker) and samples without
// regions analysed in the last freshMs.

import { insideRect } from "../gaze/attention.ts";
import type { ViewportPoint } from "../gaze/types.ts";
import { handRegions, personRegion, pointInRegion, targetRegion, videoContentRect, type RegionOptions } from "./regions.ts";
import type { ContentRect, GazeTarget, PersonFrame, Region, VideoBox } from "./types.ts";

/** most specific first: a point gets the first region containing it */
export const HEATMAP_REGIONS = [
  "eyes",
  "mouth",
  "hands",
  "face",
  "chest",
  "groin",
  "hips",
  "torso",
  "legs",
  "feet",
  "person",
  "video",
  "off",
] as const;
export type HeatmapRegion = (typeof HEATMAP_REGIONS)[number];

/** seconds per region; regions never looked at are left out */
export type RegionSeconds = Partial<Record<HeatmapRegion, number>>;

export const REGION_LABELS: Readonly<Record<HeatmapRegion, string>> = {
  eyes: "Eyes",
  mouth: "Mouth",
  hands: "Hands",
  face: "Face",
  chest: "Chest",
  groin: "Groin",
  hips: "Hips",
  torso: "Torso",
  legs: "Legs",
  feet: "Feet",
  person: "Rest of the body",
  video: "Elsewhere in the video",
  off: "Off the video",
};

const BODY: readonly (readonly [HeatmapRegion, GazeTarget])[] = [
  ["eyes", "eyes"],
  ["mouth", "mouth"],
  ["hands", "hands"],
  ["face", "face"],
  ["chest", "chest"],
  ["groin", "groin"],
  ["hips", "hips"],
  ["torso", "torso"],
  ["legs", "legs"],
  ["feet", "feet_floor"],
];

/** One analysed frame's regions on the page, most specific first. */
export interface RegionMap {
  video: ContentRect;
  regions: (readonly [HeatmapRegion, Region])[];
}

export function regionMap(frame: PersonFrame, box: VideoBox, opts?: RegionOptions): RegionMap {
  const o: RegionOptions = { ...opts, personOnly: true };
  const regions: (readonly [HeatmapRegion, Region])[] = [];
  for (const [label, target] of BODY) {
    if (target === "hands") {
      for (const r of handRegions(frame, box, o)) regions.push([label, r]);
      continue;
    }
    const r = targetRegion(target, frame, box, o);
    if (r) regions.push([label, r]);
  }
  const person = personRegion(frame, box, o);
  if (person) regions.push(["person", person]);
  return { video: videoContentRect(box), regions };
}

export function classifyGaze(p: ViewportPoint, map: RegionMap): HeatmapRegion {
  if (!insideRect(p, map.video)) return "off";
  for (const [label, r] of map.regions) if (pointInRegion(p, r)) return label;
  return "video";
}

// --- the accumulator -----------------------------------------------------------

export interface HeatmapSample {
  /** ms, the gaze timebase (performance.now()) */
  t: number;
  valid: boolean;
  point?: ViewportPoint;
}

export interface RegionHeatmapOptions {
  /** regions analysed longer ago than this don't classify samples, ms */
  freshMs?: number;
  /** longest interval between samples that still counts, ms */
  maxGapMs?: number;
}

export const HEATMAP_FRESH_MS = 1000;

export interface RegionHeatmap {
  /** the regions analysed at atMs (gaze timebase); undefined forgets them (a seek) */
  setRegions(atMs: number, map: RegionMap | undefined): void;
  push(sample: HeatmapSample, counting: boolean): void;
  seconds(): RegionSeconds;
  totalSec(): number;
}

export function createRegionHeatmap(opts?: RegionHeatmapOptions): RegionHeatmap {
  const freshMs = opts?.freshMs ?? HEATMAP_FRESH_MS;
  const maxGapMs = opts?.maxGapMs ?? 250;
  const ms = new Map<HeatmapRegion, number>();
  let regions: { at: number; map: RegionMap } | undefined;
  let prevT: number | undefined;
  return {
    setRegions(atMs, map) {
      regions = map && Number.isFinite(atMs) ? { at: atMs, map } : undefined;
    },
    push(s, counting) {
      if (!Number.isFinite(s.t)) return;
      const dt = prevT === undefined ? 0 : s.t - prevT;
      prevT = s.t;
      if (!(dt > 0) || dt > maxGapMs) return;
      if (!counting || !s.valid || !s.point || !regions || Math.abs(s.t - regions.at) > freshMs) return;
      const label = classifyGaze(s.point, regions.map);
      ms.set(label, (ms.get(label) ?? 0) + dt);
    },
    seconds() {
      const out: RegionSeconds = {};
      for (const r of HEATMAP_REGIONS) {
        const v = ms.get(r);
        if (v !== undefined && v > 0) out[r] = v / 1000;
      }
      return out;
    },
    totalSec() {
      let n = 0;
      for (const v of ms.values()) n += v;
      return n / 1000;
    },
  };
}

// --- shares ---------------------------------------------------------------------

export function totalOf(sec: RegionSeconds): number {
  let n = 0;
  for (const r of HEATMAP_REGIONS) n += sec[r] ?? 0;
  return n;
}

export interface RegionShare {
  region: HeatmapRegion;
  sec: number;
  /** 0..1 of all counted time */
  share: number;
}

/** Regions with time, most looked at first (ties in HEATMAP_REGIONS order). */
export function regionShares(sec: RegionSeconds): RegionShare[] {
  const total = totalOf(sec);
  if (!(total > 0)) return [];
  return HEATMAP_REGIONS.filter((r) => (sec[r] ?? 0) > 0)
    .map((region) => ({ region, sec: sec[region]!, share: sec[region]! / total }))
    .sort((a, b) => b.sec - a.sec);
}
