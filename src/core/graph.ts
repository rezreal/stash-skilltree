// Builds the skill graph (nodes = topic levels) from library input.

import type {
  Graph,
  GraphNode,
  Id,
  InterestTagInput,
  LibraryInput,
  LintIssue,
  NodeKey,
  PerformerInput,
  Requirement,
  SceneInput,
} from "./types.ts";
import { DEFAULT_NEED } from "./types.ts";
import { formatAlternative, formatRequirement, nodeKey, normalizeTopic, parseNodeKey, parseRequirement } from "./requirements.ts";

/** Orders node keys by topic, then numeric level. */
export function compareNodeKeys(a: NodeKey, b: NodeKey): number {
  const pa = parseNodeKey(a);
  const pb = parseNodeKey(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.topic !== pb.topic) return pa.topic < pb.topic ? -1 : 1;
  return pa.level - pb.level;
}

/** Smallest whole number found in a spend marker title ("80", "$80", "pay 80 coins"). */
export function parseSpendAmount(title: string): number | undefined {
  const m = title.match(/\d+/g);
  if (!m) return undefined;
  let min: number | undefined;
  for (const s of m) {
    const n = Number(s);
    if (Number.isSafeInteger(n) && (min === undefined || n < min)) min = n;
  }
  return min;
}

function sceneTollAmount(scene: SceneInput): { hasSpend: boolean; amount?: number } {
  let hasSpend = false;
  let amount: number | undefined;
  for (const m of scene.markers) {
    if (m.check !== "spend") continue;
    hasSpend = true;
    const n = parseSpendAmount(m.title);
    if (n !== undefined && (amount === undefined || n < amount)) amount = n;
  }
  return { hasSpend, amount };
}

function addGroups(target: Requirement, groups: Requirement): void {
  const seen = new Set(target.map((g) => formatRequirement([g])));
  for (const g of groups) {
    const k = formatRequirement([g]);
    if (seen.has(k)) continue;
    seen.add(k);
    target.push(g);
  }
}

/**
 * Display order for topics: greedy chain where each next topic is the one most
 * strongly linked (by explicit cross-topic requirements, or by being required
 * together) to the last placed topic, then to any placed topic, then
 * alphabetical.
 */
function orderTopics(topics: string[], nodes: Map<NodeKey, GraphNode>): string[] {
  const weight = new Map<string, number>();
  const pair = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const bump = (a: string, b: string, w: number) => {
    if (a === b) return;
    const k = pair(a, b);
    weight.set(k, (weight.get(k) ?? 0) + w);
  };
  const known = new Set(topics);
  for (const node of nodes.values()) {
    const referenced = new Set<string>();
    for (const g of node.explicitRequires) {
      for (const alt of g) {
        if (alt.kind === "level" && known.has(alt.topic) && alt.topic !== node.topic) referenced.add(alt.topic);
      }
    }
    for (const t of referenced) bump(node.topic, t, 2);
    const refs = [...referenced];
    for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) bump(refs[i], refs[j], 1);
  }
  const w = (a: string, b: string) => weight.get(pair(a, b)) ?? 0;

  const remaining = [...topics].sort();
  const order: string[] = [];
  while (remaining.length > 0) {
    let pick = -1;
    const last = order[order.length - 1];
    if (last !== undefined) {
      let best = 0;
      remaining.forEach((t, i) => {
        const v = w(last, t);
        if (v > best) {
          best = v;
          pick = i;
        }
      });
      if (pick < 0) {
        best = 0;
        remaining.forEach((t, i) => {
          let v = 0;
          for (const p of order) v += w(p, t);
          if (v > best) {
            best = v;
            pick = i;
          }
        });
      }
    }
    if (pick < 0) pick = 0;
    order.push(remaining[pick]);
    remaining.splice(pick, 1);
  }
  return order;
}

