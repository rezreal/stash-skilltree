// Synthetic scripts and simulated followers for the track tests.

import type { Action } from "../../src/funscript/parse.ts";
import { positionAt } from "../../src/track/normalize.ts";

/** deterministic PRNG in [0, 1) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** builds a script step by step: each call adds actions after the current end */
export class ScriptBuilder {
  actions: Action[] = [{ at: 0, pos: 0 }];
  constructor(startPos = 0) {
    this.actions[0].pos = startPos;
  }
  get end(): number {
    return this.actions[this.actions.length - 1].at;
  }
  get pos(): number {
    return this.actions[this.actions.length - 1].pos;
  }
  /** stay at the current position */
  flat(ms: number): this {
    this.actions.push({ at: this.end + ms, pos: this.pos });
    return this;
  }
  /** move to pos over ms */
  to(pos: number, ms: number): this {
    this.actions.push({ at: this.end + ms, pos });
    return this;
  }
  /** `legs` alternating moves between the current position and `other` */
  strokes(other: number, legs: number, halfMs: number): this {
    const base = this.pos;
    for (let i = 0; i < legs; i++) this.to(i % 2 === 0 ? other : base, halfMs);
    return this;
  }
}

/**
 * The composite script most tests use (all times ms):
 * idle 0-3000 | 20 strokes 0<->80 (400 ms each) 3000-11000 | ramp 0->60 11000-15000 |
 * hold 60 15000-19000 | ramp 60->0 19000-21000 | idle 21000-24000
 */
export function compositeScript(): Action[] {
  return new ScriptBuilder(0).flat(3000).strokes(80, 20, 400).to(60, 4000).flat(4000).to(0, 2000).flat(3000).actions;
}

export interface FollowOptions {
  lagMs?: number;
  rateHz?: number;
  /** uniform noise amplitude (+-) */
  noise?: number;
  seed?: number;
  /** maps the ideal position (and time) to what the user does */
  shape?: (pos: number, t: number) => number;
  from?: number;
  to?: number;
}

/** samples of a follower: position at script time t = script(t - lag), shaped, plus noise */
export function follow(script: Action[], o: FollowOptions = {}): { scriptMs: number; pos: number }[] {
  const lag = o.lagMs ?? 250;
  const dt = 1000 / (o.rateHz ?? 20);
  const r = rng(o.seed ?? 1);
  const from = o.from ?? 0;
  const to = o.to ?? script[script.length - 1].at + lag + 1000;
  const out: { scriptMs: number; pos: number }[] = [];
  for (let t = from; t <= to + 1e-9; t += dt) {
    let p = positionAt(script, t - lag);
    if (o.shape) p = o.shape(p, t);
    if (o.noise) p += (r() * 2 - 1) * o.noise;
    out.push({ scriptMs: Math.round(t * 1000) / 1000, pos: Math.max(0, Math.min(100, p)) });
  }
  return out;
}
