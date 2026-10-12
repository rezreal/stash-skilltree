// Shared contract between src/core (pure logic), src/stash (data loading)
// and src/ui. Keep this file free of runtime code other than constants.

export type Id = string;

/** `${topic}:${level}` */
export type NodeKey = string;

// --- requirements ---------------------------------------------------------

export type Alternative =
  | { kind: "level"; topic: string; level: number }
  | { kind: "cost"; amount: number };

/** AND over groups, OR inside a group. Empty = no requirement. */
export type Requirement = Alternative[][];

// --- input: what src/stash produces from the server -----------------------

export interface InterestTagInput {
  id: Id;
  name: string;
  topic: string;
  level: number;
  /** completed scenes needed to complete this level (st.need) */
  need?: number;
  /** raw st.requires string */
  requires?: string;
  /** st.paid: coins paid to open this node (bought) */
  paid?: number;
}

export interface TriggerTagInput {
  id: Id;
  name: string;
  trigger: string;
  role: "installed" | "used";
}

export interface MarkerInput {
  id: Id;
  title: string;
  seconds: number;
  endSeconds?: number;
  /** st.check of the primary tag, if it is a prompt tag */
  check?: "repeat" | "gaze" | "action" | "spend" | "mail";
  target?: string;
  action?: string;
  /**
   * replay a missed prompt (true) or only count it at the end (false), from
   * a marker tag with st.kind=replay; unset = by window length (runner.ts)
   */
  replay?: boolean;
}

export interface SceneInput {
  id: Id;
  title: string;
  /** YYYY-MM-DD or undefined */
  date?: string;
  durationSec: number;
  performerIds: Id[];
  tagIds: Id[];
  interactive: boolean;
  completedAt?: string;
  completions: number;
  earned: number;
  spent: number;
  /** st.exposure_seconds: loop listening time stored so far */
  exposureSec?: number;
  markers: MarkerInput[];
}

export interface PerformerInput {
  id: Id;
  name: string;
  /** the performer's custom fields (st.gaze_regions, see play/gazeRegions.ts); absent when empty */
  customFields?: Record<string, unknown>;
}

export type SeriesReset = "start" | "step_back";

/** One part of a series: a scene of the group and its scene_index. */
export interface SeriesPartInput {
  sceneId: Id;
  /** scene_index inside the group; missing when stash has none */
  index?: number;
}

/**
 * A stash group with st.series (only "daily" for now). Parts are in watch
 * order: scene_index ascending, ties and parts without an index by scene
 * date, then id (see orderedParts in src/play/series.ts).
 */
export interface SeriesInput {
  groupId: Id;
  name: string;
  mode: "daily";
  /** st.reset: what a missed day does (default "start") */
  reset: SeriesReset;
  parts: SeriesPartInput[];
}

/** A tag or a series group whose st.* fields could not be parsed. */
export type MalformedInput =
  | { tagId: Id; tagName: string; problem: string }
  | { groupId: Id; groupName: string; problem: string };

export interface LibraryInput {
  interestTags: InterestTagInput[];
  triggerTags: TriggerTagInput[];
  /** every scene of the tree plus every part of a series */
  scenes: SceneInput[];
  performers: PerformerInput[];
  /** groups configured as daily series */
  series: SeriesInput[];
  /** tags and series groups whose st.* fields could not be parsed */
  malformed: MalformedInput[];
}

// --- graph ------------------------------------------------------------------

export interface GraphNode {
  key: NodeKey;
  topic: string;
  level: number;
  tagIds: Id[];
  /** explicit st.requires plus the implicit previous level */
  requires: Requirement;
  /** explicit part only, for display */
  explicitRequires: Requirement;
  need: number;
  /** st.need as written on the tag(s) (max), before defaulting and capping */
  rawNeed?: number;
  sceneIds: Id[];
  paid: number;
  /** every scene of this node has a spend prompt */
  toll?: { amount: number };
}

export interface Graph {
  nodes: Map<NodeKey, GraphNode>;
  /** topic ids in display order */
  topics: string[];
  scenes: Map<Id, SceneInput>;
  performers: Map<Id, PerformerInput>;
  /** scene id -> node keys it counts for */
  sceneNodes: Map<Id, NodeKey[]>;
  /** problems found while building (bad requirement strings etc.) */
  buildIssues: LintIssue[];
}

// --- progress, fog, layout, lint ------------------------------------------

export type NodeState = "locked" | "open" | "complete";

export interface NodeProgress {
  state: NodeState;
  completed: number;
  need: number;
}

/** progress per node; optional performer filter only changes counts */
export type Progress = Map<NodeKey, NodeProgress>;

export type Visibility = "shown" | "ahead" | "gate" | "hidden";

/**
 * Position of one node in the organic tree layout. Coordinates are in SVG
 * user units (y grows downwards); the virtual START node sits at (0, 0).
 */
export interface LayoutNode {
  key: NodeKey;
  x: number;
  y: number;
  /** requirement depth: 0 = entry node, 1 + deepest prerequisite otherwise */
  depth: number;
}

export interface LayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Layout {
  nodes: Map<NodeKey, LayoutNode>;
  /** nodes hanging off the virtual START node (entry nodes), sorted */
  entries: NodeKey[];
  /** bounding box of every node centre and START */
  bounds: LayoutBounds;
  maxDepth: number;
}

export type Severity = "error" | "warning" | "info";

export interface LintIssue {
  severity: Severity;
  code: string;
  message: string;
  node?: NodeKey;
  tagId?: Id;
  sceneId?: Id;
  groupId?: Id;
}

export const DEFAULT_NEED = 2;
