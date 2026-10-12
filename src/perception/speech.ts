// Local speech-to-text with Vosk (vosk-browser): for repeat-after-me prompts.
// Browser-only; grammar building and result mapping are pure (speechResult.ts).
//
// Loading: vosk-browser's UMD build (global `Vosk`) comes from the plugin
// assets. It creates its Web Worker from a blob: URL (the worker source,
// including the wasm as a data: URI, is inlined as base64), which stash's CSP
// allows (worker-src blob:). The worker inherits the page CSP: it fetches the
// model archive same-origin (connect-src 'self'), compiles wasm under
// 'unsafe-eval', and caches the extracted model in IndexedDB keyed by the
// model URL (so the first start downloads ~40 MB, later ones don't). The
// model URL must be absolute: the worker resolves relative URLs against the
// origin root, not stash's <base href>.
//
// Audio: mic -> AudioWorklet (speech-worklet.js from the assets) -> main
// thread -> recognizer.acceptWaveformFloat -> worker. Falls back to a
// ScriptProcessorNode when the worklet can't be loaded.
//
// Echo: the clip itself says the phrase first, then the viewer repeats it.
// We ask for echoCancellation + noiseSuppression, but browser echo
// cancellation is not reliable with speakers: headphones are recommended.
// Callers must also ignore results before the prompt window opens (the
// window starts at the marker, after the instruction) - results carry
// performance.now() timestamps for that.

import type * as VoskLib from "vosk-browser";
import type { SpeechResult } from "../prompts/types.ts";
import { ASSETS, assetUrl } from "./assets.ts";
import { PerceptionError } from "./errors.ts";
import { loadScriptGlobal } from "./loader.ts";
import { createPartialDeduper, grammarJson, mapVoskMessage } from "./speechResult.ts";
import type { VoskMessageLike } from "./speechResult.ts";
import { getMedia, stopStream } from "./webcam.ts";

type VoskModule = typeof VoskLib;
type Recognizer = VoskLib.KaldiRecognizer;

export interface SpeechOptions {
  /** limit recognition to these phrases (Vosk runtime grammar); default free-form */
  grammar?: string[];
  /** AudioContext sample rate to ask for (default: the device's); Vosk resamples either way */
  sampleRate?: number;
  /** microphone deviceId */
  deviceId?: string;
  /** also deliver partial (non-final) results (default true) */
  partials?: boolean;
  /** vosk log level (-2 error .. 3 debug; default -1) */
  logLevel?: number;
  /** model download + load timeout (default 180 s) */
  loadTimeoutMs?: number;
  baseUrl?: string;
}

export type SpeechState = "idle" | "loading" | "ready" | "listening" | "error" | "disposed";

export interface Speech {
  readonly state: SpeechState;
  /** Loads vosk and the model without opening the mic (optional; start() does it too). */
  load(): Promise<void>;
  /** Opens the mic and starts recognizing. Call from a user gesture if possible (AudioContext autoplay rules). */
  start(): Promise<void>;
  /** Flushes the pending utterance as a final result, closes the mic (indicator off). The model stays loaded. */
  stop(): void;
  /** Switches the phrase list (null = free-form). Takes effect immediately, also while listening. */
  setGrammar(phrases: string[] | null): void;
  onResult(cb: (r: SpeechResult) => void): () => void;
  onError(cb: (e: PerceptionError) => void): () => void;
  /** Stops and frees the model worker. */
  dispose(): void;
}

/** Loads the vosk-browser bundle from the plugin assets (once). */
export function loadVoskLib(baseUrl?: string): Promise<VoskModule> {
  return loadScriptGlobal<VoskModule>(assetUrl(ASSETS.voskBundle, baseUrl), "Vosk");
}

