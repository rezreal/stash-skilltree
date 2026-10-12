// Loads the skill tree input (tags, scenes, performers) from stash.

import type {
  InterestTagInput,
  LibraryInput,
  MarkerInput,
  PerformerInput,
  SceneInput,
  TriggerTagInput,
} from "../core/types.ts";
import type { StashClient } from "./client.ts";
import {
  KNOWN_KINDS,
  markerPromptFields,
  parseInterestTag,
  parsePromptTag,
  parseTriggerTag,
  sceneProgressFields,
  tagKind,
} from "./fields.ts";
import {
  FIND_SKILL_SCENES,
  FIND_ST_TAGS,
  skillScenesVariables,
  stTagsVariables,
  type FindSkillScenesResult,
  type FindStTagsResult,
  type RawScene,
  type RawTag,
} from "./queries.ts";

export interface LoadOptions {
  /** scenes per request (default 250) */
  pageSize?: number;
  onProgress?: (msg: string) => void;
}

export const DEFAULT_PAGE_SIZE = 250;

interface ClassifiedTags {
  interestTags: InterestTagInput[];
  triggerTags: TriggerTagInput[];
  malformed: LibraryInput["malformed"];
}

/**
 * Sorts tags with an st.kind into interest and trigger tags. Prompt tags are
 * validated (they are used through marker primary tags); policy and
 * auto-marker tags are ignored here; an unknown kind is malformed.
 */
export function classifyTags(tags: RawTag[]): ClassifiedTags {
  const out: ClassifiedTags = { interestTags: [], triggerTags: [], malformed: [] };
  const bad = (tag: RawTag, problem: string) => out.malformed.push({ tagId: tag.id, tagName: tag.name, problem });

  for (const tag of tags) {
    const kind = tagKind(tag);
    if (kind === undefined) continue;
    if (kind === "interest") {
      const r = parseInterestTag(tag);
      if ("ok" in r) out.interestTags.push(r.ok);
      else bad(tag, r.problem);
    } else if (kind === "trigger") {
      const r = parseTriggerTag(tag);
      if ("ok" in r) out.triggerTags.push(r.ok);
      else bad(tag, r.problem);
    } else if (kind === "prompt") {
      const r = parsePromptTag(tag);
      if (r && "problem" in r) bad(tag, r.problem);
    } else if (!(KNOWN_KINDS as readonly string[]).includes(kind)) {
      bad(tag, `unknown st.kind ${JSON.stringify(kind)}`);
    }
  }
  return out;
}

export function mapScene(raw: RawScene): SceneInput {
  const markers: MarkerInput[] = (raw.scene_markers ?? []).map((m) => {
    const marker: MarkerInput = { id: m.id, title: m.title ?? "", seconds: m.seconds };
    if (m.end_seconds !== null && m.end_seconds !== undefined) marker.endSeconds = m.end_seconds;
    return { ...marker, ...markerPromptFields(m.primary_tag) };
  });

  const scene: SceneInput = {
    id: raw.id,
    title: raw.title ?? "",
    durationSec: raw.files?.[0]?.duration ?? 0,
    performerIds: (raw.performers ?? []).map((p) => p.id),
    tagIds: (raw.tags ?? []).map((t) => t.id),
    interactive: raw.interactive === true,
    ...sceneProgressFields(raw.custom_fields),
    markers,
  };
  if (raw.date) scene.date = raw.date;
  return scene;
}

export async function loadLibrary(client: StashClient, opts: LoadOptions = {}): Promise<LibraryInput> {
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.floor(opts.pageSize) : DEFAULT_PAGE_SIZE;
  const progress = opts.onProgress ?? (() => {});

  progress("tags");
  const tagsRes = await client.gql<FindStTagsResult>(FIND_ST_TAGS, stTagsVariables());
  const { interestTags, triggerTags, malformed } = classifyTags(tagsRes.findTags.tags);

  const library: LibraryInput = { interestTags, triggerTags, scenes: [], performers: [], malformed };
  if (interestTags.length === 0) return library;

  const tagIds = [...new Set([...interestTags, ...triggerTags].map((t) => t.id))];
  const seenScenes = new Set<string>();
  const performers = new Map<string, PerformerInput>();

  progress("scenes");
  for (let page = 1; ; page++) {
    const res = await client.gql<FindSkillScenesResult>(
      FIND_SKILL_SCENES,
      skillScenesVariables(tagIds, page, pageSize),
    );
    const { count, scenes } = res.findScenes;
    for (const raw of scenes) {
      if (seenScenes.has(raw.id)) continue;
      seenScenes.add(raw.id);
      library.scenes.push(mapScene(raw));
      for (const p of raw.performers ?? []) {
        if (!performers.has(p.id)) performers.set(p.id, { id: p.id, name: p.name });
      }
    }
    const fetched = Math.min((page - 1) * pageSize + scenes.length, count);
    progress(`scenes ${fetched}/${count}`);
    if (scenes.length < pageSize || page * pageSize >= count) break;
  }

  library.performers = [...performers.values()];
  return library;
}
