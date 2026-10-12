// Browser perception adapters for prompts (phase 4): MediaPipe on the video
// person and the viewer's webcam, Vosk speech-to-text, camera/mic access.
// The heavy libraries and models are loaded lazily from the plugin assets
// (see assets.ts, tools/fetch_models.sh); importing this module is cheap.

export * from "./assets.ts";
export * from "./errors.ts";
export * from "./headPose.ts";
export * from "./loader.ts";
export * from "./personFrame.ts";
export * from "./speech.ts";
export * from "./speechResult.ts";
export * from "./time.ts";
export * from "./viewer.ts";
export * from "./viewerFrame.ts";
export * from "./vision.ts";
export * from "./webcam.ts";
