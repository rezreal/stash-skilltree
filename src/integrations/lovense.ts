// Gating the Lovense Sync plugin (a separate stash plugin that drives Lovense
// vibrators from the scene's funscript) during track clips: the toy runs at
// full strength while the viewer is on the target and fades the further off
// they are. Talks to it only through window events, so it works whichever
// plugin loads first and does nothing when Lovense Sync isn't installed:
//
//   window "lovense:gain"  { source: "skilltree", gain: 0..1 | null }
//
// The plugin multiplies the gains of all sources; null removes ours. Pure
// helpers plus one dispatch, tested under node --test.

export const LOVENSE_GAIN_EVENT = "lovense:gain";
export const LOVENSE_SOURCE = "skilltree";

/** gain steps: a new value is only sent when it moves a whole step */
export const GAIN_STEP = 0.05;

/**
 * Gain for the toy from the match glow's mismatch (0 on target .. 1 fully
 * off): 1 on target, falling to 0 when fully off. Undefined (nothing to
 * judge: no sensor reading, rest, an unscored section) leaves the toy on the
 * script alone (gain 1).
 */
export function gainFromMismatch(mismatch: number | undefined): number {
  if (mismatch === undefined || !Number.isFinite(mismatch)) return 1;
  const g = 1 - Math.min(1, Math.max(0, mismatch));
  return Math.round(g / GAIN_STEP) * GAIN_STEP;
}

export interface EventTargetLike {
  dispatchEvent(event: Event): boolean;
}

/** sends our gain (null = stop gating) to Lovense Sync, if it listens */
export function sendLovenseGain(gain: number | null, target: EventTargetLike | undefined = globalThis as unknown as EventTargetLike): void {
  if (!target || typeof target.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  target.dispatchEvent(new CustomEvent(LOVENSE_GAIN_EVENT, { detail: { source: LOVENSE_SOURCE, gain } }));
}

/** the lovenseGate setting: on unless explicitly turned off */
export function lovenseGateEnabled(setting: unknown): boolean {
  return !(setting === false || setting === "false" || setting === 0 || setting === "0");
}
