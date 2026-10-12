// MediaPipe adapters: landmarks of the person in the video (pose, face,
// hands) and of the viewer on the webcam (face with blendshapes + head pose,
// body pose). Browser-only; the mapping to PersonFrame / ViewerFrame is pure
// (personFrame.ts, viewerFrame.ts).
//
// The library is loaded lazily from the plugin assets (mediapipe/
// vision_bundle.js, global `Vision`); its wasm loader is injected by MediaPipe
// as a same-origin <script>, the wasm and .task models are fetched same-origin
// (connect-src 'self'), and WebAssembly compiles under stash's 'unsafe-eval'.
// No workers are created.
//
// detectForVideo takes the <video> element directly (ImageSource =
// TexImageSource); stash streams are same-origin so the frame upload isn't
// tainted. No canvas needed.

import type * as MP from "@mediapipe/tasks-vision";
import type { PersonFrame, ViewerFrame } from "../prompts/types.ts";
import { ASSETS, assetUrl } from "./assets.ts";
import { PerceptionError } from "./errors.ts";
import { loadScriptGlobal } from "./loader.ts";
import { mapPersonFrame } from "./personFrame.ts";
import type { PersonResults } from "./personFrame.ts";
import { createMonotonic } from "./time.ts";
import { createViewerFrameMapper } from "./viewerFrame.ts";

export type Delegate = "GPU" | "CPU";
type VisionLib = typeof MP;

export interface VisionOptions {
  /** preferred delegate (default GPU); falls back to CPU when GPU init fails */
  delegate?: Delegate;
  /**
   * pose model for the person in the VIDEO (default "full": people in clips
   * are often small, partly turned or lying down, and region targets like
   * hips/feet need the better keypoints; at ~10 Hz the cost is fine). The
   * webcam always uses "lite" (one person close to the camera).
   */
  personPoseModel?: "lite" | "full";
  /** stash base URL override (default: from <base href>) */
  baseUrl?: string;
}

/** Which models to run for one analyze() call (default all that were created). */
export interface PersonParts {
  pose?: boolean;
  face?: boolean;
  hands?: boolean;
}

export interface PersonAnalyzer {
  /**
   * Analyses the current video frame. Throttle in the caller (~10 Hz).
   * Returns null when the video has no frame yet or detection failed (see
   * lastError). Parts switched off in `only` come back as empty lists.
   */
  analyze(videoTime: number, nowMs: number, only?: PersonParts): PersonFrame | null;
  readonly delegates: { pose?: Delegate; face?: Delegate; hands?: Delegate };
  readonly lastError: unknown;
  dispose(): void;
}

export interface ViewerAnalyzerOptions {
  /** a <video> to play the stream in (e.g. a visible preview); default a detached one */
  video?: HTMLVideoElement;
}

export interface ViewerAnalyzer {
  /** the element the webcam stream plays in */
  readonly video: HTMLVideoElement;
  /** Analyses the current webcam frame; null before the first frame or on failure. */
  analyze(nowMs: number): ViewerFrame | null;
  readonly delegates: { face?: Delegate; pose?: Delegate };
  readonly lastError: unknown;
  /** Closes the models and detaches the stream. Does NOT stop the stream's tracks. */
  dispose(): void;
}

export interface Vision {
  readonly lib: VisionLib;
  personAnalyzer(video: HTMLVideoElement, parts?: PersonParts): Promise<PersonAnalyzer>;
  viewerAnalyzer(stream: MediaStream, opts?: ViewerAnalyzerOptions): Promise<ViewerAnalyzer>;
  /** closes every analyzer created from this instance */
  dispose(): void;
}

/** Loads the MediaPipe bundle from the plugin assets (once). */
export function loadVisionLib(baseUrl?: string): Promise<VisionLib> {
  return loadScriptGlobal<VisionLib>(assetUrl(ASSETS.visionBundle, baseUrl), "Vision");
}

function hasFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
}

interface Closable {
  close(): void;
}

function closeAll(tasks: (Closable | undefined)[]): void {
  for (const t of tasks) {
    try {
      t?.close();
    } catch {
      // already closed
    }
  }
}

