// Scores how well calibrated sensor samples follow the script, per section:
//
// - stroke: each movement between two turning points ("half-stroke") counts
//   as followed when the user covers >= strokeRangeMin of its range (their
//   extreme near each end) and, at an interior turning point, turns within
//   +-turnToleranceMs. Movements shorter than minSamplesPerHalfStroke sample
//   intervals can't be resolved by the sensor and are left out.
// - hold: share of time inside +-holdBand of the depth after an entry
//   allowance; a stretch outside longer than holdMaxOutsideMs fails the hold
//   (its score is halved).
// - ramp: mean absolute error against the script, mapped linearly from
//   rampGoodMae (1) to rampBadMae (0).
// - idle and sections beyond the user's limits: shown, not scored.
//
// Lag: a sample at script time t is compared with the script at t - lag
// ("effective time"). Seeks: samples are accepted only for script time not
// covered before, so replays never count twice; skipped parts have no data.
// A section needs minCoverage of its duration watched to be scored, a
// half-stroke 80 % of its turning-point windows, so result() works live
// (in-progress parts simply aren't scored yet) and at the end alike.
// Overall = mean of section scores weighted by watched duration. Pure.

import type { Action } from "../funscript/parse.ts";
import { DEFAULT_LAG_MS } from "./lag.ts";
import { positionAt } from "./normalize.ts";
import { applyLimits } from "./sections.ts";
import type { Section, SectionScore, TrackLimits, TrackScore } from "./types.ts";

/** One calibrated reading mapped to script time. */
export interface TrackSample {
  /** script time, ms (video time × 1000) */
  scriptMs: number;
  /** calibrated position 0..100 */
  pos: number;
}

export interface ScoreParams {
  /** share of a half-stroke's range the user must cover (default 0.6) */
  strokeRangeMin: number;
  /** turning-point timing tolerance after lag compensation, ms (default 250) */
  turnToleranceMs: number;
  /** hold band: +- position units around the depth (default 8) */
  holdBand: number;
  /** time after the hold starts (in effective time, i.e. on top of the lag) before it is checked, ms (default 500) */
  holdEntryMs: number;
  /** longest stretch outside the band a hold survives, ms (default 1000) */
  holdMaxOutsideMs: number;
  /** a hold counts as followed with at least this share inside (default 0.75) */
  holdFollowedShare: number;
  /** ramp mean absolute error scoring 1 (default 5) */
  rampGoodMae: number;
  /** ramp mean absolute error scoring 0 (default 30) */
  rampBadMae: number;
  /** share of a section that must be watched to score it (default 0.5) */
  minCoverage: number;
  /** consecutive samples further apart than this (script ms) are a gap / seek (default 1000) */
  maxGapMs: number;
  /** a half-stroke needs at least this many sample intervals to be resolvable (default 2.5) */
  minSamplesPerHalfStroke: number;
}

export const DEFAULT_SCORE_PARAMS: ScoreParams = {
  strokeRangeMin: 0.6,
  turnToleranceMs: 250,
  holdBand: 8,
  holdEntryMs: 500,
  holdMaxOutsideMs: 1000,
  holdFollowedShare: 0.75,
  rampGoodMae: 5,
  rampBadMae: 30,
  minCoverage: 0.5,
  maxGapMs: 1000,
  minSamplesPerHalfStroke: 2.5,
};

/** share of a turning-point window that must be watched to judge the half-stroke */
const WINDOW_COVERAGE = 0.8;
/** largest weight one sample carries in time-weighted shares, ms */
const MAX_SAMPLE_WEIGHT_MS = 250;

export interface TrackScorerOptions {
  /** normalised script (scriptActions) */
  actions: Action[];
  sections: Section[];
  /** re-applied to the sections when given (applyLimits) */
  limits?: TrackLimits;
  /** sensor sample rate; measured from the samples when not given */
  sensorRateHz?: number;
  /** initial lag, ms (default DEFAULT_LAG_MS) */
  lagMs?: number;
  params?: Partial<ScoreParams>;
}

