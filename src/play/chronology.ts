// Performer chronology: a performer's clips are watched in date order, across
// every scene the plugin knows (tree scenes and series parts alike, not per
// topic). A clip with several performers waits until it is next in line for
// every one of them. Pure.
//
// For a scene S and each performer P of S: S may be offered only if every
// other scene of P with a strictly earlier date is completed.
// - Same-date scenes don't order each other.
// - Undated scenes are outside the chronology: they neither block nor are
//   blocked (the author view's lint reports undated scenes).
// - Completed scenes are always allowed: a repeat (earn) was already watched
//   in its turn.
// - Scenes without performers, and ids the source does not know, are allowed.
//
// Per performer the earliest date among their uncompleted dated scenes is the
// frontier; an uncompleted dated S is allowed iff no performer of S has a
// frontier before S.date (S itself is uncompleted, so the frontier is never
// after S.date: allowed means S sits on the frontier of each performer).

import type { Graph, Id, LibraryInput, SceneInput } from "../core/types.ts";

/** Anything carrying the scene universe: the library (array) or a graph (map). */
export type ChronologySource = Pick<LibraryInput, "scenes"> | Pick<Graph, "scenes">;

export interface Chronology {
  /** may this scene be offered as far as performer date order is concerned */
  allowed(sceneId: Id): boolean;
  /** performers of the scene it is not next in line for (empty when allowed) */
  blockers(sceneId: Id): Id[];
  /** the performer's uncompleted dated scenes with the earliest date, by id */
  nextInLine(performerId: Id): SceneInput[];
  /** the performer's frontier: earliest date of an uncompleted dated scene */
  frontier(performerId: Id): string | undefined;
}

function scenesOf(src: ChronologySource): Iterable<SceneInput> {
  return Array.isArray(src.scenes) ? src.scenes : (src.scenes as Map<Id, SceneInput>).values();
}

/** Numeric ids compare as numbers, others as strings. */
function compareIds(a: Id, b: Id): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Precomputes every performer's frontier once; queries are then cheap. */
export function chronology(src: ChronologySource): Chronology {
  const byId = new Map<Id, SceneInput>();
  const front = new Map<Id, string>();
  const next = new Map<Id, SceneInput[]>();
  for (const s of scenesOf(src)) {
    if (byId.has(s.id)) continue;
    byId.set(s.id, s);
    if (s.completedAt !== undefined || !s.date) continue;
    for (const p of new Set(s.performerIds)) {
      const d = front.get(p);
      if (d === undefined || s.date < d) {
        front.set(p, s.date);
        next.set(p, [s]);
      } else if (s.date === d) next.get(p)!.push(s);
    }
  }
  for (const list of next.values()) list.sort((a, b) => compareIds(a.id, b.id));

  const blockers = (sceneId: Id): Id[] => {
    const s = byId.get(sceneId);
    if (!s || s.completedAt !== undefined || !s.date) return [];
    const date = s.date;
    return [...new Set(s.performerIds)].filter((p) => {
      const d = front.get(p);
      return d !== undefined && d < date;
    });
  };
  return {
    allowed: (sceneId) => blockers(sceneId).length === 0,
    blockers,
    nextInLine: (performerId) => [...(next.get(performerId) ?? [])],
    frontier: (performerId) => front.get(performerId),
  };
}

/** `(sceneId) => allowed` by performer chronology (see the file header). */
export function chronologyAllowed(src: ChronologySource): (sceneId: Id) => boolean {
  const c = chronology(src);
  return (sceneId) => c.allowed(sceneId);
}

/** The performer's uncompleted scenes with the earliest date (for explanations). */
export function nextInLine(src: ChronologySource, performerId: Id): SceneInput[] {
  return chronology(src).nextInLine(performerId);
}
