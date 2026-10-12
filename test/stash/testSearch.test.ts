import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StashClient } from "../../src/stash/client.ts";
import { FIND_SCENE, FIND_SKILL_SCENES, SCENE_FIELDS, type RawScene } from "../../src/stash/queries.ts";
import {
  EMPTY_CRITERIA,
  SEARCH_TAGS,
  TEST_PER_PAGE,
  loadPromptTagIds,
  loadSceneById,
  pageCount,
  searchTags,
  loadTagsByIds,
  TAGS_BY_IDS,
  searchTestScenes,
  tagSearchVariables,
  testSceneFilter,
  testScenesVariables,
} from "../../src/stash/testSearch.ts";

interface Call {
  query: string;
  variables: Record<string, any> | undefined;
}

function fakeClient(respond: (call: Call) => unknown): { client: StashClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
        const call = { query, variables };
        calls.push(call);
        return respond(call) as T;
      },
    },
  };
}

const rawScene = (id: string, extra: Partial<RawScene> = {}): RawScene => ({
  id,
  title: `Scene ${id}`,
  date: "2024-05-01",
  interactive: true,
  custom_fields: { "st.completions": 2 },
  files: [{ duration: 300 }],
  performers: [{ id: "p1", name: "Ava" }],
  tags: [{ id: "t1" }],
  scene_markers: [
    {
      id: "m1",
      title: "say yes",
      seconds: 10,
      end_seconds: 20,
      primary_tag: { id: "pt", name: "Repeat", custom_fields: { "st.kind": "prompt", "st.check": "repeat" } },
    },
    { id: "m2", title: "chapter", seconds: 30, end_seconds: null, primary_tag: { id: "x", name: "Chapter", custom_fields: {} } },
  ],
  ...extra,
});

describe("testSceneFilter", () => {
  it("is empty without criteria: any scene in stash", () => {
    assert.deepEqual(testSceneFilter(EMPTY_CRITERIA, []), {});
  });

  it("tags must all match (scene tags, no hierarchy), duplicates dropped", () => {
    assert.deepEqual(testSceneFilter({ ...EMPTY_CRITERIA, tagIds: ["3", "5", "3"] }, []), {
      tags: { value: ["3", "5"], modifier: "INCLUDES_ALL", depth: 0 },
    });
  });

  it("funscript = interactive, title = trimmed INCLUDES", () => {
    assert.deepEqual(testSceneFilter({ ...EMPTY_CRITERIA, funscript: true, title: "  intro " }, []), {
      interactive: true,
      title: { value: "intro", modifier: "INCLUDES" },
    });
    assert.deepEqual(testSceneFilter({ ...EMPTY_CRITERIA, title: "   " }, []), {});
  });

  it("prompt markers = markers_filter on the prompt tags; null when there are none", () => {
    assert.deepEqual(testSceneFilter({ ...EMPTY_CRITERIA, promptMarkers: true }, ["p1", "p2"]), {
      markers_filter: { tags: { value: ["p1", "p2"], modifier: "INCLUDES", depth: 0 } },
    });
    assert.equal(testSceneFilter({ ...EMPTY_CRITERIA, promptMarkers: true }, []), null);
  });

  it("combines everything", () => {
    const f = testSceneFilter({ tagIds: ["1"], funscript: true, promptMarkers: true, title: "a", page: 2 }, ["p"]);
    assert.deepEqual(Object.keys(f ?? {}).sort(), ["interactive", "markers_filter", "tags", "title"]);
  });
});

describe("testScenesVariables", () => {
  it("pages of 25, newest first; bad pages read as 1", () => {
    assert.deepEqual(testScenesVariables({ ...EMPTY_CRITERIA, page: 3 }, []), {
      filter: { page: 3, per_page: TEST_PER_PAGE, sort: "date", direction: "DESC" },
      scene_filter: {},
    });
    assert.equal(TEST_PER_PAGE, 25);
    for (const page of [0, -1, 1.5, Number.NaN]) {
      assert.equal((testScenesVariables({ ...EMPTY_CRITERIA, page }, [])?.filter as { page: number }).page, 1);
    }
    assert.equal(testScenesVariables({ ...EMPTY_CRITERIA, promptMarkers: true }, []), null);
  });

  it("pageCount", () => {
    assert.equal(pageCount(0), 0);
    assert.equal(pageCount(25), 1);
    assert.equal(pageCount(26), 2);
  });
});