export interface TrackScorer {
  readonly sections: Section[];
  push(sample: TrackSample): void;
  setLag(ms: number): void;
  lag(): number;
  /** undefined: measure from the samples */
  setSensorRate(hz: number | undefined): void;
  /** sample rate used for resolvability (given or measured), Hz */
  sensorRate(): number | undefined;
  /** live and final alike */
  result(): TrackScore;
}

/** Section containing script time `ms` (start <= ms < end; the last one includes its end). */
export function sectionAt(sections: Section[], ms: number): Section | undefined {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = sections[mid];
    if (ms < s.start) hi = mid - 1;
    else if (ms >= s.end) {
      if (mid === sections.length - 1 && ms === s.end) return s;
      lo = mid + 1;
    } else return s;
  }
  return undefined;
}

interface Iv {
  a: number;
  b: number;
}

function addIv(list: Iv[], a: number, b: number): Iv[] {
  if (!(b > a)) return list;
  const out: Iv[] = [];
  let cur: Iv = { a, b };
  let placed = false;
  for (const iv of list) {
    if (iv.b < cur.a) out.push(iv);
    else if (iv.a > cur.b) {
      if (!placed) {
        out.push(cur);
        placed = true;
      }
      out.push(iv);
    } else cur = { a: Math.min(cur.a, iv.a), b: Math.max(cur.b, iv.b) };
  }
  if (!placed) out.push(cur);
  return out;
}

