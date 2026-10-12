// Deep links into the author page (/skilltree): what is open is kept in the
// query string, so a view can be bookmarked, shared or reloaded.
//
//   /skilltree?node=Relaxation%3A2&performer=12   tree, node selected, filtered
//   /skilltree?fog=1&performer=12                 the viewer's fog view
//   /skilltree?view=setup&tag=345                 setup, tag 345 in the editor
//   /skilltree?view=setup&tab=ladder&topic=Relaxation
//   /skilltree?view=setup&tab=series
//
// A tag implies the tags tab, a topic the ladder tab, and either one the
// setup view. Setup needs the author view, so fog=1 wins over view=setup.
// Pure, tested under node --test.
import type { Id, NodeKey } from "../core/types.ts";

export type AuthorSection = "tree" | "setup";
export type SetupTab = "tags" | "ladder" | "series";

export interface AuthorLink {
  section: AuthorSection;
  /** setup only */
  tab?: SetupTab;
  /** setup, tags tab: the tag in the editor */
  tag?: Id;
  /** setup, ladder tab: the topic */
  topic?: string;
  /** tree: the selected node */
  node?: NodeKey;
  /** the performer filter (tree and fog view) */
  performer?: Id;
  /** the viewer's fog view instead of the author view */
  fog?: boolean;
}

const SETUP_TABS: readonly SetupTab[] = ["tags", "ladder", "series"];

function param(params: URLSearchParams, key: string): string | undefined {
  const v = params.get(key)?.trim();
  return v ? v : undefined;
}

export function parseAuthorLink(search: string): AuthorLink {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const fog = params.get("fog") === "1";
  const performer = param(params, "performer");
  const tag = param(params, "tag");
  const topic = param(params, "topic");
  const tabRaw = param(params, "tab");
  let tab = SETUP_TABS.find((t) => t === tabRaw);
  if (tag) tab = "tags";
  else if (topic && !tab) tab = "ladder";
  const setup = !fog && (params.get("view") === "setup" || tab !== undefined);
  const link: AuthorLink = { section: setup ? "setup" : "tree" };
  if (fog) link.fog = true;
  if (performer) link.performer = performer;
  if (setup) {
    link.tab = tab ?? "tags";
    if (tag && link.tab === "tags") link.tag = tag;
    if (topic && link.tab === "ladder") link.topic = topic;
  } else {
    const node = param(params, "node");
    if (node) link.node = node;
  }
  return link;
}

/** the query string for a link ("" for the plain tree), in a fixed order */
export function authorLinkSearch(link: AuthorLink): string {
  const params = new URLSearchParams();
  const setup = link.section === "setup" && !link.fog;
  if (setup) {
    params.set("view", "setup");
    const tab = link.tab ?? "tags";
    if (tab !== "tags") params.set("tab", tab);
    if (tab === "tags" && link.tag) params.set("tag", link.tag);
    if (tab === "ladder" && link.topic) params.set("topic", link.topic);
  } else {
    if (link.fog) params.set("fog", "1");
    if (link.node) params.set("node", link.node);
  }
  if (link.performer) params.set("performer", link.performer);
  const s = params.toString();
  return s ? `?${s}` : "";
}
