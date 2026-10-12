// Trigger pairs: a scene tagged "installed" must come before scenes of the
// same performer tagged "used" with the same trigger.

import type { Id, LibraryInput, SceneInput } from "./types.ts";
import { normalizeTopic } from "./requirements.ts";

export interface TriggerEdge {
  from: Id;
  to: Id;
  trigger: string;
  performerId: Id;
}

/** Same normalization as topics: trimmed, lowercase, whitespace collapsed. */
export function normalizeTrigger(name: string): string {
  return normalizeTopic(name);
}

export interface TriggerScenes {
  installed: SceneInput[];
  used: SceneInput[];
  installedTagIds: Id[];
  usedTagIds: Id[];
}

/** Scenes per normalized trigger name, split by role. Triggers sorted by name. */
export function triggerScenes(input: LibraryInput): Map<string, TriggerScenes> {
  const tagRole = new Map<Id, { trigger: string; role: "installed" | "used" }>();
  const out = new Map<string, TriggerScenes>();
  const entry = (t: string): TriggerScenes => {
    let e = out.get(t);
    if (!e) {
      e = { installed: [], used: [], installedTagIds: [], usedTagIds: [] };
      out.set(t, e);
    }
    return e;
  };
  for (const tag of input.triggerTags) {
    const trigger = normalizeTrigger(tag.trigger);
    if (trigger === "") continue;
    tagRole.set(tag.id, { trigger, role: tag.role });
    const e = entry(trigger);
    if (tag.role === "installed") e.installedTagIds.push(tag.id);
    else e.usedTagIds.push(tag.id);
  }
  for (const scene of input.scenes) {
    const seen = new Set<string>();
    for (const tagId of scene.tagIds) {
      const r = tagRole.get(tagId);
      if (!r) continue;
      const k = `${r.trigger}\u0000${r.role}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const e = entry(r.trigger);
      (r.role === "installed" ? e.installed : e.used).push(scene);
    }
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Performer ids of a set of scenes, in first-seen order. */
function performersOf(scenes: SceneInput[]): Id[] {
  const ids: Id[] = [];
  const seen = new Set<Id>();
  for (const s of scenes) for (const p of s.performerIds) if (!seen.has(p)) {
    seen.add(p);
    ids.push(p);
  }
  return ids;
}

/**
 * For each performer and trigger: an edge from every "installed" scene to
 * every "used" scene of that performer dated later. If either scene is
 * undated the edge is kept (order unknown, the pairing is still hard).
 */
export function triggerEdges(input: LibraryInput): TriggerEdge[] {
  const edges: TriggerEdge[] = [];
  for (const [trigger, t] of triggerScenes(input)) {
    for (const performerId of performersOf([...t.installed, ...t.used])) {
      const inst = t.installed.filter((s) => s.performerIds.includes(performerId));
      const used = t.used.filter((s) => s.performerIds.includes(performerId));
      for (const from of inst) {
        for (const to of used) {
          if (from.id === to.id) continue;
          if (from.date && to.date && !(to.date > from.date)) continue;
          edges.push({ from: from.id, to: to.id, trigger, performerId });
        }
      }
    }
  }
  return edges;
}
