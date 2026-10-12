// Where the perception runtime files live. Everything is served by stash from
// the plugin directory through the manifest's `ui.assets` mapping
// (`/: assets` -> plugin/assets/), filled by tools/fetch_models.sh. Never a CDN.
//
// URLs are resolved against stash's `<base href>` so a reverse-proxy prefix
// (e.g. https://host/stash/) keeps working.

import { stashUrl } from "../stash/client.ts";

export const PLUGIN_ID = "skilltree";

/** Paths below the plugin's asset root (plugin/assets/ on disk). */
export const ASSETS = {
  /** MediaPipe tasks-vision IIFE build (global `Vision`), copied from node_modules */
  visionBundle: "mediapipe/vision_bundle.js",
  /** directory with vision_wasm_internal.{js,wasm} and the nosimd variant */
  visionWasm: "mediapipe/wasm",
  faceModel: "mediapipe/models/face_landmarker.task",
  handModel: "mediapipe/models/hand_landmarker.task",
  poseLiteModel: "mediapipe/models/pose_landmarker_lite.task",
  poseFullModel: "mediapipe/models/pose_landmarker_full.task",
  /** vosk-browser UMD build (global `Vosk`; worker + wasm inlined), copied from node_modules */
  voskBundle: "vosk/vosk.js",
  /**
   * The model archive. vosk-browser caches the extracted model in IndexedDB
   * keyed by this URL, so the file name carries the model version: a new
   * model must get a new name or users keep the old one.
   */
  voskModel: "vosk/vosk-model-small-en-us-0.15.tar.gz",
  /**
   * AudioWorklet that taps the mic (src/perception/speech-worklet.js). Stash
   * serves assets without Cache-Control, so bump ?v= whenever the file
   * changes or browsers keep running the cached copy.
   */
  speechWorklet: "vosk/speech-worklet.js?v=2",
} as const;

/** Absolute URL of the plugin's asset root, with a trailing slash. */
export function assetsRoot(baseUrl?: string): string {
  return stashUrl(`plugin/${PLUGIN_ID}/assets/`, baseUrl);
}

/** Absolute URL of a file below the plugin's asset root. */
export function assetUrl(path: string, baseUrl?: string): string {
  return assetsRoot(baseUrl) + path.replace(/^\/+/, "");
}
