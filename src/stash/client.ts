// Minimal GraphQL client for the stash server the plugin runs in.
//
// Every URL is built from stash's `<base href>` so the plugin keeps working
// behind a reverse proxy that serves stash under a path prefix
// (e.g. https://host/stash/).

export interface StashClient {
  gql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface ClientOptions {
  /** absolute or root-relative base URL of the stash UI, e.g. "https://host/stash/" */
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : url + "/";
}

/**
 * The stash UI's base URL with a trailing slash, from `<base href>` resolved
 * against the page origin. Falls back to "/" outside a browser.
 */
export function defaultBaseUrl(): string {
  const g = globalThis as {
    document?: { querySelector(sel: string): { getAttribute(name: string): string | null } | null };
    location?: { origin?: string };
  };
  const href = g.document?.querySelector("base")?.getAttribute("href") ?? "/";
  const origin = g.location?.origin;
  if (!origin || origin === "null") return withTrailingSlash(href);
  return withTrailingSlash(new URL(href, origin).href);
}

/** Link to a stash page, e.g. stashUrl("scenes/123") -> "https://host/stash/scenes/123". */
export function stashUrl(path: string, baseUrl?: string): string {
  return withTrailingSlash(baseUrl ?? defaultBaseUrl()) + path.replace(/^\/+/, "");
}

function errorMessages(errors: { message?: string }[]): string {
  return errors.map((e) => e?.message ?? String(e)).join("; ");
}

export function createClient(opts: ClientOptions = {}): StashClient {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const endpoint = stashUrl("graphql", opts.baseUrl);

  return {
    async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const res = await doFetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });

      const text = await res.text();
      let body: GraphQLResponse<T> | undefined;
      try {
        body = text ? (JSON.parse(text) as GraphQLResponse<T>) : undefined;
      } catch {
        body = undefined;
      }

      if (body?.errors && body.errors.length > 0) {
        const prefix = res.ok ? "GraphQL error" : `GraphQL error (HTTP ${res.status})`;
        throw new Error(`${prefix}: ${errorMessages(body.errors)}`);
      }
      if (!res.ok) {
        const detail = text.trim().slice(0, 200);
        throw new Error(
          `GraphQL request failed: HTTP ${res.status}${res.statusText ? " " + res.statusText : ""}` +
            (detail ? `: ${detail}` : ""),
        );
      }
      if (!body || body.data == null) {
        throw new Error("GraphQL response without data");
      }
      return body.data;
    },
  };
}
