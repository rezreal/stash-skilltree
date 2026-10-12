// Requirement grammar for st.requires:
//   requirement = group ("," group)*        AND, binds loosest
//   group       = alternative ("|" alternative)*   OR
//   alternative = topic ":" level | "$" amount

import type { Alternative, NodeKey, Requirement } from "./types.ts";

/** Canonical topic id: trimmed, lowercase, inner whitespace collapsed. */
export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, " ");
}

export function nodeKey(topic: string, level: number): NodeKey {
  return `${normalizeTopic(topic)}:${level}`;
}

/** Inverse of nodeKey; undefined if the key is not `topic:level`. */
export function parseNodeKey(key: NodeKey): { topic: string; level: number } | undefined {
  const i = key.lastIndexOf(":");
  if (i <= 0) return undefined;
  const level = Number(key.slice(i + 1));
  if (!Number.isInteger(level) || level < 0) return undefined;
  return { topic: key.slice(0, i), level };
}

const TOPIC_RE = /^[\p{L}\p{N}_\- ]+$/u;
const UINT_RE = /^\d+$/;

function parseAlternative(raw: string): Alternative | string {
  const s = raw.trim();
  if (s.startsWith("$")) {
    const n = s.slice(1).trim();
    if (!UINT_RE.test(n)) return `invalid cost "${s}": expected $ followed by a whole number`;
    const amount = Number(n);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return `invalid cost "${s}": amount must be a positive whole number`;
    }
    return { kind: "cost", amount };
  }
  const parts = s.split(":");
  if (parts.length !== 2) return `invalid requirement "${s}": expected topic:level or $amount`;
  const topic = normalizeTopic(parts[0]);
  const lv = parts[1].trim();
  if (topic === "") return `invalid requirement "${s}": missing topic`;
  if (!TOPIC_RE.test(topic)) {
    return `invalid requirement "${s}": topic may only contain letters, digits, spaces, _ and -`;
  }
  if (!UINT_RE.test(lv) || !Number.isSafeInteger(Number(lv))) {
    return `invalid requirement "${s}": level must be a whole number ≥ 0`;
  }
  return { kind: "level", topic, level: Number(lv) };
}

/**
 * Parse an st.requires string. Invalid alternatives are dropped and reported;
 * groups left empty are dropped. Empty tokens (e.g. a trailing comma) are
 * ignored silently.
 */
export function parseRequirement(src: string | undefined): { req: Requirement; errors: string[] } {
  const req: Requirement = [];
  const errors: string[] = [];
  if (src === undefined || src.trim() === "") return { req, errors };
  for (const groupSrc of src.split(",")) {
    const group: Alternative[] = [];
    for (const altSrc of groupSrc.split("|")) {
      if (altSrc.trim() === "") continue;
      const alt = parseAlternative(altSrc);
      if (typeof alt === "string") errors.push(alt);
      else group.push(alt);
    }
    if (group.length > 0) req.push(group);
  }
  return { req, errors };
}

export function formatAlternative(alt: Alternative): string {
  return alt.kind === "cost" ? `$${alt.amount}` : `${alt.topic}:${alt.level}`;
}

/** Canonical st.requires form; parseRequirement(formatRequirement(r)) equals r. */
export function formatRequirement(req: Requirement): string {
  return req.map((g) => g.map(formatAlternative).join("|")).join(",");
}

export function describeAlternative(alt: Alternative): string {
  return alt.kind === "cost" ? `pay ${alt.amount}` : `${alt.topic} L${alt.level}`;
}

/** Plain English, e.g. "relaxation L1 and (deepening L2 or fixation L2)". */
export function describeRequirement(req: Requirement): string {
  const groups = req.filter((g) => g.length > 0);
  if (groups.length === 0) return "no requirements";
  return groups
    .map((g) => {
      const s = g.map(describeAlternative).join(" or ");
      return g.length > 1 && groups.length > 1 ? `(${s})` : s;
    })
    .join(" and ");
}

export function sameAlternative(a: Alternative, b: Alternative): boolean {
  if (a.kind === "cost") return b.kind === "cost" && a.amount === b.amount;
  return b.kind === "level" && a.topic === b.topic && a.level === b.level;
}
