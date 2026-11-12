// Per-viewer conveniences kept in localStorage. Every access is guarded:
// private windows and blocked storage simply mean nothing is remembered.
import { parseStrokeCalibration, type StrokeCalibration } from "../prompts/stroke.ts";

const PERFORMER_KEY = "skilltree.play.performer";
export const CALIBRATION_KEY = "skilltree.calibration";
const SHOW_GAZE_KEY = "skilltree.play.showGaze";
const TEST_MODE_KEY = "skilltree.play.testMode";
const SHOW_CAMERA_KEY = "skilltree.play.showCamera";
export const STROKE_CALIBRATION_KEY = "skilltree.strokeCalibration";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

export function loadCurrentPerformer(store: StorageLike | undefined = storage()): string | undefined {
  try {
    const v = store?.getItem(PERFORMER_KEY);
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveCurrentPerformer(id: string | undefined, store: StorageLike | undefined = storage()): void {
  try {
    if (id) store?.setItem(PERFORMER_KEY, id);
    else store?.removeItem(PERFORMER_KEY);
  } catch {
    // not remembered; the choice still holds for this page view
  }
}

/** the stored gaze calibration as text (serializeCalibration), undefined when none */
export function loadCalibrationText(store: StorageLike | undefined = storage()): string | undefined {
  try {
    const v = store?.getItem(CALIBRATION_KEY);
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

/** stores the calibration text; undefined removes it (identity). false when storage is blocked. */
export function saveCalibrationText(text: string | undefined, store: StorageLike | undefined = storage()): boolean {
  try {
    if (!store) return false;
    if (text) store.setItem(CALIBRATION_KEY, text);
    else store.removeItem(CALIBRATION_KEY);
    return true;
  } catch {
    return false;
  }
}

/** the "Show gaze" toggle of the player; off by default */
export function loadShowGaze(store: StorageLike | undefined = storage()): boolean {
  try {
    return store?.getItem(SHOW_GAZE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowGaze(on: boolean, store: StorageLike | undefined = storage()): void {
  try {
    if (on) store?.setItem(SHOW_GAZE_KEY, "1");
    else store?.removeItem(SHOW_GAZE_KEY);
  } catch {
    // not remembered
  }
}

/** the choice screen's "Test mode" toggle; off by default */
export function loadTestMode(store: StorageLike | undefined = storage()): boolean {
  try {
    return store?.getItem(TEST_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTestMode(on: boolean, store: StorageLike | undefined = storage()): void {
  try {
    if (on) store?.setItem(TEST_MODE_KEY, "1");
    else store?.removeItem(TEST_MODE_KEY);
  } catch {
    // not remembered; the toggle still holds for this page view
  }
}

/** the "Show my camera" toggle of the session (picture-in-picture preview); off by default */
export function loadShowCamera(store: StorageLike | undefined = storage()): boolean {
  try {
    return store?.getItem(SHOW_CAMERA_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowCamera(on: boolean, store: StorageLike | undefined = storage()): void {
  try {
    if (on) store?.setItem(SHOW_CAMERA_KEY, "1");
    else store?.removeItem(SHOW_CAMERA_KEY);
  } catch {
    // not remembered
  }
}

/** the stroke-camera calibration of this browser (camera angle and room are per device) */
export function loadStrokeCalibration(store: StorageLike | undefined = storage()): StrokeCalibration | undefined {
  try {
    return parseStrokeCalibration(store?.getItem(STROKE_CALIBRATION_KEY) ?? undefined);
  } catch {
    return undefined;
  }
}

/** stores the calibration; undefined removes it. false when storage is blocked. */
export function saveStrokeCalibration(cal: StrokeCalibration | undefined, store: StorageLike | undefined = storage()): boolean {
  try {
    if (!store) return false;
    if (cal) store.setItem(STROKE_CALIBRATION_KEY, JSON.stringify(cal));
    else store.removeItem(STROKE_CALIBRATION_KEY);
    return true;
  } catch {
    return false;
  }
}