export async function createVision(opts: VisionOptions = {}): Promise<Vision> {
  const lib = await loadVisionLib(opts.baseUrl);
  let fileset: Awaited<ReturnType<VisionLib["FilesetResolver"]["forVisionTasks"]>>;
  try {
    // no trailing slash: MediaPipe appends "/vision_wasm_internal.js"
    fileset = await lib.FilesetResolver.forVisionTasks(assetUrl(ASSETS.visionWasm, opts.baseUrl));
  } catch (err) {
    throw new PerceptionError("model-failed", `MediaPipe wasm could not be prepared: ${String(err)}`, err);
  }
  const model = (path: string): string => assetUrl(path, opts.baseUrl);
  let preferGpu = (opts.delegate ?? "GPU") === "GPU";
  const live = new Set<{ dispose(): void }>();

  /** Creates a task on the GPU, falling back to the CPU (and staying there). */
  async function create<T>(name: string, make: (delegate: Delegate) => Promise<T>): Promise<{ task: T; delegate: Delegate }> {
    if (preferGpu) {
      try {
        return { task: await make("GPU"), delegate: "GPU" };
      } catch (err) {
        console.warn(`[skilltree] ${name}: GPU delegate failed, using CPU`, err);
        preferGpu = false;
      }
    }
    try {
      return { task: await make("CPU"), delegate: "CPU" };
    } catch (err) {
      throw new PerceptionError("model-failed", `MediaPipe ${name} could not be created: ${String(err)}`, err);
    }
  }

  const pose = (path: string, numPoses: number) => (delegate: Delegate) =>
    lib.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: model(path), delegate },
      runningMode: "VIDEO",
      numPoses,
    });

  async function settle<T extends Record<string, Promise<{ task: Closable; delegate: Delegate }> | undefined>>(
    jobs: T,
  ): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
    const keys = Object.keys(jobs) as (keyof T)[];
    const results = await Promise.allSettled(keys.map((k) => jobs[k] ?? Promise.resolve(undefined)));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      closeAll(results.map((r) => (r.status === "fulfilled" ? r.value?.task : undefined)));
      throw (failed as PromiseRejectedResult).reason;
    }
    const out = {} as { [K in keyof T]: Awaited<T[K]> };
    keys.forEach((k, i) => {
      out[k] = (results[i] as PromiseFulfilledResult<Awaited<T[typeof k]>>).value;
    });
    return out;
  }

  async function personAnalyzer(video: HTMLVideoElement, parts: PersonParts = {}): Promise<PersonAnalyzer> {
    const want = { pose: parts.pose !== false, face: parts.face !== false, hands: parts.hands !== false };
    const poseModel = (opts.personPoseModel ?? "full") === "lite" ? ASSETS.poseLiteModel : ASSETS.poseFullModel;
    const t = await settle({
      pose: want.pose ? create("pose", pose(poseModel, 2)) : undefined,
      face: want.face
        ? create("face", (delegate) =>
            lib.FaceLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: model(ASSETS.faceModel), delegate },
              runningMode: "VIDEO",
              numFaces: 2,
            }),
          )
        : undefined,
      hands: want.hands
        ? create("hands", (delegate) =>
            lib.HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: model(ASSETS.handModel), delegate },
              runningMode: "VIDEO",
              numHands: 4,
            }),
          )
        : undefined,
    });
    const ts = createMonotonic();
    let lastError: unknown;
    let disposed = false;
    const analyzer: PersonAnalyzer = {
      delegates: { pose: t.pose?.delegate, face: t.face?.delegate, hands: t.hands?.delegate },
      get lastError() {
        return lastError;
      },
      analyze(videoTime, nowMs, only = {}) {
        if (disposed || !hasFrame(video)) return null;
        const stamp = ts(nowMs);
        const r: PersonResults = {};
        try {
          if (t.pose && only.pose !== false) r.poses = t.pose.task.detectForVideo(video, stamp).landmarks;
          if (t.face && only.face !== false) r.faces = t.face.task.detectForVideo(video, stamp).faceLandmarks;
          if (t.hands && only.hands !== false) r.hands = t.hands.task.detectForVideo(video, stamp).landmarks;
        } catch (err) {
          lastError = err;
          return null;
        }
        lastError = undefined;
        return mapPersonFrame(videoTime, r);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        live.delete(analyzer);
        closeAll([t.pose?.task, t.face?.task, t.hands?.task]);
      },
    };
    live.add(analyzer);
    return analyzer;
  }

  async function viewerAnalyzer(stream: MediaStream, vopts: ViewerAnalyzerOptions = {}): Promise<ViewerAnalyzer> {
    const t = await settle({
      face: create("viewer face", (delegate) =>
        lib.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: model(ASSETS.faceModel), delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        }),
      ),
      pose: create("viewer pose", pose(ASSETS.poseLiteModel, 1)),
    });
    const video = vopts.video ?? document.createElement("video");
    try {
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      closeAll([t.face.task, t.pose.task]);
      video.srcObject = null;
      throw new PerceptionError("device-busy", `The webcam stream could not be played: ${String(err)}`, err);
    }
    const ts = createMonotonic();
    const mapper = createViewerFrameMapper();
    let lastError: unknown;
    let disposed = false;
    const analyzer: ViewerAnalyzer = {
      video,
      delegates: { face: t.face.delegate, pose: t.pose.delegate },
      get lastError() {
        return lastError;
      },
      analyze(nowMs) {
        if (disposed || !hasFrame(video)) return null;
        const stamp = ts(nowMs);
        try {
          const f = t.face.task.detectForVideo(video, stamp);
          const p = t.pose.task.detectForVideo(video, stamp);
          lastError = undefined;
          return mapper.map(nowMs, {
            faces: f.faceLandmarks,
            blendshapes: f.faceBlendshapes,
            matrices: f.facialTransformationMatrixes,
            poses: p.landmarks,
            aspect: video.videoWidth / video.videoHeight,
          });
        } catch (err) {
          lastError = err;
          return null;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        live.delete(analyzer);
        closeAll([t.face.task, t.pose.task]);
        try {
          video.pause();
        } catch {
          // ignore
        }
        video.srcObject = null;
      },
    };
    live.add(analyzer);
    return analyzer;
  }

  return {
    lib,
    personAnalyzer,
    viewerAnalyzer,
    dispose() {
      for (const a of [...live]) a.dispose();
    },
  };
}
