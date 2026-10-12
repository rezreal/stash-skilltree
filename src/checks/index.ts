// Live checks of a viewing session (phase 4 wiring): webcam presence, the
// camera gate, prompt checks (repeat / gaze / action) on the video clock,
// the prompt banner and sensor rows. The session controller uses:
//   const viewer = useViewerPresence({ enabled: cameraWanted });
//   adjustAttention: presenceAdjuster(() => viewer, settings.webcamRequired)
//   const checks = usePromptChecks({ scene, enabled, getVideoTime, getVideo,
//     viewer, onResult: s.reportPrompt, onSeek: s.seek });
//   const regions = useGazeRegions({ enabled, getVideoTime, getVideo, counting });
//     (usePromptChecks({ ..., onPersonFrame: regions.feedPerson }))
//   beforeEnd: checks.finish
//   <CameraGate onReady={...} />, <PromptBanner checks={checks} />,
//   <ChecksSensorRows viewer={viewer} status={checks.status} />

export * from "./settings.ts";
export * from "./attention.ts";
export * from "./adjust.ts";
export * from "./wording.ts";
export * from "./schedule.ts";
export * from "./gate.ts";
export * from "./camera.ts";
export * from "./useViewerPresence.ts";
export * from "./usePromptChecks.ts";
export * from "./useGazeRegions.ts";
export * from "./PromptBanner.tsx";
export * from "./CameraGate.tsx";
export * from "./MicGate.tsx";
export * from "./ChecksSensorRows.tsx";
