// Author-facing checks on the graph and the raw library input.

import type { Graph, LibraryInput, LintIssue, NodeKey, Severity } from "./types.ts";
import { nodeKey } from "./requirements.ts";
import { compareNodeKeys } from "./graph.ts";
import { triggerScenes } from "./triggers.ts";

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Nodes reachable from scratch, assuming every node can be completed once
 * open and every cost can be paid.
 */
export function reachableNodes(graph: Graph): Set<NodeKey> {
  const reached = new Set<NodeKey>();
  const keys = [...graph.nodes.keys()].sort(compareNodeKeys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of keys) {
      if (reached.has(k)) continue;
      const node = graph.nodes.get(k)!;
      const ok = node.requires.every((g) =>
        g.some((alt) => alt.kind === "cost" || reached.has(nodeKey(alt.topic, alt.level))),
      );
      if (ok) {
        reached.add(k);
        changed = true;
      }
    }
  }
  return reached;
}

/** Strongly connected components of the "requires" graph (level alternatives only). */
export function requirementCycles(graph: Graph): NodeKey[][] {
  const keys = [...graph.nodes.keys()].sort(compareNodeKeys);
  const succ = new Map<NodeKey, NodeKey[]>();
  for (const k of keys) {
    const out = new Set<NodeKey>();
    for (const g of graph.nodes.get(k)!.requires) {
      for (const alt of g) {
        if (alt.kind !== "level") continue;
        const t = nodeKey(alt.topic, alt.level);
        if (graph.nodes.has(t)) out.add(t);
      }
    }
    succ.set(k, [...out].sort(compareNodeKeys));
  }

  // Iterative Tarjan.
  let index = 0;
  const idx = new Map<NodeKey, number>();
  const low = new Map<NodeKey, number>();
  const onStack = new Set<NodeKey>();
  const stack: NodeKey[] = [];
  const sccs: NodeKey[][] = [];
  for (const root of keys) {
    if (idx.has(root)) continue;
    const work: { k: NodeKey; i: number }[] = [{ k: root, i: 0 }];
    idx.set(root, index);
    low.set(root, index++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const top = work[work.length - 1];
      const next = succ.get(top.k)!;
      if (top.i < next.length) {
        const w = next[top.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          onStack.add(w);
          work.push({ k: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.k, Math.min(low.get(top.k)!, idx.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].k;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.k)!));
      }
      if (low.get(top.k) === idx.get(top.k)) {
        const comp: NodeKey[] = [];
        let w: NodeKey;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.k);
        const selfLoop = comp.length === 1 && succ.get(comp[0])!.includes(comp[0]);
        if (comp.length > 1 || selfLoop) sccs.push(comp.sort(compareNodeKeys));
      }
    }
  }
  return sccs;
}

export function lintGraph(graph: Graph, input?: LibraryInput): LintIssue[] {
  const issues: LintIssue[] = [...graph.buildIssues];

  for (const m of input?.malformed ?? []) {
    if ("tagId" in m) {
      issues.push({
        severity: "error",
        code: "malformed-tag",
        message: `Tag "${m.tagName}": ${m.problem}`,
        tagId: m.tagId,
      });
    } else {
      issues.push({
        severity: "error",
        code: "malformed-series",
        message: `Group "${m.groupName}": ${m.problem}`,
        groupId: m.groupId,
      });
    }
  }

  const keys = [...graph.nodes.keys()].sort(compareNodeKeys);
  const reached = reachableNodes(graph);
  for (const k of keys) {
    if (reached.has(k)) continue;
    issues.push({
      severity: "error",
      code: "unreachable",
      message: `${k} can never be unlocked: its requirements cannot be met even if everything else is completed`,
      node: k,
    });
  }

  for (const comp of requirementCycles(graph)) {
    for (const k of comp) {
      if (!reached.has(k)) continue;
      issues.push({
        severity: "warning",
        code: "or-cycle",
        message: `${k} is part of a requirement cycle (${comp.join(", ")}) that only closes through an OR alternative`,
        node: k,
      });
    }
  }

  for (const k of keys) {
    const node = graph.nodes.get(k)!;
    if (node.level > 0 && !graph.nodes.has(nodeKey(node.topic, node.level - 1))) {
      issues.push({
        severity: "warning",
        code: "level-gap",
        message: `${k} exists but ${node.topic}:${node.level - 1} does not`,
        node: k,
      });
    }
  }

  for (const k of keys) {
    const node = graph.nodes.get(k)!;
    if (node.sceneIds.length === 0) {
      issues.push({ severity: "warning", code: "empty-node", message: `${k} has no scenes`, node: k });
    } else if (node.rawNeed !== undefined && node.rawNeed > node.sceneIds.length) {
      issues.push({
        severity: "warning",
        code: "need-exceeds-scenes",
        message: `${k} needs ${node.rawNeed} completed scenes but has only ${node.sceneIds.length}; capped at ${node.need}`,
        node: k,
      });
    }
  }

  if (input) {
    for (const [trigger, t] of triggerScenes(input)) {
      if (t.used.length > 0 && t.installed.length === 0) {
        issues.push({
          severity: "warning",
          code: "trigger-unpaired",
          message: `Trigger "${trigger}" is used in ${t.used.length} scene(s) but never installed`,
          tagId: t.usedTagIds[0],
          sceneId: t.used[0].id,
        });
        continue;
      }
      const performers = new Set<string>();
      for (const s of t.used) for (const p of s.performerIds) performers.add(p);
      for (const p of performers) {
        const used = t.used.filter((s) => s.performerIds.includes(p));
        const instDates = t.installed
          .filter((s) => s.performerIds.includes(p) && s.date)
          .map((s) => s.date!)
          .sort();
        if (instDates.length === 0) continue;
        const earliest = instDates[0];
        if (used.length > 0 && used.every((s) => s.date !== undefined && s.date < earliest)) {
          const name = graph.performers.get(p)?.name ?? input.performers.find((x) => x.id === p)?.name ?? p;
          issues.push({
            severity: "info",
            code: "trigger-order",
            message: `Trigger "${trigger}" for ${name}: every "used" scene is dated before the earliest "installed" scene (${earliest})`,
            tagId: t.usedTagIds[0],
            sceneId: used[0].id,
          });
        }
      }
    }
  }

  let undated = 0;
  for (const s of graph.scenes.values()) if (!s.date) undated++;
  if (undated > 0) {
    issues.push({
      severity: "info",
      code: "scene-no-date",
      message: `${undated} scene(s) have no date; performer chronology cannot order them`,
    });
  }

  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] || a.i - b.i)
    .map((x) => x.issue);
}