describe("searchTestScenes", () => {
  it("uses the library's scene query and mapping, so prompt fields come along", async () => {
    const { client, calls } = fakeClient(() => ({ findScenes: { count: 30, scenes: [rawScene("9")] } }));
    const page = await searchTestScenes(client, { ...EMPTY_CRITERIA, tagIds: ["t1"], page: 2 }, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].query, FIND_SKILL_SCENES);
    assert.deepEqual(calls[0].variables?.scene_filter, { tags: { value: ["t1"], modifier: "INCLUDES_ALL", depth: 0 } });
    assert.equal(page.count, 30);
    const r = page.results[0];
    assert.deepEqual(r.performers, [{ id: "p1", name: "Ava" }]);
    assert.equal(r.scene.id, "9");
    assert.equal(r.scene.interactive, true);
    assert.equal(r.scene.durationSec, 300);
    assert.equal(r.scene.completions, 2);
    assert.equal(r.scene.markers[0].check, "repeat");
    assert.equal(r.scene.markers[0].endSeconds, 20);
    assert.equal(r.scene.markers[1].check, undefined);
  });

  it("asks nothing when nothing can match", async () => {
    const { client, calls } = fakeClient(() => assert.fail("no request expected"));
    assert.deepEqual(await searchTestScenes(client, { ...EMPTY_CRITERIA, promptMarkers: true }, []), { count: 0, results: [] });
    assert.equal(calls.length, 0);
  });
});

describe("tags and single scenes", () => {
  it("prompt tag ids: st.kind=prompt only", async () => {
    const { client } = fakeClient(() => ({
      findTags: {
        count: 3,
        tags: [
          { id: "1", name: "Repeat", custom_fields: { "st.kind": " Prompt " } },
          { id: "2", name: "Fixation", custom_fields: { "st.kind": "interest" } },
          { id: "3", name: "Gaze", custom_fields: { "st.kind": "prompt" } },
        ],
      },
    }));
    assert.deepEqual(await loadPromptTagIds(client), ["1", "3"]);
  });

  it("tag search: by name, most used first, limited, with scene counts", async () => {
    assert.deepEqual(tagSearchVariables(" bl "), { filter: { per_page: 20, sort: "scenes_count", direction: "DESC", q: "bl" } });
    assert.deepEqual(tagSearchVariables(""), { filter: { per_page: 20, sort: "scenes_count", direction: "DESC" } });
    const { client, calls } = fakeClient(() => ({
      findTags: { count: 2, tags: [{ id: "1", name: "Blue", scene_count: 12 }, { id: "2", name: "Black", scene_count: null }] },
    }));
    assert.deepEqual(await searchTags(client, "bl"), [
      { id: "1", name: "Blue", sceneCount: 12 },
      { id: "2", name: "Black", sceneCount: 0 },
    ]);
    assert.equal(calls[0].query, SEARCH_TAGS);
  });

  it("loadTagsByIds: keeps the given order and skips unknown ids", async () => {
    const { client, calls } = fakeClient(() => ({
      findTags: { count: 2, tags: [{ id: "2", name: "Black", scene_count: 3 }, { id: "1", name: "Blue", scene_count: null }] },
    }));
    assert.deepEqual(await loadTagsByIds(client, ["1", "9", "2"]), [
      { id: "1", name: "Blue", sceneCount: 0 },
      { id: "2", name: "Black", sceneCount: 3 },
    ]);
    assert.equal(calls[0].query, TAGS_BY_IDS);
    assert.deepEqual(calls[0].variables, { ids: ["1", "9", "2"], filter: { per_page: -1 } });
    assert.deepEqual(await loadTagsByIds(client, []), []);
    assert.equal(calls.length, 1, "no request without ids");
  });

  it("loadSceneById: findScene with the same fields, mapped like the library", async () => {
    const { client, calls } = fakeClient((c) => ({ findScene: c.variables?.id === "9" ? rawScene("9") : null }));
    const scene = await loadSceneById(client, "9");
    assert.equal(calls[0].query, FIND_SCENE);
    assert.equal(scene?.markers[0].check, "repeat");
    assert.deepEqual(scene?.tagIds, ["t1"]);
    assert.equal(await loadSceneById(client, "404"), undefined);
  });

  it("findScene and findScenes ask for the same scene fields", () => {
    assert.ok(FIND_SCENE.includes(SCENE_FIELDS));
    assert.ok(FIND_SKILL_SCENES.includes(SCENE_FIELDS));
    assert.match(SCENE_FIELDS, /primary_tag \{\s+id\s+name\s+custom_fields/);
  });
});
