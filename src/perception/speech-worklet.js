// AudioWorklet processor for local speech recognition (src/perception/speech.ts).
// Batches the mono mic input into Float32 chunks (default 4096 samples, ~85 ms
// at 48 kHz) and posts them to the main thread, which hands them to the Vosk
// worker. Runs on the audio thread, so a busy main thread (MediaPipe, video)
// doesn't drop audio the way a ScriptProcessorNode does.
//
// Plain JS on purpose: it is not bundled but served as a file from the plugin
// assets (tools/fetch_models.sh copies it to plugin/assets/vosk/), because
// stash's CSP has no blob:/data: in script-src, which worklet modules need.
/* global AudioWorkletProcessor, registerProcessor */

class SkilltreeSpeechTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.chunkSize) || 4096;
    // kept apart from buf: posting transfers buf.buffer, which detaches buf
    // (its length reads 0 afterwards)
    this.size = Math.max(1, Math.floor(size));
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.running = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const k = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + k), this.n);
        this.n += k;
        i += k;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return this.running;
  }
}

registerProcessor("skilltree-speech-tap", SkilltreeSpeechTap);