function median(v: number[]): number | undefined {
  if (v.length === 0) return undefined;
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function createTrackScorer(opts: TrackScorerOptions): TrackScorer {
  const p: ScoreParams = { ...DEFAULT_SCORE_PARAMS, ...opts.params };
  const actions = opts.actions;
  const sections = opts.limits ? applyLimits(opts.sections, opts.limits) : opts.sections;
  let lagMs = Number.isFinite(opts.lagMs) ? Math.max(0, opts.lagMs as number) : DEFAULT_LAG_MS;
  let givenRate = opts.sensorRateHz !== undefined && opts.sensorRateHz > 0 ? opts.sensorRateHz : undefined;

  /** accepted samples, sorted by scriptMs, unique times */
  const samples: TrackSample[] = [];
  /** covered script time (raw, not lag-shifted), merged */
  let covered: Iv[] = [];
  let lastT: number | undefined;
  let cache: TrackScore | undefined;

  const lowerBound = (t: number) => {
    let lo = 0;
    let hi = samples.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].scriptMs < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const isCovered = (t: number) => {
    for (const iv of covered) {
      if (t < iv.a) return false;
      if (t <= iv.b) return true;
    }
    return false;
  };

  const insert = (s: TrackSample) => {
    const i = lowerBound(s.scriptMs);
    if (i < samples.length && samples[i].scriptMs === s.scriptMs) return false;
    samples.splice(i, 0, { scriptMs: s.scriptMs, pos: s.pos });
    return true;
  };

  /** watched length of [a, b] in effective time */
  const coverage = (a: number, b: number) => {
    let n = 0;
    for (const iv of covered) {
      const x = Math.max(a, iv.a - lagMs);
      const y = Math.min(b, iv.b - lagMs);
      if (y > x) n += y - x;
    }
    return n;
  };

  /** samples with effective time in [a, b] as index range [i, j) */
  const range = (a: number, b: number): [number, number] => [lowerBound(a + lagMs), lowerBound(b + lagMs + 1e-9)];

  const measuredRate = (): number | undefined => {
    const dts: number[] = [];
    for (let k = Math.max(1, samples.length - 200); k < samples.length; k++) {
      const dt = samples[k].scriptMs - samples[k - 1].scriptMs;
      if (dt > 0 && dt <= p.maxGapMs) dts.push(dt);
    }
    const m = median(dts);
    return m !== undefined && m > 0 ? 1000 / m : undefined;
  };

  // --- per-kind scoring -----------------------------------------------------------

  interface Extreme {
    pos: number;
    t: number;
  }

  /** user's extreme (max for a top, min for a bottom) in effective window [a, b] */
  const extreme = (a: number, b: number, top: boolean): Extreme | undefined => {
    const [i, j] = range(a, b);
    let best: Extreme | undefined;
    for (let k = i; k < j; k++) {
      const s = samples[k];
      if (!best || (top ? s.pos > best.pos : s.pos < best.pos)) best = { pos: s.pos, t: s.scriptMs - lagMs };
    }
    return best;
  };

  const windowOk = (a: number, b: number) => b > a && coverage(a, b) >= WINDOW_COVERAGE * (b - a) && range(a, b)[1] > range(a, b)[0];

  function scoreStroke(sec: Section, rateHz: number | undefined): { score?: number; legs: number; followed: number; detail: string } {
    const tol = p.turnToleranceMs;
    const times = [sec.start, ...(sec.turns ?? []).filter((t) => t > sec.start && t < sec.end), sec.end];
    const pos = times.map((t) => positionAt(actions, t));
    const minLeg = rateHz !== undefined ? (p.minSamplesPerHalfStroke * 1000) / rateHz : 0;
    let legs = 0;
    let followed = 0;
    let tooFast = 0;
    const ext: (Extreme | undefined | null)[] = times.map(() => null);
    const extAt = (k: number, top: boolean): Extreme | undefined => {
      const cached = ext[k];
      if (cached !== null) return cached;
      const before = k > 0 ? Math.min(2 * tol, (times[k] - times[k - 1]) / 2) : 2 * tol;
      const after = k < times.length - 1 ? Math.min(2 * tol, (times[k + 1] - times[k]) / 2) : 2 * tol;
      const a = times[k] - before;
      const b = times[k] + after;
      const e = windowOk(a, b) ? extreme(a, b, top) : undefined;
      ext[k] = e;
      return e;
    };
    for (let k = 0; k + 1 < times.length; k++) {
      const span = pos[k + 1] - pos[k];
      if (span === 0) continue;
      if (times[k + 1] - times[k] < minLeg) {
        tooFast++;
        continue;
      }
      const up = span > 0;
      const e0 = extAt(k, !up);
      const e1 = extAt(k + 1, up);
      if (!e0 || !e1) continue;
      legs++;
      const covered = up ? e1.pos - e0.pos : e0.pos - e1.pos;
      const rangeOk = covered >= p.strokeRangeMin * Math.abs(span);
      const interior = k + 1 < times.length - 1;
      const timed = !interior || Math.abs(e1.t - times[k + 1]) <= tol;
      if (rangeOk && timed) followed++;
    }
    if (legs === 0) return { legs, followed, detail: tooFast > 0 ? "too fast for the sensor" : "no data" };
    const detail = `${followed}/${legs} strokes followed${tooFast > 0 ? `, ${tooFast} too fast for the sensor` : ""}`;
    return { score: followed / legs, legs, followed, detail };
  }

  function scoreHold(sec: Section): { score?: number; followed: boolean; detail: string } {
    const depth = sec.depth ?? positionAt(actions, (sec.start + sec.end) / 2);
    const a = sec.start + Math.min(p.holdEntryMs, (sec.end - sec.start) / 2);
    const b = sec.end;
    if (coverage(a, b) < p.minCoverage * (b - a)) return { followed: false, detail: "no data" };
    const [i, j] = range(a, b);
    if (j - i < 2) return { followed: false, detail: "no data" };
    let inside = 0;
    let total = 0;
    let outSince: number | undefined;
    let maxOut = 0;
    for (let k = i; k < j; k++) {
      const s = samples[k];
      const t = s.scriptMs - lagMs;
      const next = k + 1 < samples.length ? samples[k + 1].scriptMs - lagMs : undefined;
      const gap = next !== undefined ? next - t : Infinity;
      const w = Math.min(gap, MAX_SAMPLE_WEIGHT_MS, Math.max(0, b - t));
      const ok = Math.abs(s.pos - depth) <= p.holdBand;
      total += w;
      if (ok) inside += w;
      if (!ok) {
        if (outSince === undefined) outSince = t;
      } else if (outSince !== undefined) {
        maxOut = Math.max(maxOut, t - outSince);
        outSince = undefined;
      }
      // a gap (seek) or the window's end closes an open stretch at this sample's end
      if (outSince !== undefined && (gap > p.maxGapMs || k + 1 >= j)) {
        maxOut = Math.max(maxOut, t + w - outSince);
        outSince = undefined;
      }
    }
    if (!(total > 0)) return { followed: false, detail: "no data" };
    const share = inside / total;
    const broke = maxOut > p.holdMaxOutsideMs;
    const followed = share >= p.holdFollowedShare && !broke;
    const pct = Math.round(share * 100);
    return {
      score: broke ? share * 0.5 : share,
      followed,
      detail: broke ? `${pct}% in the band, left it for ${(maxOut / 1000).toFixed(1)} s` : `${pct}% in the band`,
    };
  }

  function scoreRamp(sec: Section): { score?: number; detail: string } {
    if (coverage(sec.start, sec.end) < p.minCoverage * (sec.end - sec.start)) return { detail: "no data" };
    const [i, j] = range(sec.start, sec.end);
    if (j - i < 2) return { detail: "no data" };
    let err = 0;
    for (let k = i; k < j; k++) err += Math.abs(samples[k].pos - positionAt(actions, samples[k].scriptMs - lagMs));
    const mae = err / (j - i);
    const span = p.rampBadMae - p.rampGoodMae;
    const score = span > 0 ? Math.max(0, Math.min(1, (p.rampBadMae - mae) / span)) : mae <= p.rampGoodMae ? 1 : 0;
    return { score, detail: `off by ${mae.toFixed(1)} on average` };
  }

  function compute(): TrackScore {
    const rateHz = givenRate ?? measuredRate();
    const out: TrackScore = { strokes: { followed: 0, total: 0 }, holds: { followed: 0, total: 0 }, lagMs, sections: [] };
    let wSum = 0;
    let sSum = 0;
    let rampSum = 0;
    let rampN = 0;
    for (const sec of sections) {
      const entry: SectionScore = { section: sec };
      out.sections.push(entry);
      if (sec.kind === "idle") {
        entry.detail = "idle";
        continue;
      }
      if (sec.unscored) {
        entry.detail = "beyond your limits";
        continue;
      }
      const dur = sec.end - sec.start;
      const watched = coverage(sec.start, sec.end);
      if (!(dur > 0) || watched < p.minCoverage * dur) {
        entry.detail = "no data";
        continue;
      }
      let score: number | undefined;
      if (sec.kind === "stroke") {
        const r = scoreStroke(sec, rateHz);
        score = r.score;
        entry.detail = r.detail;
        out.strokes.total += r.legs;
        out.strokes.followed += r.followed;
      } else if (sec.kind === "hold") {
        const r = scoreHold(sec);
        score = r.score;
        entry.detail = r.detail;
        if (score !== undefined) {
          out.holds.total += 1;
          if (r.followed) out.holds.followed += 1;
        }
      } else {
        const r = scoreRamp(sec);
        score = r.score;
        entry.detail = r.detail;
        if (score !== undefined) {
          rampSum += score;
          rampN += 1;
        }
      }
      if (score !== undefined) {
        entry.score = score;
        wSum += watched;
        sSum += score * watched;
      }
    }
    if (wSum > 0) out.overall = sSum / wSum;
    if (rampN > 0) out.ramps = rampSum / rampN;
    return out;
  }

  return {
    sections,
    push(sample) {
      const t = sample.scriptMs;
      if (!Number.isFinite(t) || !Number.isFinite(sample.pos)) return;
      const prev = lastT;
      lastT = t;
      if (prev !== undefined && t === prev) return; // paused
      const fresh = !isCovered(t);
      if (prev !== undefined && t > prev && t - prev <= p.maxGapMs) covered = addIv(covered, prev, t);
      if (fresh && insert({ scriptMs: t, pos: Math.max(0, Math.min(100, sample.pos)) })) cache = undefined;
      else if (prev !== undefined && t > prev) cache = undefined; // coverage may have grown
    },
    setLag(ms) {
      if (!Number.isFinite(ms)) return;
      const v = Math.max(0, ms);
      if (v !== lagMs) cache = undefined;
      lagMs = v;
    },
    lag: () => lagMs,
    setSensorRate(hz) {
      givenRate = hz !== undefined && hz > 0 ? hz : undefined;
      cache = undefined;
    },
    sensorRate: () => givenRate ?? measuredRate(),
    result() {
      if (!cache) cache = compute();
      return cache;
    },
  };
}
