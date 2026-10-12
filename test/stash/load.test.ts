import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../src/stash/client.ts";
import { loadLibrary } from "../../src/stash/load.ts";
import type { RawScene, RawTag } from "../../src/stash/queries.ts";

interface Posted {
  query: string;
  variables: Record<string, any>;
}

/** Fake stash server: answers findTags and findScenes like v0.31 would. */
function fakeStash(tags: RawTag[], scenes: RawScene[]) {
  const posted: Posted[] = [];
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posted.push(body);
    let data: unknown;
    if (body.query.includes("findTags")) {
      data = { findTags: { count: tags.length, tags } };
    } else if (body.query.includes("findScenes")) {
      const { page, per_page } = body.variables.filter;
      const wanted = new Set<string>(body.variables.scene_filter.tags.value);
      const matching = scenes.filter((s) => s.tags.some((t) => wanted.has(t.id)));
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
    assert.equal(posted.length, 1, "no scene query");
    assert.deepEqual(lib, {
      interestTags: [],
      triggerTags: [{ id: "20", name: "X installed", trigger: "x", role: "installed" }],
      scenes: [],
      performers: [],
      malformed: [],
    });
    assert.deepEqual(progress, ["tags"]);
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
    assert.deepEqual(progress, ["tags", "scenes", "scenes 3/7", "scenes 6/7", "scenes 7/7"]);
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
    assert.equal(posted[1].variables.filter.per_page, 250);
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
          { id: "p1", name: "P One" },
          { id: "p2", name: "P Two" },
        ],
        custom_fields: { "st.completed_at": "2026-10-01T10:00:00Z", "st.completions": "2", "st.earned": 30, "st.spent": "5" },
        scene_markers: [
          { id: "m1", title: "look", seconds: 10, end_seconds: 20.5, primary_tag: promptGaze },
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
        { id: "m4", title: "nod", seconds: 50, endSeconds: 52, check: "action", action: "nod" },
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
    assert.deepEqual(lib.performers, [
      { id: "p1", name: "P One" },
      { id: "p2", name: "P Two" },
    ]);
  });

  it("propagates GraphQL errors", async () => {
    const fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 })) as typeof globalThis.fetch;
    await assert.rejects(loadLibrary(createClient({ baseUrl: "/", fetch })), /boom/);
  });
});
