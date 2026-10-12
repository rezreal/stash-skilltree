// Suggestions for the choice screen: continue / explore / earn, performer
// switches and the start screen. Pure; inputs come from core + economy.
//
// Hard filters on every clip offered (AND): trigger pairs (installed before
// used), daily series (only the next part of a series not done today) and
// performer chronology (a performer's clips in date order, see
// chronology.ts). Repeats of completed clips pass chronology.

import type {
  Graph,
  GraphNode,
  Id,
  LibraryInput,
  NodeKey,
  Progress,
  SceneInput,
  SeriesInput,
  Visibility,
} from "../core/types.ts";
import type { TriggerEdge } from "../core/index.ts";
import { groupSatisfied, parseNodeKey, topicDepth } from "../core/index.ts";
import { effortScore, estimateEarn, repeatFactor, spendCost, promptCount } from "./economy.ts";
import { policyForScene } from "./policy.ts";
import { blockedSeriesScenes, seriesStatus } from "./series.ts";
import { chronology, type Chronology } from "./chronology.ts";
import type {
  ChronologyWait,
  Ledger,
  PerformerSwitch,
  PolicyTagInput,
  SeriesStatus,
  Streak,
  Suggestion,
  SuggestionResult,
} from "./types.ts";

export interface SuggestInput {
  graph: Graph;
  /** global progress (no performer filter) */
  progress: Progress;
  visibility: Map<NodeKey, Visibility>;
  library: LibraryInput;
  policyTags: PolicyTagInput[];
  ledger: Ledger;
  streak: Streak;
  performerId?: Id;
  edges: TriggerEdge[];
  /** options to return (default 2) */
  max?: number;
  /** the moment daily series are judged at (default: now) */
  now?: Date;
  /** day boundary hour for daily series (default 4) */
  dayStartHour?: number;
}

/** Balance below which an earn option is always offered. */
export const LOW_BALANCE = 20;

// --- describe helpers ----------------------------------------------------------------

