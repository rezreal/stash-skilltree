// Words and bars for the gaze region heatmap in the session summary. Pure.
import { formatPercent } from "../player/format.ts";
import { REGION_LABELS, regionShares, totalOf, type RegionSeconds } from "../prompts/regionHeatmap.ts";
import type { StoredRegions } from "../play/gazeRegions.ts";

export interface RegionBar {
  label: string;
  /** 0..1 of the counted time */
  share: number;
  /** "34%" */
  text: string;
}

/** The most looked-at regions, largest first; the rest summed into "Other" when more than `max`. */
export function regionBars(sec: RegionSeconds, max = 6): RegionBar[] {
  const shares = regionShares(sec);
  const bar = (label: string, share: number): RegionBar => ({ label, share, text: formatPercent(share) });
  if (shares.length <= max) return shares.map((s) => bar(REGION_LABELS[s.region], s.share));
  const top = shares.slice(0, max - 1).map((s) => bar(REGION_LABELS[s.region], s.share));
  const rest = shares.slice(max - 1).reduce((n, s) => n + s.share, 0);
  return [...top, bar("Other", rest)];
}

/** "Ada · 5 clips · eyes 30%, face 22%, chest 12%" */
export function performerRegionsLine(name: string, stored: StoredRegions, top = 3): string {
  const clips = `${stored.sessions} ${stored.sessions === 1 ? "clip" : "clips"}`;
  const shares = regionShares(stored.sec)
    .slice(0, top)
    .map((s) => `${REGION_LABELS[s.region].toLowerCase()} ${formatPercent(s.share)}`);
  return [name, clips, shares.join(", ")].filter((s) => s !== "").join(" · ");
}

/** "2 min 10 s of gaze counted" */
export function countedText(sec: RegionSeconds): string {
  const total = Math.round(totalOf(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m > 0 ? `${m} min ${s} s` : `${s} s`} of gaze counted`;
}
