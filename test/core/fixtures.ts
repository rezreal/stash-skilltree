import type {
  InterestTagInput,
  LibraryInput,
  MarkerInput,
  PerformerInput,
  SceneInput,
  TriggerTagInput,
} from "../../src/core/types.ts";

export function interest(
  id: string,
  topic: string,
  level: number,
  extra: Partial<InterestTagInput> = {},
): InterestTagInput {
  return { id, name: `${topic} ${level}`, topic, level, ...extra };
}

export function trigger(id: string, name: string, role: "installed" | "used"): TriggerTagInput {
  return { id, name: `${name} (${role})`, trigger: name, role };
}

export function scene(id: string, tagIds: string[], extra: Partial<SceneInput> = {}): SceneInput {
  return {
    id,
    title: id,
    date: "2024-01-01",
    durationSec: 600,
    performerIds: [],
    tagIds,
    interactive: false,
    completions: 0,
    earned: 0,
    spent: 0,
    markers: [],
    ...extra,
  };
}

export function spendMarker(id: string, title: string): MarkerInput {
  return { id, title, seconds: 10, check: "spend" };
}

export function performer(id: string, name = id): PerformerInput {
  return { id, name };
}

export function library(partial: Partial<LibraryInput> = {}): LibraryInput {
  return { interestTags: [], triggerTags: [], scenes: [], performers: [], malformed: [], ...partial };
}

export interface QuickNode {
  /** number of scenes (default 2) */
  scenes?: number;
  /** how many of them are completed (default 0) */
  done?: number;
  requires?: string;
  need?: number;
  paid?: number;
  performer?: string;
}

/**
 * One interest tag `t:<key>` per key ("topic:level") and scenes
 * `s:<key>:<i>`, the first `done` of them completed.
 */
export function quick(spec: Record<string, QuickNode>, extra: Partial<LibraryInput> = {}): LibraryInput {
  const lib = library(extra);
  for (const [key, n] of Object.entries(spec)) {
    const i = key.lastIndexOf(":");
    const topic = key.slice(0, i);
    const level = Number(key.slice(i + 1));
    const tagId = `t:${key}`;
    lib.interestTags.push(
      interest(tagId, topic, level, {
        ...(n.requires !== undefined ? { requires: n.requires } : {}),
        ...(n.need !== undefined ? { need: n.need } : {}),
        ...(n.paid !== undefined ? { paid: n.paid } : {}),
      }),
    );
    const count = n.scenes ?? 2;
    for (let s = 0; s < count; s++) {
      lib.scenes.push(
        scene(`s:${key}:${s}`, [tagId], {
          ...(s < (n.done ?? 0) ? { completedAt: "2024-02-01T00:00:00Z" } : {}),
          performerIds: n.performer ? [n.performer] : [],
        }),
      );
    }
  }
  return lib;
}
