// Pure pieces of the choice screen's test panel. Tested under node --test.
import type { NodeKey, SceneInput } from "../core/types.ts";
import { nodeLabel, plural } from "./format.ts";

export interface TestChip {
  text: string;
  tone: "blue" | "orange" | "muted";
}

/**
 * The chips of a test result: funscript, prompt markers (any marker whose
 * primary tag is a prompt tag, spend included) and where the scene stands
 * in the tree: its nodes, a series part (in the library, no node) or not in
 * the tree at all.
 */
export function testSceneChips(scene: SceneInput, nodes: readonly NodeKey[], inLibrary: boolean): TestChip[] {
  const chips: TestChip[] = [];
  if (scene.interactive) chips.push({ text: "funscript", tone: "blue" });
  const prompts = scene.markers.filter((m) => m.check !== undefined).length;
  if (prompts > 0) chips.push({ text: plural(prompts, "prompt marker"), tone: "blue" });
  if (nodes.length > 0) chips.push({ text: `in tree · ${nodes.map(nodeLabel).join(", ")}`, tone: "orange" });
  else if (inLibrary) chips.push({ text: "series part", tone: "orange" });
  else chips.push({ text: "not in tree", tone: "muted" });
  return chips;
}

/** "26–50 of 112" for a 1-based page */
export function rangeLabel(page: number, perPage: number, count: number): string {
  if (count <= 0) return "0 scenes";
  const first = (page - 1) * perPage + 1;
  const last = Math.min(count, page * perPage);
  return `${first}–${last} of ${count}`;
}
