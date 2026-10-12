import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../src/stash/client.ts";
import { classifySeriesGroups, loadLibrary } from "../../src/stash/load.ts";
import type { RawScene, RawSeriesGroup, RawTag } from "../../src/stash/queries.ts";

interface Posted {
  query: string;
  variables: Record<string, any>;
}

/** Fake stash server: answers findTags, findGroups and findScenes like v0.31 would. */
function fakeStash(tags: RawTag[], scenes: RawScene[], groups: RawSeriesGroup[] = []) {
  const posted: Posted[] = [];
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posted.push(body);
    let data: unknown;
    if (body.query.includes("findTags")) {
      data = { findTags: { count: tags.length, tags } };
    } else if (body.query.includes("findGroups")) {
      // server-side custom_fields NOT_NULL filter on st.series
      const series = groups.filter((g) => g.custom_fields?.["st.series"] != null);
      data = { findGroups: { count: series.length, groups: series } };
    } else if (body.query.includes("findScenes")) {
      const { page, per_page } = body.variables.filter;
      const sf = body.variables.scene_filter;
      let matching: RawScene[];
      if (sf.tags) {
        const wanted = new Set<string>(sf.tags.value);
        matching = scenes.filter((s) => s.tags.some((t) => wanted.has(t.id)));
      } else {
        const inGroups = new Set<string>();
        for (const g of groups) if (sf.groups.value.includes(g.id)) for (const sc of g.scenes ?? []) inGroups.add(sc.id);
        matching = scenes.filter((s) => inGroups.has(s.id));
      }
      data = {
        findScenes: { count: matching.length, scenes: matching.slice((page - 1) * per_page, page * per_page) },
      };
    } else {
      return new Response(JSON.stringify({ errors: [{ message: "unexpected query" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { client: createClient({ baseUrl: "https://host/stash/", fetch }), posted };
}

const t = (id: string, name: string, custom_fields: Record<string, unknown> | null = {}): RawTag => ({
  id,
  name,
  custom_fields,
});

function scene(id: string, tagIds: string[], extra: Partial<RawScene> = {}): RawScene {
  return {
    id,
    title: `Scene ${id}`,
    date: null,
    interactive: false,
    custom_fields: {},
    files: [{ duration: 60 }],
    performers: [],
    tags: tagIds.map((tid) => ({ id: tid })),
    scene_markers: [],
    ...extra,
  };
}

/** A series group whose scenes are [id, scene_index] pairs (null index allowed). */
function seriesGroup(
  id: string,
  name: string,
  custom_fields: Record<string, unknown> | null,
  parts: [string, number | null][],
): RawSeriesGroup {
  return {
    id,
    name,
    custom_fields,
    scenes: parts.map(([sid, index]) => ({
      id: sid,
      groups: [
        { group: { id: "other" }, scene_index: 99 },
        { group: { id }, scene_index: index },
      ],
    })),
  };
}

const interestA0 = t("10", "A0", { "st.kind": "interest", "st.topic": "a", "st.level": "0" });
const interestA1 = t("11", "A1", { "st.kind": "interest", "st.topic": "a", "st.level": 1, "st.need": "3", "st.requires": "b:0|$20" });
const triggerIn = t("20", "X installed", { "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "installed" });
const promptGaze = t("30", "Gaze eyes", { "st.kind": "prompt", "st.check": "gaze", "st.target": "eyes" });
const policy = t("40", "Policy", { "st.kind": "policy", "st.policy": "attention" });

describe("loadLibrary", () => {
  it("queries tags with the server-side st.kind filter", async () => {
    const { client, posted } = fakeStash([], []);
    await loadLibrary(client);
    assert.match(posted[0].query, /findTags/);
    assert.deepEqual(posted[0].variables.tag_filter, {
      custom_fields: [{ field: "st.kind", modifier: "NOT_NULL" }],
    });
    assert.equal(posted[0].variables.filter.per_page, -1);
  });

  it("returns empty scenes and performers without interest tags", async () => {
    const { client, posted } = fakeStash([triggerIn, policy], [scene("1", ["20"])]);
    const progress: string[] = [];
    const lib = await loadLibrary(client, { onProgress: (m) => progress.push(m) });
    assert.equal(posted.length, 2, "tags and series groups, no scene query");
    assert.deepEqual(lib, {
      interestTags: [],
      triggerTags: [{ id: "20", name: "X installed", trigger: "x", role: "installed" }],
      scenes: [],
      performers: [],
      series: [],
      malformed: [],
    });
    assert.deepEqual(progress, ["tags", "series"]);
  });

  it("classifies tags and collects malformed ones", async () => {
    const tags = [
      interestA0,
      interestA1,
      triggerIn,
      promptGaze,
      policy,
      t("41", "Auto", { "st.kind": "auto-marker" }),
      t("50", "No level", { "st.kind": "interest", "st.topic": "a" }),
      t("51", "Bad role", { "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "maybe" }),
      t("52", "Bad prompt", { "st.kind": "prompt", "st.check": "blink" }),
      t("53", "Typo", { "st.kind": "intrest", "st.topic": "a", "st.level": 0 }),
      t("54", "Blank kind", { "st.kind": " " }),
      t("55", "No fields", null),
    ];
    const { client } = fakeStash(tags, []);
    const lib = await loadLibrary(client);
    assert.deepEqual(lib.interestTags, [
      { id: "10", name: "A0", topic: "a", level: 0 },
      { id: "11", name: "A1", topic: "a", level: 1, need: 3, requires: "b:0|$20" },
    ]);
    assert.deepEqual(lib.triggerTags, [{ id: "20", name: "X installed", trigger: "x", role: "installed" }]);
    assert.deepEqual(lib.malformed, [
      { tagId: "50", tagName: "No level", problem: "st.level is missing" },
      { tagId: "51", tagName: "Bad role", problem: 'st.trigger_role must be "installed" or "used", got "maybe"' },
      { tagId: "52", tagName: "Bad prompt", problem: 'st.check must be one of repeat, gaze, action, spend, got "blink"' },
      { tagId: "53", tagName: "Typo", problem: 'unknown st.kind "intrest"' },
    ]);
  });

  it("paginates scenes filtered by interest and trigger tags", async () => {
    const scenes: RawScene[] = [];
    for (let i = 1; i <= 7; i++) scenes.push(scene(String(i), [i % 2 ? "10" : "20"]));
    scenes.push(scene("8", ["99"])); // unrelated tag, must not be loaded
    const { client, posted } = fakeStash([interestA0, triggerIn], scenes);
    const progress: string[] = [];
    const lib = await loadLibrary(client, { pageSize: 3, onProgress: (m) => progress.push(m) });

    const sceneCalls = posted.filter((p) => p.query.includes("findScenes"));
    assert.equal(sceneCalls.length, 3);
    sceneCalls.forEach((call, i) => {
      assert.deepEqual(call.variables, {
        filter: { page: i + 1, per_page: 3, sort: "id", direction: "ASC" },
        scene_filter: { tags: { value: ["10", "20"], modifier: "INCLUDES", depth: 0 } },
      });
    });
    assert.deepEqual(
      lib.scenes.map((s) => s.id),
      ["1", "2", "3", "4", "5", "6", "7"],
    );
    assert.deepEqual(progress, ["tags", "series", "scenes", "scenes 3/7", "scenes 6/7", "scenes 7/7"]);
  });

  it("stops after an exactly full last page", async () => {
    const scenes = [scene("1", ["10"]), scene("2", ["10"]), scene("3", ["10"]), scene("4", ["10"])];
    const { client, posted } = fakeStash([interestA0], scenes);
    const lib = await loadLibrary(client, { pageSize: 2 });
    assert.equal(posted.filter((p) => p.query.includes("findScenes")).length, 2);
    assert.equal(lib.scenes.length, 4);
  });

  it("uses a default page size of 250", async () => {
    const { client, posted } = fakeStash([interestA0], [scene("1", ["10"])]);
    await loadLibrary(client);
    assert.equal(posted.find((p) => p.query.includes("findScenes"))?.variables.filter.per_page, 250);
  });

  it("maps scenes, markers and unique performers", async () => {
    const plainTag = t("60", "Plain marker tag", {});
    const scenes = [
      scene("1", ["10", "77"], {
        title: "First",
        date: "2024-05-01",
        interactive: true,
        files: [{ duration: 612.5 }, { duration: 1 }],
        performers: [
          { id: "p1", name: "P One", custom_fields: { "st.gaze_regions": '{"v":1,"sessions":1,"sec":{"eyes":4}}' } },
          { id: "p2", name: "P Two", custom_fields: {} },
        ],
        custom_fields: { "st.completed_at": "2026-10-01T10:00:00Z", "st.completions": "2", "st.earned": 30, "st.spent": "5" },
        scene_markers: [
          { id: "m1", title: "look", seconds: 10, end_seconds: 20.5, primary_tag: promptGaze, tags: [plainTag] },
          { id: "m2", title: "chapter", seconds: 30, end_seconds: null, primary_tag: plainTag },
          {
            id: "m3",
            title: "say it",
            seconds: 40,
            end_seconds: 45,
            primary_tag: t("31", "Repeat", { "st.kind": "prompt", "st.check": "repeat" }),
          },
          {
            id: "m4",
            title: "nod",
            seconds: 50,
            end_seconds: 52,
            primary_tag: t("32", "Nod", { "st.kind": "prompt", "st.check": "action", "st.action": "nod" }),
            tags: [t("34", "Skilltree: no replay", { "st.kind": "replay", "st.replay": "no" })],
          },
          { id: "m5", title: "50", seconds: 60, end_seconds: 61, primary_tag: t("33", "Spend", { "st.kind": "prompt", "st.check": "spend" }) },
        ],
      }),
      scene("2", ["20"], { title: null, files: [], performers: [{ id: "p2", name: "P Two" }], custom_fields: null }),
    ];
    const { client } = fakeStash([interestA0, triggerIn], scenes);
    const lib = await loadLibrary(client);

    assert.deepEqual(lib.scenes[0], {
      id: "1",
      title: "First",
      date: "2024-05-01",
      durationSec: 612.5,
      performerIds: ["p1", "p2"],
      tagIds: ["10", "77"],
      interactive: true,
      completedAt: "2026-10-01T10:00:00Z",
      completions: 2,
      earned: 30,
      spent: 5,
      markers: [
        { id: "m1", title: "look", seconds: 10, endSeconds: 20.5, check: "gaze", target: "eyes" },
        { id: "m2", title: "chapter", seconds: 30 },
        { id: "m3", title: "say it", seconds: 40, endSeconds: 45, check: "repeat" },
        { id: "m4", title: "nod", seconds: 50, endSeconds: 52, check: "action", action: "nod", replay: false },
        { id: "m5", title: "50", seconds: 60, endSeconds: 61, check: "spend" },
      ],
    });
    assert.deepEqual(lib.scenes[1], {
      id: "2",
      title: "",
      durationSec: 0,
      performerIds: ["p2"],
      tagIds: ["20"],
      interactive: false,
      completions: 0,
      earned: 0,
      spent: 0,
      markers: [],
    });
    // custom fields only when there are any
    assert.deepEqual(lib.performers, [
      { id: "p1", name: "P One", customFields: { "st.gaze_regions": '{"v":1,"sessions":1,"sec":{"eyes":4}}' } },
      { id: "p2", name: "P Two" },
    ]);
  });

  it("queries series groups with the server-side st.series filter", async () => {
    const { client, posted } = fakeStash([], []);
    await loadLibrary(client);
    const call = posted.find((p) => p.query.includes("findGroups"));
    assert.ok(call);
    assert.match(call.query, /scene_index/);
    assert.deepEqual(call.variables, {
      filter: { per_page: -1, sort: "id", direction: "ASC" },
      group_filter: { custom_fields: [{ field: "st.series", modifier: "NOT_NULL" }] },
    });
  });

  it("loads series parts that are not in the tree, paginated by group", async () => {
    const scenes = [scene("1", ["10"]), scene("2", []), scene("3", []), scene("4", []), scene("5", ["99"])];
    const groups = [
      seriesGroup("g1", "Daily", { "st.series": "daily" }, [["2", 2], ["1", 1], ["3", 3]]),
      seriesGroup("g2", "Other", { "st.series": "daily", "st.reset": "step_back" }, [["4", 1]]),
      seriesGroup("g3", "Not a series", { foo: "bar" }, [["5", 1]]),
    ];
    const { client, posted } = fakeStash([interestA0], scenes, groups);
    const progress: string[] = [];
    const lib = await loadLibrary(client, { pageSize: 2, onProgress: (m) => progress.push(m) });

    assert.deepEqual(lib.series, [
      { groupId: "g1", name: "Daily", mode: "daily", reset: "start", parts: [{ sceneId: "1", index: 1 }, { sceneId: "2", index: 2 }, { sceneId: "3", index: 3 }] },
      { groupId: "g2", name: "Other", mode: "daily", reset: "step_back", parts: [{ sceneId: "4", index: 1 }] },
    ]);
    const seriesCalls = posted.filter((p) => p.query.includes("findScenes") && p.variables.scene_filter.groups);
    assert.deepEqual(
      seriesCalls.map((c) => c.variables),
      [1, 2].map((page) => ({
        filter: { page, per_page: 2, sort: "id", direction: "ASC" },
        scene_filter: { groups: { value: ["g1", "g2"], modifier: "INCLUDES", depth: 0 } },
      })),
    );
    assert.deepEqual(lib.scenes.map((s) => s.id), ["1", "2", "3", "4"]);
    assert.deepEqual(progress, ["tags", "series", "scenes", "scenes 1/1", "series scenes", "series scenes 2/4", "series scenes 4/4"]);
  });

  it("loads series without any interest tag and skips the request when every part is loaded", async () => {
    const groups = [seriesGroup("g1", "Daily", { "st.series": "Daily" }, [["2", 1]])];
    const alone = fakeStash([], [scene("2", [])], groups);
    const lib = await loadLibrary(alone.client);
    assert.deepEqual(lib.scenes.map((s) => s.id), ["2"]);
    assert.equal(lib.series.length, 1);

    const inTree = fakeStash([interestA0], [scene("2", ["10"])], groups);
    await loadLibrary(inTree.client);
    assert.equal(inTree.posted.filter((p) => p.query.includes("findScenes")).length, 1, "only the tree query");
  });

  it("propagates GraphQL errors", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 })) as typeof globalThis.fetch;
    await assert.rejects(loadLibrary(createClient({ baseUrl: "/", fetch })), /boom/);
  });
});

describe("classifySeriesGroups", () => {
  it("keeps the group's own scene_index, sorts missing indices last and dedupes scenes", () => {
    const g = seriesGroup("g", "S", { "st.series": " daily ", "st.reset": "START" }, [["9", null], ["7", 2], ["8", 1], ["7", 2], ["3", null]]);
    assert.deepEqual(classifySeriesGroups([g]), {
      series: [
        {
          groupId: "g",
          name: "S",
          mode: "daily",
          reset: "start",
          parts: [{ sceneId: "8", index: 1 }, { sceneId: "7", index: 2 }, { sceneId: "3" }, { sceneId: "9" }],
        },
      ],
      malformed: [],
    });
  });

  it("reports unknown values and empty series as malformed", () => {
    const r = classifySeriesGroups([
      seriesGroup("a", "Weekly", { "st.series": "weekly", "st.reset": "never" }, [["1", 1]]),
      seriesGroup("b", "Empty", { "st.series": "daily" }, []),
      { id: "c", name: "No scenes field", custom_fields: { "st.series": "daily" }, scenes: null },
      seriesGroup("d", "Plain", {}, [["1", 1]]),
    ]);
    assert.deepEqual(r.series, []);
    assert.deepEqual(r.malformed, [
      { groupId: "a", groupName: "Weekly", problem: 'st.series must be "daily", got "weekly"; st.reset must be "start" or "step_back", got "never"' },
      { groupId: "b", groupName: "Empty", problem: "the series has no scenes" },
      { groupId: "c", groupName: "No scenes field", problem: "the series has no scenes" },
    ]);
  });
});
