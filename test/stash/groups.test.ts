import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../src/stash/client.ts";
import { groupFieldsInput, loadAllGroups, updateGroupFields, updateGroupsFields } from "../../src/stash/groups.ts";
import type { RawSetupGroup } from "../../src/stash/queries.ts";

interface Posted {
  query: string;
  variables: Record<string, any>;
}

/** Fake stash server answering findGroups and groupUpdate; `fail` makes groupUpdate fail for an id. */
function fakeStash(groups: RawSetupGroup[], fail?: string) {
  const posted: Posted[] = [];
  const fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Posted;
    posted.push(body);
    let data: unknown;
    if (body.query.includes("findGroups")) {
      data = { findGroups: { count: groups.length, groups } };
    } else if (body.query.includes("groupUpdate")) {
      const { id } = body.variables.input;
      if (id === fail) return new Response(JSON.stringify({ errors: [{ message: "boom" }] }), { status: 200 });
      data = { groupUpdate: { id, custom_fields: {} } };
    } else {
      return new Response(JSON.stringify({ errors: [{ message: "unexpected query" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { client: createClient({ baseUrl: "https://host/stash/", fetch }), posted };
}

describe("loadAllGroups", () => {
  it("asks for every group with scene_count and custom_fields, maps and sorts by name", async () => {
    const { client, posted } = fakeStash([
      { id: "2", name: "beta", scene_count: 4, custom_fields: { "st.series": "daily" } },
      { id: "1", name: "Alpha", scene_count: null, custom_fields: null },
    ]);
    const groups = await loadAllGroups(client);
    assert.match(posted[0].query, /findGroups\(filter: \$filter\)/);
    for (const field of ["id", "name", "scene_count", "custom_fields"]) {
      assert.match(posted[0].query, new RegExp(`\\b${field}\\b`));
    }
    assert.deepEqual(posted[0].variables, { filter: { per_page: -1, sort: "name", direction: "ASC" } });
    assert.deepEqual(groups, [
      { id: "1", name: "Alpha", sceneCount: 0, customFields: {} },
      { id: "2", name: "beta", sceneCount: 4, customFields: { "st.series": "daily" } },
    ]);
  });
});

describe("group writes", () => {
  it("builds a partial/remove input and skips empty changes", () => {
    assert.deepEqual(groupFieldsInput("5", { set: { "st.series": "daily" }, remove: ["st.reset"] }), {
      id: "5",
      custom_fields: { partial: { "st.series": "daily" }, remove: ["st.reset"] },
    });
    assert.equal(groupFieldsInput("5", { set: {}, remove: [] }), undefined);
  });

  it("writes through groupUpdate only when there is a change", async () => {
    const { client, posted } = fakeStash([]);
    await updateGroupFields(client, "5", { set: {}, remove: [] });
    assert.equal(posted.length, 0);
    await updateGroupFields(client, "5", { set: { "st.reset": "step_back" }, remove: [] });
    assert.match(posted[0].query, /groupUpdate\(input: \$input\)/);
    assert.deepEqual(posted[0].variables, { input: { id: "5", custom_fields: { partial: { "st.reset": "step_back" } } } });
  });

  it("stops at the first failure and says how many were written", async () => {
    const { client } = fakeStash([], "2");
    const seen: [number, number][] = [];
    await assert.rejects(
      updateGroupsFields(
        client,
        [
          { groupId: "1", change: { set: { "st.series": "daily" }, remove: [] } },
          { groupId: "2", change: { set: { "st.series": "daily" }, remove: [] } },
          { groupId: "3", change: { set: { "st.series": "daily" }, remove: [] } },
        ],
        (d, t) => seen.push([d, t]),
      ),
      /Wrote 1 of 3 groups; group 2 failed: .*boom/,
    );
    assert.deepEqual(seen, [
      [0, 3],
      [1, 3],
    ]);
  });
});
