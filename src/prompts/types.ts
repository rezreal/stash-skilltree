// Contract for phase 4 (prompts): checking prompt markers - repeat after me,
// webcam actions, gaze targets on the person in the video. Shared by
// src/prompts (pure checkers + runner) and src/perception (browser adapters:
// MediaPipe, Vosk, getUserMedia), and the player that wires them together.

import type { Id, MarkerInput } from "../core/types.ts";
import type { ViewportPoint } from "../gaze/types.ts";
import type { PromptResult } from "../play/types.ts";

export type PromptCheck = "repeat" | "gaze" | "action" | "spend";

export const GAZE_TARGETS = [
  "eyes",
  "face",
  "mouth",
  "hands",
  "chest",
  "torso",
  "hips",
  "groin",
  "legs",
  "feet_floor",
  "screen_center",
  "off_screen",
  // no region: the viewer keeps the eyes closed (tracker presence without
  // gaze, or webcam blink blendshapes; see gazeCheck.ts)
  "eyes_closed",
] as const;
export type GazeTarget = (typeof GAZE_TARGETS)[number];

export const PROMPT_ACTIONS = [
  "nod",
  "shake_head",
  "eyes_closed",
  "eyes_open",
  "hand_raised",
  "still",
  // body pose of the viewer (ViewerFrame.pose)
  "arms_up",
  "hands_on_head",
  "hands_together",
  "kneel",
  "stand",
  "lie_down",
] as const;
export type PromptAction = (typeof PROMPT_ACTIONS)[number];

/** A prompt marker resolved for checking. */
export interface PromptSpec {
  markerId: Id;
  check: PromptCheck;
  /** video seconds */
  start: number;
  end: number;
  /** repeat: phrase to say; spend: amount as text */
  title: string;
  target?: GazeTarget;
  action?: PromptAction;
  /**
   * gaze: seconds the gaze must hold on the target (default 2; eyes_closed:
   * at most 1.5). Windows longer than 10 s are scored by share instead
   * (gazeCheck.ts); there it is the least time on target.
   */
  holdSec: number;
}

export type PromptPhase = "upcoming" | "active" | "passed" | "failed" | "replaying";

export interface PromptProgress {
  spec: PromptSpec;
  phase: PromptPhase;
  /** 0..1 how far towards passing (hold time, phrase match, ...) */
  progress: number;
  /** replays used so far (max 1) */
  replays: number;
  detail?: string;
  /** long gaze windows: share of the evidence time on target (see CheckResult.share) */
  share?: number;
}

// --- perception inputs ----------------------------------------------------------
// Coordinates are normalized to the source frame: (0,0) top-left, (1,1)
// bottom-right of the VIDEO frame (for the video person) or the WEBCAM frame
// (for the viewer).

export interface NormPoint {
  x: number;
  y: number;
  /** model visibility/presence 0..1 when available */
  visibility?: number;
}

/** MediaPipe pose landmark indices (33-point BlazePose model) used here. */
export const POSE = {
  nose: 0,
  leftEye: 2,
  rightEye: 5,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

/** One analysed frame of the person in the video. */
export interface PersonFrame {
  /** video seconds the frame was taken at */
  videoTime: number;
  /** people found, largest first; each a 33-point pose (may be empty) */
  poses: NormPoint[][];
  /** face boxes (normalized) with eye centres when found, largest first */
  faces: { box: { x: number; y: number; w: number; h: number }; leftEye?: NormPoint; rightEye?: NormPoint; mouth?: NormPoint }[];
  /** hands (21-point landmarks), any person */
  hands: NormPoint[][];
}

/** One analysed webcam frame of the viewer. */
export interface ViewerFrame {
  /** ms, performance.now() timebase */
  t: number;
  facePresent: boolean;
  /** a face OR a body pose was detected */
  personPresent: boolean;
  /** 33-point BlazePose landmarks of the viewer, normalized to the webcam frame, with visibility */
  pose?: NormPoint[];
  /** webcam frame width / height, to measure pose angles undistorted (default 4/3) */
  aspect?: number;
  /** 0..1 from face blendshapes (eyeBlinkLeft/Right) */
  eyeBlinkLeft?: number;
  eyeBlinkRight?: number;
  /** head rotation in degrees from the face transformation matrix */
  yaw?: number;
  pitch?: number;
  roll?: number;
  /** wrists above shoulders etc. */
  handRaised?: boolean;
  /** mean landmark motion since the previous frame, normalized units */
  motion?: number;
}

/** Recognised speech from the local recognizer. */
export interface SpeechResult {
  /** ms, performance.now() timebase */
  t: number;
  text: string;
  final: boolean;
}

/** Where the video frame is drawn on the page (viewport CSS px). */
export interface VideoBox {
  /** the element's rect */
  left: number;
  top: number;
  width: number;
  height: number;
  /** intrinsic video size, for object-fit: contain letterboxing */
  videoWidth: number;
  videoHeight: number;
}

/** A target region on the page, viewport CSS px. */
export type Region =
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "polygon"; points: ViewportPoint[] }
  | { kind: "outside"; of: { left: number; top: number; right: number; bottom: number } };

/** Where the video content is actually drawn (viewport CSS px). */
export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

/** State of one checker (gaze, repeat, action). */
export interface CheckResult {
  passed: boolean;
  /** 0..1 towards passing */
  progress: number;
  detail: string;
  /** long (sustained) gaze windows: share 0..1 of the evidence time on target; absent before any evidence */
  share?: number;
}

/** Something the prompt runner asks the player to do. */
export type PromptRequest = { type: "seek"; to: number };

/** What a prompt runner call emitted. */
export interface PromptEvents {
  results: PromptResult[];
  requests: PromptRequest[];
}

export type { MarkerInput, PromptResult };
