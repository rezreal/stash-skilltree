// Fallback attention without an eye tracker. Pure; the DOM adapter (visibility,
// focus, fullscreen, mouse/keyboard listeners) lives in the UI.

export interface FallbackAttentionInput {
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
  /** time of the last mouse/keyboard activity */
  lastActivityMs: number;
  nowMs: number;
  /** activity older than this counts as away (unless fullscreen) */
  idleSec: number;
}

/** Visible and focused, and either fullscreen or recently active. */
export function fallbackAttending(input: FallbackAttentionInput): boolean {
  if (!input.visible || !input.focused) return false;
  return input.fullscreen || input.nowMs - input.lastActivityMs <= input.idleSec * 1000;
}