function loadModel(Vosk: VoskModule, url: string, logLevel: number, timeoutMs: number): Promise<VoskLib.Model> {
  const model = new Vosk.Model(url, logLevel);
  return new Promise((resolve, reject) => {
    const fail = (msg: string): void => {
      clearTimeout(timer);
      terminateModel(model);
      reject(new PerceptionError("model-failed", msg));
    };
    const timer = setTimeout(() => fail(`The speech model did not load within ${Math.round(timeoutMs / 1000)} s (${url}).`), timeoutMs);
    model.on("load", (m) => {
      if (m.event !== "load") return;
      if (m.result) {
        clearTimeout(timer);
        resolve(model);
      } else fail(`The speech model failed to load from ${url}. Run tools/fetch_models.sh.`);
    });
    model.on("error", (m) => {
      if (m.event === "error") fail(`Speech model error: ${m.error}`);
    });
  });
}

function terminateModel(model: VoskLib.Model): void {
  try {
    model.terminate();
  } catch {
    // ignore
  }
  // terminate() only asks the worker to close itself; make sure it's gone
  const w = (model as unknown as { worker?: { terminate?: () => void } }).worker;
  try {
    w?.terminate?.();
  } catch {
    // ignore
  }
}

interface AudioChain {
  ctx: AudioContext;
  stream: MediaStream;
  nodes: AudioNode[];
  worklet?: AudioWorkletNode;
}