/** "fixation" -> "Fixation", "body scan" -> "Body Scan". */
export function topicLabel(topic: string): string {
  return topic.replace(/(^|[\s_-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** "deepening:3" -> "Deepening L3". */
export function describeNode(key: NodeKey): string {
  const p = parseNodeKey(key);
  return p ? `${topicLabel(p.topic)} L${p.level}` : key;
}

// --- candidates ------------------------------------------------------------------------

type CandidateState = "open" | "complete" | "gate";

interface Candidate {
  scene: SceneInput;
  node: GraphNode;
  state: CandidateState;
  /** coins to open the node first (gate), else 0 */
  price: number;
  spendCost: number;
  completed: boolean;
  /** allowed by performer chronology (completed scenes always are) */
  inLine: boolean;
}

/**
 * Coins needed to open a gate node now: every unmet group must be bought, a
 * group costs its cheapest cost alternative; minus what was already paid.
 * Infinity when some unmet group cannot be bought.
 */
export function gatePrice(graph: Graph, progress: Progress, key: NodeKey): number {
  const node = graph.nodes.get(key);
  if (!node) return Infinity;
  const isComplete = (k: NodeKey) => progress.get(k)?.state === "complete";
  let need = 0;
  for (const g of node.requires) {
    if (groupSatisfied(g, node.paid, isComplete)) continue;
    let cheapest = Infinity;
    for (const alt of g) if (alt.kind === "cost") cheapest = Math.min(cheapest, alt.amount);
    need = Math.max(need, cheapest);
  }
  return Math.max(0, need - node.paid);
}

/**
 * Scenes allowed by trigger pairs: for every trigger with edges into a
 * "used" scene, at least one of that trigger's "installed" scenes must be
 * completed (AND across triggers, OR within one trigger). A sub-trigger
 * scene also uses its parent trigger, so it needs both installed.
 */
function triggerAllowed(graph: Graph, edges: TriggerEdge[]): (sceneId: Id) => boolean {
  const from = new Map<Id, Map<string, Id[]>>();
  for (const e of edges) {
    let byTrigger = from.get(e.to);
    if (!byTrigger) from.set(e.to, (byTrigger = new Map()));
    const list = byTrigger.get(e.trigger);
    if (list) list.push(e.from);
    else byTrigger.set(e.trigger, [e.from]);
  }
  const completed = (f: Id) => graph.scenes.get(f)?.completedAt !== undefined;
  return (id) => {
    const byTrigger = from.get(id);
    if (!byTrigger) return true;
    for (const list of byTrigger.values()) if (!list.some(completed)) return false;
    return true;
  };
}

function triggerOf(edges: TriggerEdge[], graph: Graph, sceneId: Id): string | undefined {
  for (const e of edges) if (e.to === sceneId && graph.scenes.get(e.from)?.completedAt) return e.trigger;
  return undefined;
}

/**
 * Clips in open, complete and gate nodes that pass the trigger and series
 * filters. Parts of daily series never come up as normal suggestions, except
 * the next part of a series that is not done for today (blockedSeriesScenes).
 * Chronology is not filtered here but flagged (`inLine`), so suggest can tell
 * why its best clip is held back; every offer takes only `inLine` candidates.
 */
function allCandidates(input: SuggestInput, chrono: Chronology): Candidate[] {
  const { graph, progress, visibility } = input;
  const triggerOk = triggerAllowed(graph, input.edges);
  const series = input.library.series ?? [];
  const blocked =
    series.length > 0
      ? blockedSeriesScenes(series, graph.scenes, input.now ?? new Date(), input.dayStartHour)
      : new Set<Id>();
  const allowed = (id: Id) => !blocked.has(id) && triggerOk(id);
  const out: Candidate[] = [];
  for (const node of graph.nodes.values()) {
    const ps = progress.get(node.key)?.state ?? "locked";
    let state: CandidateState;
    let price = 0;
    if (ps === "open" || ps === "complete") state = ps;
    else if (visibility.get(node.key) === "gate") {
      state = "gate";
      price = gatePrice(graph, progress, node.key);
      if (!Number.isFinite(price)) continue;
    } else continue;
    for (const id of node.sceneIds) {
      const scene = graph.scenes.get(id);
      if (!scene || !allowed(id)) continue;
      out.push({
        scene,
        node,
        state,
        price,
        spendCost: spendCost(scene),
        completed: scene.completedAt !== undefined,
        inLine: chrono.allowed(id),
      });
    }
  }
  return out;
}

const affordable = (c: Candidate, balance: number) => c.spendCost + c.price <= balance;
/** not completed yet, in an open or gate node: what continue/explore pick from */
const fresh = (c: Candidate) => !c.completed && (c.state === "open" || c.state === "gate");
const hasPerformer = (s: SceneInput, p: Id | undefined) => p === undefined || s.performerIds.includes(p);

/** Numeric ids compare as numbers, others as strings. */
function compareIds(a: Id, b: Id): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Earliest date first, undated last, then id. */
function compareScenes(a: SceneInput, b: SceneInput): number {
  if (a.date !== b.date) {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : 1;
  }
  return compareIds(a.id, b.id);
}

function earliestDate(scenes: SceneInput[]): string | undefined {
  let d: string | undefined;
  for (const s of scenes) if (s.date && (d === undefined || s.date < d)) d = s.date;
  return d;
}

function distinctScenes(cands: Candidate[]): SceneInput[] {
  const seen = new Map<Id, SceneInput>();
  for (const c of cands) if (!seen.has(c.scene.id)) seen.set(c.scene.id, c.scene);
  return [...seen.values()];
}

/** Topics in which the performer (or anyone, if undefined) has a completed scene. */
function completedTopics(graph: Graph, performerId: Id | undefined): Set<string> {
  const out = new Set<string>();
  for (const s of graph.scenes.values()) {
    if (!s.completedAt || !hasPerformer(s, performerId)) continue;
    for (const k of graph.sceneNodes.get(s.id) ?? []) {
      const n = graph.nodes.get(k);
      if (n) out.add(n.topic);
    }
  }
  return out;
}

/** Performer with the most open, affordable, new scenes; ties: earliest scene date, then id. */
function busiestPerformer(cands: Candidate[], balance: number): Id | undefined {
  const per = new Map<Id, Set<Id>>();
  const first = new Map<Id, string>();
  for (const c of cands) {
    if (!fresh(c) || c.state !== "open" || !affordable(c, balance)) continue;
    for (const p of c.scene.performerIds) {
      let set = per.get(p);
      if (!set) per.set(p, (set = new Set()));
      set.add(c.scene.id);
      const d = c.scene.date;
      if (d && (!first.has(p) || d < first.get(p)!)) first.set(p, d);
    }
  }
  let best: Id | undefined;
  for (const p of per.keys()) {
    if (best === undefined) {
      best = p;
      continue;
    }
    const diff = per.get(p)!.size - per.get(best)!.size;
    if (diff > 0) best = p;
    else if (diff === 0) {
      const dp = first.get(p);
      const db = first.get(best);
      if (dp !== db) {
        if (dp !== undefined && (db === undefined || dp < db)) best = p;
      } else if (compareIds(p, best) < 0) best = p;
    }
  }
  return best;
}

// --- picking ---------------------------------------------------------------------------

interface Pick {
  cand?: Candidate;
  /** best node was not affordable */
  blocked?: { node: NodeKey; cost: number };
}

/**
 * Takes the first node in `nodeOrder` with candidates, and in it the earliest
 * affordable scene (scenes matching `prefer` first). If the node has
 * candidates but none is affordable, the pick is blocked by that node.
 */
function pickFromBestNode(
  cands: Candidate[],
  nodeOrder: (a: Candidate, b: Candidate) => number,
  balance: number,
  exclude: Set<Id>,
  prefer?: (c: Candidate) => boolean,
): Pick {
  const pool = cands.filter((c) => !exclude.has(c.scene.id));
  if (pool.length === 0) return {};
  pool.sort((a, b) => nodeOrder(a, b) || compareScenes(a.scene, b.scene));
  const key = pool[0].node.key;
  const inNode = pool.filter((c) => c.node.key === key);
  const preferred = prefer ? inNode.filter(prefer) : [];
  const ordered = [...preferred, ...inNode.filter((c) => !preferred.includes(c))];
  const ok = ordered.find((c) => affordable(c, balance));
  if (ok) return { cand: ok };
  let cost = Infinity;
  for (const c of inNode) cost = Math.min(cost, c.spendCost + c.price);
  return { blocked: { node: key, cost } };
}

function nodeReason(c: Candidate, progress: Progress): string {
  const label = describeNode(c.node.key);
  if (c.state === "gate") return `opens ${label} for ${c.price}`;
  const p = progress.get(c.node.key);
  const done = p?.completed ?? 0;
  const need = p?.need ?? c.node.need;
  if (c.state === "complete" || done >= need) return `${label} is complete`;
  return `counts toward ${label} (${done} of ${need} done)`;
}

export function suggest(input: SuggestInput): SuggestionResult {
  const { graph, progress, ledger, streak, edges } = input;
  const max = Math.max(0, Math.floor(input.max ?? 2));
  const balance = ledger.balance;
  const chrono = chronology(input.library);
  const every = allCandidates(input, chrono);
  const cands = every.filter((c) => c.inLine);
  const performerId = input.performerId ?? busiestPerformer(cands, balance);
  const forP = (c: Candidate) => hasPerformer(c.scene, performerId);

  const policyCache = new Map<Id, ReturnType<typeof policyForScene>>();
  const policyOf = (s: SceneInput) => {
    let p = policyCache.get(s.id);
    if (!p) policyCache.set(s.id, (p = policyForScene(s, input.policyTags)));
    return p;
  };
  const earnOf = (s: SceneInput) => estimateEarn(s, policyOf(s), streak);

  const chosen = new Set<Id>();
  let blocked: SuggestionResult["blocked"];

  const toSuggestion = (kind: Suggestion["kind"], c: Candidate, reasons: string[]): Suggestion => {
    chosen.add(c.scene.id);
    if (c.spendCost > 0) reasons.push(`asks for ${c.spendCost} coins`);
    return {
      kind,
      sceneId: c.scene.id,
      node: c.node.key,
      spendCost: c.spendCost,
      price: c.price,
      estimatedEarn: earnOf(c.scene),
      reasons,
    };
  };

  // continue: deepest topic first, open before gate, lower level first
  const depth = new Map<string, number>();
  const depthOf = (topic: string) => {
    let d = depth.get(topic);
    if (d === undefined) depth.set(topic, (d = topicDepth(graph, progress, topic)));
    return d;
  };
  const gateLast = (c: Candidate) => (c.state === "gate" ? 1 : 0);
  const continueOrder = (a: Candidate, b: Candidate) =>
    depthOf(b.node.topic) - depthOf(a.node.topic) ||
    gateLast(a) - gateLast(b) ||
    a.node.level - b.node.level ||
    (a.node.key < b.node.key ? -1 : a.node.key > b.node.key ? 1 : 0);
  const contPick = pickFromBestNode(cands.filter((c) => fresh(c) && forP(c)), continueOrder, balance, chosen);
  let contSlot: Suggestion | "earn" | undefined;
  if (contPick.cand) {
    const c = contPick.cand;
    const reasons = [nodeReason(c, progress)];
    const trig = triggerOf(edges, graph, c.scene.id);
    if (trig) reasons.push(`uses the "${trig}" trigger installed earlier`);
    else if (performerId !== undefined) reasons.push(`next ${topicLabel(c.node.topic)} scene for this performer`);
    contSlot = toSuggestion("continue", c, reasons);
  } else if (contPick.blocked) {
    blocked = { ...contPick.blocked, balance };
    contSlot = "earn";
  }
  const chronologyWait =
    performerId !== undefined ? chronologyReason(every, chrono, graph, progress, performerId, continueOrder) : undefined;

  // explore: a topic the performer has not completed anything in
  const doneTopics = completedTopics(graph, performerId);
  const unexplored = cands.filter((c) => fresh(c) && !doneTopics.has(c.node.topic));
  const mine = unexplored.filter(forP);
  const explorePool = mine.some((c) => !chosen.has(c.scene.id)) ? mine : unexplored;
  const exploreOrder = (a: Candidate, b: Candidate) =>
    gateLast(a) - gateLast(b) ||
    a.node.level - b.node.level ||
    compareScenes(a.scene, b.scene) ||
    (a.node.key < b.node.key ? -1 : a.node.key > b.node.key ? 1 : 0);
  const explPick = pickFromBestNode(explorePool, exploreOrder, balance, chosen, forP);
  let explSlot: Suggestion | "earn" | undefined;
  if (explPick.cand) {
    const c = explPick.cand;
    const topic = topicLabel(c.node.topic);
    const first =
      performerId !== undefined && hasPerformer(c.scene, performerId)
        ? `first ${topic} scene for this performer`
        : performerId === undefined
          ? `first ${topic} scene`
          : `explores ${topic}`;
    explSlot = toSuggestion("explore", c, [first, nodeReason(c, progress)]);
  } else if (explPick.blocked) {
    if (!blocked) blocked = { ...explPick.blocked, balance };
    explSlot = "earn";
  }

  // earn: affordable clip (repeats allowed) with the best effort × estimated coins
  let earn: Suggestion | undefined;
  const wantEarn = contSlot === "earn" || explSlot === "earn" || balance < LOW_BALANCE;
  if (wantEarn) {
    let best: { c: Candidate; score: number } | undefined;
    for (const c of cands) {
      if (c.state === "gate" || chosen.has(c.scene.id) || !affordable(c, balance)) continue;
      const score = effortScore(c.scene, policyOf(c.scene)) * earnOf(c.scene);
      if (
        !best ||
        score > best.score ||
        (score === best.score &&
          ((forP(c) ? 0 : 1) - (forP(best.c) ? 0 : 1) ||
            c.scene.completions - best.c.scene.completions ||
            (c.state === "open" ? 0 : 1) - (best.c.state === "open" ? 0 : 1) ||
            compareScenes(c.scene, best.c.scene)) < 0)
      ) {
        best = { c, score };
      }
    }
    if (best) {
      const c = best.c;
      const s = c.scene;
      const reasons = [`earns about ${earnOf(s)} coins`];
      const effort: string[] = [];
      const pc = promptCount(s);
      if (pc > 0) effort.push(`${pc} prompt${pc === 1 ? "" : "s"}`);
      if (s.interactive || policyOf(s).rules.includes("track")) effort.push("interactive");
      if (effort.length > 0) reasons.push(`high effort: ${effort.join(", ")}`);
      if (s.completions > 0) reasons.push(`repeat, reward ×${repeatFactor(s.completions)}`);
      if (blocked) reasons.push(`toward ${describeNode(blocked.node)} (needs ${blocked.cost}, you have ${balance})`);
      else if (balance < LOW_BALANCE) reasons.push(`your balance is low (${balance})`);
      earn = toSuggestion("earn", c, reasons);
    }
  }

  const options: Suggestion[] = [];
  let earnUsed = false;
  const push = (slot: Suggestion | "earn" | undefined) => {
    if (slot === undefined) return;
    if (slot === "earn") {
      if (earn && !earnUsed) {
        options.push(earn);
        earnUsed = true;
      }
    } else options.push(slot);
  };
  push(contSlot);
  if (!earnUsed && earn && balance < LOW_BALANCE && contSlot !== undefined) push("earn");
  push(explSlot);
  if (!earnUsed && earn) push("earn");

  const result: SuggestionResult = {
    options: options.slice(0, max),
    switches: performerSwitches(cands, graph, balance, performerId),
  };
  if (performerId !== undefined) result.performerId = performerId;
  if (blocked) result.blocked = blocked;
  if (chronologyWait) result.chronology = chronologyWait;
  return result;
}

/** Does the scene count for an open or complete node, or for no node at all (outside the tree)? */
function inReachedNode(graph: Graph, progress: Progress, sceneId: Id): boolean {
  const nodes = graph.sceneNodes.get(sceneId) ?? [];
  return nodes.length === 0 || nodes.some((k) => {
    const st = progress.get(k)?.state;
    return st === "open" || st === "complete";
  });
}

/**
 * When the performer's best continue clip, ranked without chronology (and
 * without affordability), is held back by performer chronology: which
 * performer it waits for and that performer's next clips in line. Locked when
 * none of those counts for an open or complete node.
 */
function chronologyReason(
  every: Candidate[],
  chrono: Chronology,
  graph: Graph,
  progress: Progress,
  performerId: Id,
  continueOrder: (a: Candidate, b: Candidate) => number,
): ChronologyWait | undefined {
  const pool = every.filter((c) => fresh(c) && c.scene.performerIds.includes(performerId));
  if (pool.length === 0) return undefined;
  pool.sort((a, b) => continueOrder(a, b) || compareScenes(a.scene, b.scene));
  const best = pool[0];
  if (best.inLine) return undefined;
  const blockers = chrono.blockers(best.scene.id);
  const who = blockers.includes(performerId) ? performerId : blockers[0];
  if (who === undefined) return undefined;
  const next = chrono.nextInLine(who);
  return {
    sceneId: best.scene.id,
    performerId: who,
    nextSceneIds: next.map((s) => s.id),
    locked: !next.some((s) => inReachedNode(graph, progress, s.id)),
  };
}

/**
 * Other performers with open, affordable, new scenes they can watch now
 * (chronology: next in line for every performer of the clip, or undated),
 * ranked by the number of topics shared with the current performer's open
 * nodes, then by count, then id.
 */
function performerSwitches(cands: Candidate[], graph: Graph, balance: number, current: Id | undefined): PerformerSwitch[] {
  const open = cands.filter((c) => fresh(c) && c.state === "open" && affordable(c, balance));
  const currentTopics = new Set<string>();
  if (current !== undefined) for (const c of open) if (c.scene.performerIds.includes(current)) currentTopics.add(c.node.topic);
  const per = new Map<Id, { scenes: Set<Id>; topics: Set<string> }>();
  for (const c of open) {
    for (const p of c.scene.performerIds) {
      if (p === current) continue;
      let e = per.get(p);
      if (!e) per.set(p, (e = { scenes: new Set(), topics: new Set() }));
      e.scenes.add(c.scene.id);
      e.topics.add(c.node.topic);
    }
  }
  const order = new Map(graph.topics.map((t, i) => [t, i]));
  const out: PerformerSwitch[] = [];
  for (const [performerId, e] of per) {
    const sharedTopics = [...e.topics]
      .filter((t) => currentTopics.has(t))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    out.push({ performerId, sharedTopics, openScenes: e.scenes.size });
  }
  out.sort(
    (a, b) =>
      b.sharedTopics.length - a.sharedTopics.length || b.openScenes - a.openScenes || compareIds(a.performerId, b.performerId),
  );
  return out;
}

export interface StartPerformer {
  performerId: Id;
  /** new, affordable scenes in open entry-level (level 0) nodes */
  entryScenes: number;
  topics: string[];
  firstDate?: string;
}

/**
 * Start screen: performers with new, affordable scenes in open level-0
 * nodes that chronology lets them watch now (next in line for every
 * performer of the clip, or undated); most entry scenes first, then most
 * topics, earliest date, id.
 */
export function startPerformers(input: Omit<SuggestInput, "performerId" | "max">): StartPerformer[] {
  const balance = input.ledger.balance;
  const entry = allCandidates(input, chronology(input.library)).filter(
    (c) => c.inLine && fresh(c) && c.state === "open" && c.node.level === 0 && affordable(c, balance),
  );
  const per = new Map<Id, Candidate[]>();
  for (const c of entry) {
    for (const p of c.scene.performerIds) {
      const list = per.get(p);
      if (list) list.push(c);
      else per.set(p, [c]);
    }
  }
  const order = new Map(input.graph.topics.map((t, i) => [t, i]));
  const out: StartPerformer[] = [];
  for (const [performerId, list] of per) {
    const topics = [...new Set(list.map((c) => c.node.topic))].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const item: StartPerformer = { performerId, entryScenes: distinctScenes(list).length, topics };
    const d = earliestDate(list.map((c) => c.scene));
    if (d !== undefined) item.firstDate = d;
    out.push(item);
  }
  out.sort((a, b) => {
    if (b.entryScenes !== a.entryScenes) return b.entryScenes - a.entryScenes;
    if (b.topics.length !== a.topics.length) return b.topics.length - a.topics.length;
    if (a.firstDate !== b.firstDate) {
      if (!a.firstDate) return 1;
      if (!b.firstDate) return -1;
      return a.firstDate < b.firstDate ? -1 : 1;
    }
    return compareIds(a.performerId, b.performerId);
  });
  return out;
}

// --- daily series cards ------------------------------------------------------------------

export interface DailySeriesCard {
  series: SeriesInput;
  status: SeriesStatus;
  /** coins the next part's spend prompts ask for */
  spendCost: number;
  /** same rule as suggestions: the spend cost fits the balance */
  affordable: boolean;
}

const CARD_ORDER: Record<SeriesStatus["state"], number> = {
  due: 0,
  broken: 1,
  "not-started": 2,
  "done-today": 3,
  finished: 4,
};

/**
 * A series part is reachable when the tree lets it be played: it counts for
 * no node at all (a series outside the tree), or for at least one node that
 * is open or complete, every trigger it uses has been installed, and it is
 * next in line for each of its performers (chronology over graph.scenes).
 */
export function seriesPartReachable(graph: Graph, progress: Progress, edges: TriggerEdge[], sceneId: Id): boolean {
  return chronology(graph).allowed(sceneId) && treeReaches(graph, progress, triggerAllowed(graph, edges), sceneId);
}

function treeReaches(graph: Graph, progress: Progress, triggerOk: (id: Id) => boolean, sceneId: Id): boolean {
  if (!triggerOk(sceneId)) return false;
  const nodes = graph.sceneNodes.get(sceneId) ?? [];
  if (nodes.length === 0) return true;
  return nodes.some((k) => progress.get(k)?.state !== "locked");
}

/**
 * One card per daily series that has a next part (everything but finished),
 * due first, then broken, not started, done for today; then by name. Series
 * whose next part is not next in line for each of its performers
 * (chronology over library.scenes) are left out; given the graph, so are
 * series whose next part the tree does not reach yet, like any other clip
 * behind the fog.
 */
export function dailySeriesCards(input: {
  library: LibraryInput;
  ledger: Ledger;
  now?: Date;
  dayStartHour?: number;
  reach?: { graph: Graph; progress: Progress; edges: TriggerEdge[] };
}): DailySeriesCard[] {
  const series = input.library.series ?? [];
  if (series.length === 0) return [];
  const scenes = new Map<Id, SceneInput>(input.library.scenes.map((s) => [s.id, s]));
  const now = input.now ?? new Date();
  const chrono = chronology(input.library);
  const reach = input.reach;
  const triggerOk = reach ? triggerAllowed(reach.graph, reach.edges) : undefined;
  const out: DailySeriesCard[] = [];
  for (const s of series) {
    const status = seriesStatus(s, scenes, now, input.dayStartHour);
    if (status.state === "finished" || !status.nextPart) continue;
    const scene = scenes.get(status.nextPart.sceneId);
    if (!scene || !chrono.allowed(scene.id)) continue;
    if (reach && triggerOk && !treeReaches(reach.graph, reach.progress, triggerOk, scene.id)) continue;
    const cost = spendCost(scene);
    out.push({ series: s, status, spendCost: cost, affordable: cost <= input.ledger.balance });
  }
  out.sort(
    (a, b) =>
      CARD_ORDER[a.status.state] - CARD_ORDER[b.status.state] ||
      a.series.name.localeCompare(b.series.name) ||
      compareIds(a.series.groupId, b.series.groupId),
  );
  return out;
}
