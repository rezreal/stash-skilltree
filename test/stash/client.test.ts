import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createClient, defaultBaseUrl, stashUrl } from "../../src/stash/client.ts";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const g = globalThis as Record<string, unknown>;

function setBrowser(baseHref: string | null, origin: string) {
  g.document = {
    querySelector: (sel: string) =>
      sel === "base" && baseHref !== null ? { getAttribute: (n: string) => (n === "href" ? baseHref : null) } : null,
  };
  Object.defineProperty(globalThis, "location", { value: { origin }, configurable: true, writable: true });
}

afterEach(() => {
  delete g.document;
  delete g.location;
});

describe("base URL", () => {
  it("falls back to / outside a browser", () => {
    assert.equal(defaultBaseUrl(), "/");
  });

  it("resolves <base href> with a path prefix against the origin", () => {
    setBrowser("/stash/", "https://host");
    assert.equal(defaultBaseUrl(), "https://host/stash/");
    assert.equal(stashUrl("scenes/123"), "https://host/stash/scenes/123");
  });

  it("adds a missing trailing slash", () => {
    setBrowser("/stash", "https://host");
    assert.equal(defaultBaseUrl(), "https://host/stash/");
  });

  it("uses / without a <base> element", () => {
    setBrowser(null, "http://localhost:9999");
    assert.equal(defaultBaseUrl(), "http://localhost:9999/");
  });

  it("stashUrl joins explicit bases without doubled slashes", () => {
    assert.equal(stashUrl("/scenes/1", "https://host/stash/"), "https://host/stash/scenes/1");
    assert.equal(stashUrl("scenes/1", "https://host/stash"), "https://host/stash/scenes/1");
    assert.equal(stashUrl("tags/5", "/stash/"), "/stash/tags/5");
  });

  it("the client posts to <base>/graphql", async () => {
    setBrowser("/stash/", "https://host");
    const { fetch, calls } = fakeFetch(() => json({ data: { ok: 1 } }));
    await createClient({ fetch }).gql("{ ok }");
    assert.equal(calls[0].url, "https://host/stash/graphql");
  });
});

describe("gql", () => {
  it("posts query and variables as JSON with same-origin credentials", async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: { findTags: { count: 3 } } }));
    const client = createClient({ baseUrl: "https://host/stash/", fetch });
    const data = await client.gql<{ findTags: { count: number } }>("query Q($a: Int) { x }", { a: 1 });
    assert.deepEqual(data, { findTags: { count: 3 } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://host/stash/graphql");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal((calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { query: "query Q($a: Int) { x }", variables: { a: 1 } });
  });

  it("omits variables when none are given", async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: {} }));
    await createClient({ baseUrl: "/", fetch }).gql("{ x }");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { query: "{ x }" });
  });

  it("throws with all GraphQL error messages", async () => {
    const { fetch } = fakeFetch(() => json({ data: null, errors: [{ message: "bad field" }, { message: "other" }] }));
    await assert.rejects(createClient({ baseUrl: "/", fetch }).gql("{ x }"), {
      message: "GraphQL error: bad field; other",
    });
  });

  it("throws on errors even when partial data is present", async () => {
    const { fetch } = fakeFetch(() => json({ data: { x: 1 }, errors: [{ message: "partial" }] }));
    await assert.rejects(createClient({ baseUrl: "/", fetch }).gql("{ x }"), /partial/);
  });

  it("includes GraphQL errors from a non-2xx response", async () => {
    const { fetch } = fakeFetch(() => json({ errors: [{ message: "invalid query" }] }, 422));
    await assert.rejects(createClient({ baseUrl: "/", fetch }).gql("{ x }"), {
      message: "GraphQL error (HTTP 422): invalid query",
    });
  });

  it("throws on non-2xx without a GraphQL body", async () => {
    const { fetch } = fakeFetch(() => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }));
    await assert.rejects(createClient({ baseUrl: "/", fetch }).gql("{ x }"), {
      message: "GraphQL request failed: HTTP 401 Unauthorized: Unauthorized",
    });
  });

  it("throws when the response has no data", async () => {
    const { fetch } = fakeFetch(() => json({}));
    await assert.rejects(createClient({ baseUrl: "/", fetch }).gql("{ x }"), /without data/);
  });

  it("propagates network errors", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch;
    await assert.rejects(createClient({ baseUrl: "/", fetch }).gql("{ x }"), /Failed to fetch/);
  });
});