export function createSpeech(opts: SpeechOptions = {}): Speech {
  let state: SpeechState = "idle";
  let grammar = grammarJson(opts.grammar);
  let model: VoskLib.Model | undefined;
  let loading: Promise<void> | undefined;
  let rec: Recognizer | undefined;
  let recGrammar: string | undefined;
  let recRate = 0;
  let audio: AudioChain | undefined;
  let startSeq = 0;
  const resultCbs = new Set<(r: SpeechResult) => void>();
  const errorCbs = new Set<(e: PerceptionError) => void>();
  const isNews = createPartialDeduper();
  const wantPartials = opts.partials !== false;

  const emitError = (e: PerceptionError): void => {
    for (const cb of errorCbs) cb(e);
  };

  function load(): Promise<void> {
    if (state === "disposed") return Promise.reject(new PerceptionError("model-failed", "speech was disposed"));
    if (model) return Promise.resolve();
    if (!loading) {
      if (state === "idle" || state === "error") state = "loading";
      loading = (async () => {
        const Vosk = await loadVoskLib(opts.baseUrl);
        const m = await loadModel(Vosk, assetUrl(ASSETS.voskModel, opts.baseUrl), opts.logLevel ?? -1, opts.loadTimeoutMs ?? 180_000);
        if ((state as SpeechState) === "disposed") {
          terminateModel(m);
          return;
        }
        model = m;
        if ((state as SpeechState) === "loading") state = "ready";
      })();
      loading.catch((err) => {
        loading = undefined;
        if (state !== "disposed") state = "error";
        emitError(err instanceof PerceptionError ? err : new PerceptionError("model-failed", String(err), err));
      });
    }
    return loading;
  }

  function removeRecognizer(): void {
    if (!rec) return;
    try {
      rec.remove();
    } catch {
      // ignore
    }
    rec = undefined;
  }

  /** Creates (or keeps) the recognizer for the current grammar and sample rate. */
  function ensureRecognizer(sampleRate: number): void {
    if (!model) return;
    if (rec && recGrammar === grammar && recRate === sampleRate) return;
    removeRecognizer();
    const r = grammar ? new model.KaldiRecognizer(sampleRate, grammar) : new model.KaldiRecognizer(sampleRate);
    const handle = (msg: VoskMessageLike): void => {
      if (r !== rec) return;
      if (msg.event === "error") {
        emitError(new PerceptionError("model-failed", `Speech recognizer: ${String((msg as { error?: unknown }).error)}`));
        return;
      }
      const res = mapVoskMessage(msg, performance.now());
      if (!res || (!res.final && !wantPartials) || !isNews(res)) return;
      for (const cb of resultCbs) cb(res);
    };
    r.on("result", (m) => handle(m));
    r.on("partialresult", (m) => handle(m));
    r.on("error", (m) => handle(m));
    rec = r;
    recGrammar = grammar;
    recRate = sampleRate;
  }

  function feed(chunk: Float32Array): void {
    if (!rec || !audio || state !== "listening") return;
    try {
      rec.acceptWaveformFloat(chunk, audio.ctx.sampleRate);
    } catch (err) {
      emitError(new PerceptionError("model-failed", `acceptWaveform failed: ${String(err)}`, err));
    }
  }

  async function openAudio(): Promise<AudioChain> {
    const audioC: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (opts.deviceId) audioC.deviceId = { exact: opts.deviceId };
    const stream = await getMedia({ audio: audioC, video: false }, "microphone");
    let ctx: AudioContext | undefined;
    try {
      let source: MediaStreamAudioSourceNode;
      try {
        ctx = new AudioContext(opts.sampleRate ? { sampleRate: opts.sampleRate } : undefined);
        source = ctx.createMediaStreamSource(stream);
      } catch (err) {
        // Firefox can't connect a mic to a context with another sample rate
        if (!opts.sampleRate) throw err;
        await ctx?.close().catch(() => undefined);
        ctx = new AudioContext();
        source = ctx.createMediaStreamSource(stream);
      }
      const chain: AudioChain = { ctx, stream, nodes: [source] };
      let tap: AudioNode | undefined;
      if (ctx.audioWorklet) {
        try {
          await ctx.audioWorklet.addModule(assetUrl(ASSETS.speechWorklet, opts.baseUrl));
          const node = new AudioWorkletNode(ctx, "skilltree-speech-tap", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { chunkSize: 4096 },
          });
          node.port.onmessage = (e: MessageEvent) => {
            if (e.data instanceof Float32Array && e.data.length > 0) feed(e.data);
          };
          chain.worklet = node;
          tap = node;
        } catch (err) {
          console.warn("[skilltree] speech AudioWorklet unavailable, falling back to ScriptProcessor", err);
        }
      }
      if (!tap) {
        // deprecated but universally supported; runs on the main thread
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = (e: AudioProcessingEvent) => {
          // copy: the buffer is reused by the browser and the recognizer transfers it
          feed(new Float32Array(e.inputBuffer.getChannelData(0)));
        };
        tap = sp;
      }
      source.connect(tap);
      // the tap outputs silence; connecting it keeps it processing in every browser
      tap.connect(ctx.destination);
      chain.nodes.push(tap);
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      return chain;
    } catch (err) {
      stopStream(stream);
      await ctx?.close().catch(() => undefined);
      throw err instanceof PerceptionError ? err : new PerceptionError("device-busy", `Audio setup failed: ${String(err)}`, err);
    }
  }

  function closeAudio(): void {
    const a = audio;
    audio = undefined;
    if (!a) return;
    try {
      a.worklet?.port.postMessage("stop");
      if (a.worklet) a.worklet.port.onmessage = null;
    } catch {
      // ignore
    }
    for (const n of a.nodes) {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    }
    stopStream(a.stream);
    a.ctx.close().catch(() => undefined);
  }

  const speech: Speech = {
    get state() {
      return state;
    },
    load,
    async start() {
      if (state === "disposed") throw new PerceptionError("model-failed", "speech was disposed");
      if (state === "listening") return;
      const seq = ++startSeq;
      await load();
      if (seq !== startSeq || (state as SpeechState) === "disposed") return;
      const chain = await openAudio();
      if (seq !== startSeq || (state as SpeechState) === "disposed") {
        audio = chain;
        closeAudio();
        return;
      }
      audio = chain;
      ensureRecognizer(chain.ctx.sampleRate);
      state = "listening";
    },
    stop() {
      startSeq++;
      if (state !== "listening") return;
      try {
        rec?.retrieveFinalResult();
      } catch {
        // ignore
      }
      closeAudio();
      state = "ready";
    },
    setGrammar(phrases) {
      grammar = grammarJson(phrases);
      if (state === "listening" && audio) ensureRecognizer(audio.ctx.sampleRate);
    },
    onResult(cb) {
      resultCbs.add(cb);
      return () => resultCbs.delete(cb);
    },
    onError(cb) {
      errorCbs.add(cb);
      return () => errorCbs.delete(cb);
    },
    dispose() {
      if (state === "disposed") return;
      speech.stop();
      state = "disposed";
      removeRecognizer();
      if (model) terminateModel(model);
      model = undefined;
      resultCbs.clear();
      errorCbs.clear();
    },
  };
  return speech;
}