export function buildGraph(input: LibraryInput, opts?: { defaultNeed?: number }): Graph {
  const buildIssues: LintIssue[] = [];
  const defaultNeed = opts?.defaultNeed ?? DEFAULT_NEED;

  // --- group interest tags into nodes -------------------------------------
  const tagsByKey = new Map<NodeKey, InterestTagInput[]>();
  const tagKey = new Map<Id, NodeKey>();
  for (const tag of input.interestTags) {
    const topic = normalizeTopic(tag.topic);
    if (topic === "" || !Number.isInteger(tag.level) || tag.level < 0) {
      buildIssues.push({
        severity: "error",
        code: "invalid-interest",
        message: `Interest tag "${tag.name}" has an invalid topic or level (${JSON.stringify(tag.topic)}, ${tag.level})`,
        tagId: tag.id,
      });
      continue;
    }
    const key = nodeKey(topic, tag.level);
    tagKey.set(tag.id, key);
    const list = tagsByKey.get(key);
    if (list) list.push(tag);
    else tagsByKey.set(key, [tag]);
  }

  const nodes = new Map<NodeKey, GraphNode>();
  const explicitPerTag = new Map<Id, Requirement>();
  for (const key of [...tagsByKey.keys()].sort(compareNodeKeys)) {
    const tags = tagsByKey.get(key)!;
    const { topic, level } = parseNodeKey(key)!;
    const explicitRequires: Requirement = [];
    let rawNeed: number | undefined;
    let paid = 0;
    for (const tag of tags) {
      const { req, errors } = parseRequirement(tag.requires);
      for (const e of errors) {
        buildIssues.push({
          severity: "error",
          code: "requires-syntax",
          message: `${key} (tag "${tag.name}"): ${e}`,
          node: key,
          tagId: tag.id,
        });
      }
      explicitPerTag.set(tag.id, req);
      addGroups(explicitRequires, req);
      if (typeof tag.need === "number" && Number.isFinite(tag.need)) {
        rawNeed = rawNeed === undefined ? tag.need : Math.max(rawNeed, tag.need);
      }
      if (typeof tag.paid === "number" && Number.isFinite(tag.paid)) paid = Math.max(paid, tag.paid);
    }
    const requires: Requirement = [];
    if (level > 0) requires.push([{ kind: "level", topic, level: level - 1 }]);
    addGroups(requires, explicitRequires);
    nodes.set(key, {
      key,
      topic,
      level,
      tagIds: tags.map((t) => t.id),
      requires,
      explicitRequires,
      need: 0, // set once scenes are known
      ...(rawNeed !== undefined ? { rawNeed } : {}),
      sceneIds: [],
      paid,
    });
  }

  // --- scenes -------------------------------------------------------------
  const scenes = new Map<Id, SceneInput>();
  const sceneNodes = new Map<Id, NodeKey[]>();
  for (const scene of input.scenes) {
    scenes.set(scene.id, scene);
    const deepest = new Map<string, number>();
    for (const tagId of scene.tagIds) {
      const key = tagKey.get(tagId);
      if (!key) continue;
      const node = nodes.get(key)!;
      const cur = deepest.get(node.topic);
      if (cur === undefined || node.level > cur) deepest.set(node.topic, node.level);
    }
    const keys = [...deepest].map(([t, l]) => nodeKey(t, l)).sort(compareNodeKeys);
    for (const k of keys) nodes.get(k)!.sceneIds.push(scene.id);
    sceneNodes.set(scene.id, keys);
  }

  // --- need, toll ---------------------------------------------------------
  for (const node of nodes.values()) {
    let need = Math.max(1, Math.floor(node.rawNeed ?? defaultNeed));
    if (node.sceneIds.length > 0) need = Math.min(need, node.sceneIds.length);
    node.need = need;

    if (node.sceneIds.length > 0) {
      let allSpend = true;
      let amount: number | undefined;
      for (const id of node.sceneIds) {
        const t = sceneTollAmount(scenes.get(id)!);
        if (!t.hasSpend) {
          allSpend = false;
          break;
        }
        if (t.amount !== undefined && (amount === undefined || t.amount < amount)) amount = t.amount;
      }
      if (allSpend && amount !== undefined) node.toll = { amount };
    }
  }

  // --- unknown references --------------------------------------------------
  for (const node of nodes.values()) {
    for (const tagId of node.tagIds) {
      const req = explicitPerTag.get(tagId) ?? [];
      for (const g of req) {
        for (const alt of g) {
          if (alt.kind !== "level") continue;
          const target = nodeKey(alt.topic, alt.level);
          if (nodes.has(target)) continue;
          const topicExists = [...nodes.values()].some((n) => n.topic === alt.topic);
          buildIssues.push({
            severity: "error",
            code: "unknown-ref",
            message: topicExists
              ? `${node.key} requires ${formatAlternative(alt)}, but topic "${alt.topic}" has no level ${alt.level}`
              : `${node.key} requires ${formatAlternative(alt)}, but there is no topic "${alt.topic}"`,
            node: node.key,
            tagId,
          });
        }
      }
    }
  }

  const topicSet = new Set<string>();
  for (const node of nodes.values()) topicSet.add(node.topic);
  const topics = orderTopics([...topicSet], nodes);

  const performers = new Map<Id, PerformerInput>();
  for (const p of input.performers) performers.set(p.id, p);

  return { nodes, topics, scenes, performers, sceneNodes, buildIssues };
}

/** Node keys of a topic, ordered by level. */
export function topicNodes(graph: Graph, topic: string): NodeKey[] {
  const t = normalizeTopic(topic);
  return [...graph.nodes.values()]
    .filter((n) => n.topic === t)
    .sort((a, b) => a.level - b.level)
    .map((n) => n.key);
}
