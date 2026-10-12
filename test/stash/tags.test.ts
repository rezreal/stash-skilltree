import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../src/stash/client.ts";
import { loadAllTags, tagFieldsInput, updateTagFields, updateTagsFields } from "../../src/stash/tags.ts";
import type { RawSetupTag } from "../../src/stash/queries.ts";

interface Posted {
  query: string;
  variables: Record<string, any>;
}

/** Fake stash server answering findTags and tagUpdate; `fail` makes tagUpdate fail for an id. */
function fakeStash(tags: RawSetupTag[], fail?: string) {
  const posted: Posted[] = [];
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posted.push(body);
    let data: unknown;
    if (body.query.includes("findTags")) {
      data = { findTags: { count: tags.length, tags } };
    } else if (body.query.includes("tagUpdate")) {
      const { id } = body.variables.input;
      if (id === fail) return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 });
      data = { tagUpdate: { id, custom_fields: {} } };
    } else {
      return new Response(JSON.stringify({ errors: [{ message: "unexpected query" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { client: createClient({ baseUrl: "https://host/stash/", fetch }), posted };
}

const raw = (id: string, name: string, extra: Partial<RawSetupTag> = {}): RawSetupTag => ({
  id,
  name,
  aliases: [],
  scene_count: 0,
  custom_fields: {},
  ...extra,
});

describe("loadAllTags", () => {
  it("asks for every tag with aliases, scene_count and custom_fields", async () => {
    const { client, posted } = fakeStash([]);
    await loadAllTags(client);
    assert.equal(posted.length, 1);
    assert.match(posted[0].query, /findTags\(filter: \$filter\)/);
    for (const field of ["id", "name", "aliases", "scene_count", "custom_fields"]) {
      assert.match(posted[0].query, new RegExp(`\\b${field}\\b`));
    }
    assert.deepEqual(posted[0].variables, { filter: { per_page: -1, sort: "name", direction: "ASC" } });
  });

  it("maps tags, defaults nulls and sorts by name", async () => {
    const { client } = fakeStash([
      raw("2", "beta", { aliases: ["b"], scene_count: 4, custom_fields: { "st.kind": "interest" } }),
      raw("1", "Alpha", { aliases: null, scene_count: null, custom_fields: null }),
    ]);
    assert.deepEqual(await loadAllTags(client), [
      { id: "1", name: "Alpha", aliases: [], sceneCount: 0, customFields: {} },
      { id: "2", name: "beta", aliases: ["b"], sceneCount: 4, customFields: { "st.kind": "interest" } },
    ]);
  });
});

describe("updateTagFields", () => {
  it("posts tagUpdate with partial and remove", async () => {
    const { client, posted } = fakeStash([]);
    await updateTagFields(client, "7", { set: { "st.kind": "interest", "st.level": 2 }, remove: ["st.need"] });
    assert.equal(posted.length, 1);
    assert.match(posted[0].query, /mutation SkilltreeTagFields\(\$input: TagUpdateInput!\)/);
    assert.match(posted[0].query, /tagUpdate\(input: \$input\)/);
    assert.deepEqual(posted[0].variables, {
      input: { id: "7", custom_fields: { partial: { "st.kind": "interest", "st.level": 2 }, remove: ["st.need"] } },
    });
  });

  it("omits an empty partial or remove", async () => {
    const { client, posted } = fakeStash([]);
    await updateTagFields(client, "7", { set: {}, remove: ["st.kind"] });
    await updateTagFields(client, "8", { set: { "st.topic": "a" }, remove: [] });
    assert.deepEqual(posted[0].variables.input, { id: "7", custom_fields: { remove: ["st.kind"] } });
    assert.deepEqual(posted[1].variables.input, { id: "8", custom_fields: { partial: { "st.topic": "a" } } });
  });

  it("sends nothing for an empty change", async () => {
    const { client, posted } = fakeStash([]);
    await updateTagFields(client, "7", { set: {}, remove: [] });
    assert.equal(posted.length, 0);
  });

  it("refuses a key that is both set and removed", async () => {
    const { client, posted } = fakeStash([]);
    await assert.rejects(updateTagFields(client, "7", { set: { "st.level": 1 }, remove: ["st.level"] }), /both set and removed/);
    assert.equal(posted.length, 0);
    assert.throws(() => tagFieldsInput("7", { set: { a: 1 }, remove: ["a"] }), /"a"/);
  });

  it("does not share the caller's objects", () => {
    const change = { set: { a: 1 }, remove: ["b"] };
    const input = tagFieldsInput("1", change) as { custom_fields: { partial: object; remove: string[] } };
    assert.notEqual(input.custom_fields.partial, change.set);
    assert.notEqual(input.custom_fields.remove, change.remove);
  });

  it("propagates server errors", async () => {
    const { client } = fakeStash([], "7");
    await assert.rejects(updateTagFields(client, "7", { set: { a: 1 }, remove: [] }), /boom/);
  });
});

describe("updateTagsFields", () => {
  it("writes tags one after another and reports progress", async () => {
    const { client, posted } = fakeStash([]);
    const progress: string[] = [];
    await updateTagsFields(
      client,
      [
        { tagId: "1", change: { set: { "st.level": 0 }, remove: [] } },
        { tagId: "2", change: { set: {}, remove: [] } },
        { tagId: "3", change: { set: {}, remove: ["st.topic"] } },
      ],
      (done, total) => progress.push(`${done}/${total}`),
    );
    assert.deepEqual(
      posted.map((p) => p.variables.input.id),
      ["1", "3"],
      "empty changes are skipped",
    );
    assert.deepEqual(progress, ["0/3", "1/3", "2/3", "3/3"]);
  });

  it("stops at the first failure and says how far it got", async () => {
    const { client, posted } = fakeStash([], "2");
    const change = { set: { "st.level": 1 }, remove: [] };
    await assert.rejects(
      updateTagsFields(client, [
        { tagId: "1", change },
        { tagId: "2", change },
        { tagId: "3", change },
      ]),
      { message: "Wrote 1 of 3 tags; tag 2 failed: GraphQL error: boom" },
    );
    assert.deepEqual(
      posted.map((p) => p.variables.input.id),
      ["1", "2"],
    );
  });
});
