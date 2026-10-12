// Opening the webcam / microphone with errors the UI can explain.
// getUserMedia only exists in secure contexts: https, or http://localhost.

import { classifyMediaError, unavailableMediaError } from "./errors.ts";
import type { MediaKind } from "./errors.ts";

/** getUserMedia with PerceptionError rejections (see errors.ts for codes). */
export async function getMedia(constraints: MediaStreamConstraints, kind: MediaKind): Promise<MediaStream> {
  const secure = typeof window === "undefined" ? true : window.isSecureContext !== false;
  const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function") throw unavailableMediaError(kind, secure);
  try {
    return await md.getUserMedia(constraints);
  } catch (err) {
    throw classifyMediaError(err, kind, secure);
  }
}

export interface WebcamOptions {
  /** ideal capture width (default 640; height follows the camera's aspect) */
  width?: number;
  deviceId?: string;
}

/** Front camera at ~640 px wide, no audio. */
export function openWebcam(opts: WebcamOptions = {}): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: opts.width ?? 640 },
    frameRate: { ideal: 30, max: 30 },
  };
  if (opts.deviceId) video.deviceId = { exact: opts.deviceId };
  else video.facingMode = "user";
  return getMedia({ video, audio: false }, "camera");
}

/** Stops every track so the camera / mic indicator goes off. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {
      // already stopped
    }
  }
}
