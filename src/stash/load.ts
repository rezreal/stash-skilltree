// Loads the skill tree input (tags, series groups, scenes, performers) from stash.

import type {
  InterestTagInput,
  LibraryInput,
  MalformedInput,
  MarkerInput,
  PerformerInput,
  SceneInput,
  SeriesInput,
  SeriesPartInput,
  TriggerTagInput,
} from "../core/types.ts";
import type { StashClient } from "./client.ts";
import {
  KNOWN_KINDS,
  markerPromptFields,
  markerReplay,
  parseInterestTag,
  parsePromptTag,
  parseReplayTag,
  parseSeriesFields,
  parseTriggerTag,
  sceneProgressFields,
  tagKind,
} from "./fields.ts";
import {
  FIND_SERIES_GROUPS,
  FIND_SKILL_SCENES,
  FIND_ST_TAGS,
  seriesGroupsVariables,
  seriesScenesVariables,
  skillScenesVariables,
  stTagsVariables,
  type FindSeriesGroupsResult,
  type FindSkillScenesResult,
  type FindStTagsResult,
  type RawScene,
  type RawSeriesGroup,
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
 * Sorts tags with an st.kind into interest and trigger tags. Prompt and
 * replay tags are validated (they are used through marker tags); policy and
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
    } else if (kind === "replay") {
      const r = parseReplayTag(tag);
      if (r && "problem" in r) bad(tag, r.problem);
    } else if (!(KNOWN_KINDS as readonly string[]).includes(kind)) {
      bad(tag, `unknown st.kind ${JSON.stringify(kind)}`);
    }
  }
  return out;
}

/** Numeric ids compare as numbers, others as strings. */
function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** scene_index ascending, parts without an index last, then scene id. */
function comparePartsLoaded(a: SeriesPartInput, b: SeriesPartInput): number {
  if (a.index !== b.index) {
    if (a.index === undefined) return 1;
    if (b.index === undefined) return -1;
    return a.index - b.index;
  }
  return compareIds(a.sceneId, b.sceneId);
}

/**
 * Groups with st.series become SeriesInput (parts with their scene_index in
 * this group, sorted by index then id; play/series.ts refines ties by scene
 * date). Unknown st.series / st.reset values and groups without scenes are
 * malformed.
 */
export function classifySeriesGroups(groups: RawSeriesGroup[]): { series: SeriesInput[]; malformed: MalformedInput[] } {
  const out: { series: SeriesInput[]; malformed: MalformedInput[] } = { series: [], malformed: [] };
  for (const g of groups) {
    const r = parseSeriesFields(g.custom_fields);
    if (r === undefined) continue;
    const parts: SeriesPartInput[] = [];
    const seen = new Set<string>();
    for (const sc of g.scenes ?? []) {
      if (seen.has(sc.id)) continue;
      seen.add(sc.id);
      const link = (sc.groups ?? []).find((sg) => sg.group?.id === g.id);
      const part: SeriesPartInput = { sceneId: sc.id };
      const index = link?.scene_index;
      if (typeof index === "number" && Number.isFinite(index)) part.index = index;
      parts.push(part);
    }
    const problems: string[] = [];
    if ("problem" in r) problems.push(r.problem);
    if (parts.length === 0) problems.push("the series has no scenes");
    if (problems.length > 0) {
      out.malformed.push({ groupId: g.id, groupName: g.name, problem: problems.join("; ") });
      continue;
    }
    if (!("ok" in r)) continue;
    parts.sort(comparePartsLoaded);
    out.series.push({ groupId: g.id, name: g.name, mode: r.ok.mode, reset: r.ok.reset, parts });
  }
  return out;
}

export function mapScene(raw: RawScene): SceneInput {
  const markers: MarkerInput[] = (raw.scene_markers ?? []).map((m) => {
    const marker: MarkerInput = { id: m.id, title: m.title ?? "", seconds: m.seconds };
    if (m.end_seconds !== null && m.end_seconds !== undefined) marker.endSeconds = m.end_seconds;
    const replay = markerReplay(m.tags);
    if (replay !== undefined) marker.replay = replay;
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

  progress("series");
  const groupsRes = await client.gql<FindSeriesGroupsResult>(FIND_SERIES_GROUPS, seriesGroupsVariables());
  const groups = classifySeriesGroups(groupsRes.findGroups.groups);

  const library: LibraryInput = {
    interestTags,
    triggerTags,
    scenes: [],
    performers: [],
    series: groups.series,
    malformed: [...malformed, ...groups.malformed],
  };

  const seenScenes = new Set<string>();
  const performers = new Map<string, PerformerInput>();

  /** Pages through one scene filter, keeping scenes not seen before. */
  const loadScenes = async (label: string, variables: (page: number) => Record<string, unknown>) => {
    progress(label);
    for (let page = 1; ; page++) {
      const res = await client.gql<FindSkillScenesResult>(FIND_SKILL_SCENES, variables(page));
      const { count, scenes } = res.findScenes;
      for (const raw of scenes) {
        if (seenScenes.has(raw.id)) continue;
        seenScenes.add(raw.id);
        library.scenes.push(mapScene(raw));
        for (const p of raw.performers ?? []) {
          if (performers.has(p.id)) continue;
          const performer: PerformerInput = { id: p.id, name: p.name };
          if (p.custom_fields && Object.keys(p.custom_fields).length > 0) performer.customFields = p.custom_fields;
          performers.set(p.id, performer);
        }
      }
      const fetched = Math.min((page - 1) * pageSize + scenes.length, count);
      progress(`${label} ${fetched}/${count}`);
      if (scenes.length < pageSize || page * pageSize >= count) break;
    }
  };

  if (interestTags.length > 0) {
    const tagIds = [...new Set([...interestTags, ...triggerTags].map((t) => t.id))];
    await loadScenes("scenes", (page) => skillScenesVariables(tagIds, page, pageSize));
  }

  // series parts that are not in the tree already
  const missing = library.series.filter((s) => s.parts.some((p) => !seenScenes.has(p.sceneId)));
  if (missing.length > 0) {
    const groupIds = missing.map((s) => s.groupId);
    await loadScenes("series scenes", (page) => seriesScenesVariables(groupIds, page, pageSize));
  }

  library.performers = [...performers.values()];
  return library;
}
