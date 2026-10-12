// Test mode's scene search: ANY scene in stash, not only tree scenes, by
// tags (all must match), funscript, prompt markers and title. Plus the tag
// picker's search and the on-demand load of one scene for a test session.
// Results go through the library's own mapScene, so markers carry their
// prompt fields exactly as in the tree.
//
// Filters checked against stash v0.31.0 (graphql/schema/types/filters.graphql
// and pkg/sqlite): SceneFilterType.tags (scenes_tags only, INCLUDES_ALL),
// interactive: Boolean (the scene has a funscript), title: StringCriterionInput,
// markers_filter: SceneMarkerFilterType whose `tags` matches a marker's
// primary tag as well as its other tags. There is no server-side filter on a
// tag's custom fields inside markers_filter, so "has prompt markers" is
// markers_filter.tags INCLUDES the ids of the st.kind=prompt tags (loaded
// once, with the same query as the library's st.* tags).
import type { SceneInput } from "../core/types.ts";
import type { StashClient } from "./client.ts";
import { tagKind } from "./fields.ts";
import { mapScene } from "./load.ts";
import {
  FIND_SCENE,
  FIND_SKILL_SCENES,
  FIND_ST_TAGS,
  stTagsVariables,
  type FindSceneResult,
  type FindSkillScenesResult,
  type FindStTagsResult,
} from "./queries.ts";

export const TEST_PER_PAGE = 25;
export const TAG_SEARCH_LIMIT = 20;

export interface TestSearchCriteria {
  /** every one of these tags (scene tags) */
  tagIds: string[];
  /** only scenes with a funscript (stash's interactive flag) */
  funscript: boolean;
  /** only scenes with a marker whose primary tag has st.kind=prompt */
  promptMarkers: boolean;
  /** part of the title (case-insensitive, stash's INCLUDES); blank = any */
  title: string;
  /** 1-based */
  page: number;
}

export const EMPTY_CRITERIA: TestSearchCriteria = { tagIds: [], funscript: false, promptMarkers: false, title: "", page: 1 };

/**
 * The SceneFilterType for the criteria; null when nothing can match (prompt
 * markers asked for, but there are no prompt tags), so no request is needed.
 */
export function testSceneFilter(c: TestSearchCriteria, promptTagIds: readonly string[]): Record<string, unknown> | null {
  const f: Record<string, unknown> = {};
  const tagIds = [...new Set(c.tagIds)];
  if (tagIds.length > 0) f.tags = { value: tagIds, modifier: "INCLUDES_ALL", depth: 0 };
  if (c.funscript) f.interactive = true;
  const title = c.title.trim();
  if (title !== "") f.title = { value: title, modifier: "INCLUDES" };
  if (c.promptMarkers) {
    if (promptTagIds.length === 0) return null;
    f.markers_filter = { tags: { value: [...promptTagIds], modifier: "INCLUDES", depth: 0 } };
  }
  return f;
}

/** findScenes variables: TEST_PER_PAGE per page, newest first */
export function testScenesVariables(c: TestSearchCriteria, promptTagIds: readonly string[]): Record<string, unknown> | null {
  const sceneFilter = testSceneFilter(c, promptTagIds);
  if (sceneFilter === null) return null;
  const page = Number.isInteger(c.page) && c.page > 0 ? c.page : 1;
  return {
    filter: { page, per_page: TEST_PER_PAGE, sort: "date", direction: "DESC" },
    scene_filter: sceneFilter,
  };
}

export function pageCount(count: number, perPage: number = TEST_PER_PAGE): number {
  return count > 0 ? Math.ceil(count / perPage) : 0;
}

export interface TestSceneResult {
  scene: SceneInput;
  performers: { id: string; name: string }[];
}

export interface TestSearchPage {
  count: number;
  results: TestSceneResult[];
}

export async function searchTestScenes(
  client: StashClient,
  c: TestSearchCriteria,
  promptTagIds: readonly string[],
): Promise<TestSearchPage> {
  const variables = testScenesVariables(c, promptTagIds);
  if (variables === null) return { count: 0, results: [] };
  const res = await client.gql<FindSkillScenesResult>(FIND_SKILL_SCENES, variables);
  return {
    count: res.findScenes.count,
    results: res.findScenes.scenes.map((raw) => ({
      scene: mapScene(raw),
      performers: (raw.performers ?? []).map((p) => ({ id: p.id, name: p.name })),
    })),
  };
}

/** ids of the tags with st.kind=prompt (marker primary tags of prompt markers) */
export async function loadPromptTagIds(client: StashClient): Promise<string[]> {
  const res = await client.gql<FindStTagsResult>(FIND_ST_TAGS, stTagsVariables());
  return res.findTags.tags.filter((t) => tagKind(t) === "prompt").map((t) => t.id);
}

// --- tag picker --------------------------------------------------------------

export const SEARCH_TAGS = /* GraphQL */ `
  query SkilltreeTestTags($filter: FindFilterType) {
    findTags(filter: $filter) {
      count
      tags {
        id
        name
        scene_count
      }
    }
  }
`;

export interface TagHit {
  id: string;
  name: string;
  sceneCount: number;
}

interface SearchTagsResult {
  findTags: { count: number; tags: { id: string; name: string; scene_count: number | null }[] };
}

/** findTags by name (stash's q also matches aliases), most used first */
export function tagSearchVariables(q: string, limit: number = TAG_SEARCH_LIMIT): Record<string, unknown> {
  const filter: Record<string, unknown> = { per_page: limit, sort: "scenes_count", direction: "DESC" };
  const text = q.trim();
  if (text !== "") filter.q = text;
  return { filter };
}

export async function searchTags(client: StashClient, q: string): Promise<TagHit[]> {
  const res = await client.gql<SearchTagsResult>(SEARCH_TAGS, tagSearchVariables(q));
  return res.findTags.tags.map((t) => ({ id: t.id, name: t.name, sceneCount: t.scene_count ?? 0 }));
}

// --- one scene -----------------------------------------------------------------

/** One scene with the library loader's fields, mapped like the library; undefined if stash has none. */
export async function loadSceneById(client: StashClient, id: string): Promise<SceneInput | undefined> {
  const res = await client.gql<FindSceneResult>(FIND_SCENE, { id });
  return res.findScene ? mapScene(res.findScene) : undefined;
}
