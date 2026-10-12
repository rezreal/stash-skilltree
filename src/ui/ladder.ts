// Pure logic of the topic ladder (no React, no DOM): which tags sit on which
// level of one topic, edits to that assignment, and the tag writes that
// apply it. Writes go through setupForm's diffForm, so the same rules hold
// as in the tag editor (only config keys change, player keys stay).

import type { Id } from "../core/types.ts";
import { nodeKey, normalizeTopic, parseRequirement } from "../core/requirements.ts";
import { fieldString } from "../stash/fields.ts";
import { isEmptyChange, type SetupTag, type TagFieldsChange } from "../stash/tags.ts";
import { diffForm, formFromFields, interestNode, matchesQuery, withKind, withValue } from "./setupForm.ts";

/** tag id -> level, for the tags of one topic */
export type Ladder = ReadonlyMap<Id, number>;

export interface LadderRow {
  level: number;
  tags: SetupTag[];
}

/** Topics of all interest tags, sorted. */
export function ladderTopics(tags: readonly SetupTag[]): string[] {
  const topics = new Set<string>();
  for (const t of tags) {
    const node = interestNode(t.customFields);
    if (node) topics.add(node.topic);
  }
  return [...topics].sort((a, b) => a.localeCompare(b));
}

/** The current assignment of a topic, from the tags' custom fields. */
export function ladderOf(tags: readonly SetupTag[], topic: string): Map<Id, number> {
  const want = normalizeTopic(topic);
  const out = new Map<Id, number>();
  for (const t of tags) {
    const node = interestNode(t.customFields);
    if (node && node.topic === want) out.set(t.id, node.level);
  }
  return out;
}

/** Levels 0..max plus `extra` empty levels to add to; tags by name. */
export function ladderRows(ladder: Ladder, tags: readonly SetupTag[], extra = 1): LadderRow[] {
  const byId = new Map(tags.map((t) => [t.id, t] as const));
  let max = -1;
  for (const l of ladder.values()) max = Math.max(max, l);
  const rows: LadderRow[] = [];
  for (let level = 0; level <= max + extra; level++) rows.push({ level, tags: [] });
  for (const [id, level] of ladder) {
    const tag = byId.get(id);
    if (tag) rows[level].tags.push(tag);
  }
  for (const r of rows) r.tags.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export function addToLadder(ladder: Ladder, tagId: Id, level: number): Map<Id, number> {
  const out = new Map(ladder);
  out.set(tagId, level);
  return out;
}

export function removeFromLadder(ladder: Ladder, tagId: Id): Map<Id, number> {
  const out = new Map(ladder);
  out.delete(tagId);
  return out;
}

/** Swaps the tags of two levels (moving a level up or down). */
export function swapLevels(ladder: Ladder, a: number, b: number): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const [id, l] of ladder) out.set(id, l === a ? b : l === b ? a : l);
  return out;
}

/**
 * Tags that can be added to a topic: not on it yet, and either without a
 * kind or interest tags (of another topic, which moves them). Tags of other
 * kinds are left out so the ladder never turns e.g. a trigger tag into an
 * interest tag.
 */
export function ladderCandidates(tags: readonly SetupTag[], ladder: Ladder, query: string, limit = 20): SetupTag[] {
  const out: SetupTag[] = [];
  for (const t of tags) {
    if (out.length >= limit) break;
    if (ladder.has(t.id) || !matchesQuery(t, query)) continue;
    const kind = fieldString(t.customFields["st.kind"])?.toLowerCase();
    if (kind !== undefined && kind !== "interest") continue;
    out.push(t);
  }
  return out;
}

/** Writes that turn the topic's current assignment into `desired`. */
export function ladderChanges(tags: readonly SetupTag[], topic: string, desired: Ladder): TagFieldsChange[] {
  const want = normalizeTopic(topic);
  const original = ladderOf(tags, want);
  const changes: TagFieldsChange[] = [];
  for (const tag of tags) {
    const inOriginal = original.has(tag.id);
    const level = desired.get(tag.id);
    if (!inOriginal && level === undefined) continue;
    let form = formFromFields(tag.customFields);
    if (level === undefined) {
      form = withKind(form, "none");
    } else {
      form = withValue(withKind(form, "interest"), "st.level", String(level));
      if (!inOriginal) form = withValue(form, "st.topic", want);
    }
    const change = diffForm(tag.customFields, form);
    if (!isEmptyChange(change)) changes.push({ tagId: tag.id, change });
  }
  return changes;
}

/** Levels whose set of tags differs between two assignments. */
export function changedLevels(before: Ladder, after: Ladder): number[] {
  const members = (ladder: Ladder) => {
    const m = new Map<number, string[]>();
    for (const [id, l] of ladder) m.set(l, [...(m.get(l) ?? []), id]);
    for (const ids of m.values()) ids.sort();
    return m;
  };
  const a = members(before);
  const b = members(after);
  const levels = new Set([...a.keys(), ...b.keys()]);
  return [...levels]
    .filter((l) => (a.get(l) ?? []).join(",") !== (b.get(l) ?? []).join(","))
    .sort((x, y) => x - y);
}

/** Tags whose st.requires names a level of the topic whose tags change. */
export function staleRequires(tags: readonly SetupTag[], topic: string, desired: Ladder): string[] {
  const want = normalizeTopic(topic);
  const changed = new Set(changedLevels(ladderOf(tags, want), desired).map((l) => nodeKey(want, l)));
  if (changed.size === 0) return [];
  const warnings: string[] = [];
  for (const tag of tags) {
    if (fieldString(tag.customFields["st.kind"])?.toLowerCase() !== "interest") continue;
    const refs = new Set<string>();
    for (const g of parseRequirement(fieldString(tag.customFields["st.requires"])).req) {
      for (const alt of g) if (alt.kind === "level" && changed.has(nodeKey(alt.topic, alt.level))) refs.add(nodeKey(alt.topic, alt.level));
    }
    if (refs.size > 0) warnings.push(`"${tag.name}" requires ${[...refs].join(", ")}, whose tags change`);
  }
  return warnings;
}
