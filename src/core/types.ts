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
  check?: "repeat" | "gaze" | "action" | "spend";
  target?: string;
  action?: string;
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
  markers: MarkerInput[];
}

export interface PerformerInput {
  id: Id;
  name: string;
}

export interface LibraryInput {
  interestTags: InterestTagInput[];
  triggerTags: TriggerTagInput[];
  scenes: SceneInput[];
  performers: PerformerInput[];
  /** tags whose st.* fields could not be parsed */
  malformed: { tagId: Id; tagName: string; problem: string }[];
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

export interface LayoutNode {
  key: NodeKey;
  /** graph depth, ring index */
  ring: number;
  /** degrees, 0 = right, clockwise, -90 = top */
  angle: number;
}

export interface Layout {
  nodes: Map<NodeKey, LayoutNode>;
  topicAngles: Map<string, number>;
  maxRing: number;
}

export type Severity = "error" | "warning" | "info";

export interface LintIssue {
  severity: Severity;
  code: string;
  message: string;
  node?: NodeKey;
  tagId?: Id;
  sceneId?: Id;
}

export const DEFAULT_NEED = 2;
