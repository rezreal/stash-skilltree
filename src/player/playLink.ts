// Deep links into the play page (/skilltree/play): the current performer,
// test mode and test mode's search live in the query string, so a view can
// be bookmarked, shared or reloaded.
//
//   /skilltree/play?performer=12
//   /skilltree/play?test=1&funscript=1&tags=4,9&q=intro&page=2
//
// Pure, tested under node --test.
import type { Id } from "../core/types.ts";

export interface TestLink {
  tags: Id[];
  funscript: boolean;
  prompts: boolean;
  title: string;
  page: number;
}

export interface PlayLink {
  /** the performer whose suggestions are shown; none = the start view */
  performer?: Id;
  /** test mode with its search; undefined = normal play */
  test?: TestLink;
}

export const EMPTY_TEST_LINK: TestLink = { tags: [], funscript: false, prompts: false, title: "", page: 1 };

/** what the query string says; `has` tells which keys it names at all (the rest falls back to stored choices) */
export function parsePlayLink(search: string): { link: PlayLink; has: { performer: boolean; test: boolean } } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const link: PlayLink = {};
  const performer = params.get("performer")?.trim();
  if (performer) link.performer = performer;
  const testRaw = params.get("test");
  if (testRaw === "1") {
    const page = Number(params.get("page"));
    link.test = {
      tags: (params.get("tags") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => /^\d+$/.test(t)),
      funscript: params.get("funscript") === "1",
      prompts: params.get("prompts") === "1",
      title: params.get("q")?.trim() ?? "",
      page: Number.isInteger(page) && page > 1 ? page : 1,
    };
  }
  return { link, has: { performer: params.has("performer"), test: testRaw !== null } };
}

/** the query string for a view ("" for the start view), in a fixed order */
export function playLinkSearch(link: PlayLink): string {
  const params = new URLSearchParams();
  if (link.test) {
    params.set("test", "1");
    const t = link.test;
    if (t.funscript) params.set("funscript", "1");
    if (t.prompts) params.set("prompts", "1");
    if (t.tags.length > 0) params.set("tags", t.tags.join(","));
    if (t.title.trim()) params.set("q", t.title.trim());
    if (t.page > 1) params.set("page", String(t.page));
  } else if (link.performer) {
    params.set("performer", link.performer);
  }
  const s = params.toString();
  return s ? `?${s.replace(/%2C/g, ",")}` : "";
}
