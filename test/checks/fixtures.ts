import type { PromptPhase, PromptSpec } from "../../src/prompts/types.ts";

let n = 0;
export function spec(p: Partial<PromptSpec> & Pick<PromptSpec, "check" | "start" | "end">): PromptSpec {
  return { markerId: p.markerId ?? `m${++n}`, title: "", holdSec: 2, ...p };
}

export const entry = (s: PromptSpec, phase: PromptPhase = "upcoming") => ({ spec: s, phase });
