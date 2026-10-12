import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The worklet is plain JS for the audio thread: run its source with stand-ins
// for AudioWorkletProcessor / registerProcessor. postMessage transfers like
// the browser does, so the posted buffer is detached afterwards.
const SRC = readFileSync(fileURLToPath(new URL("../../src/perception/speech-worklet.js", import.meta.url)), "utf8");

interface Tap {
  process(inputs: Float32Array[][]): boolean;
  port: { onmessage: ((e: { data: unknown }) => void) | null };
}

function loadTap(chunkSize: number): { tap: Tap; posted: Float32Array[] } {
  const posted: Float32Array[] = [];
  class Processor {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(data: Float32Array, transfer?: ArrayBuffer[]) {
        posted.push(structuredClone(data, { transfer: transfer ?? [] }));
        if (posted.length > 1000) throw new Error("runaway: the tap keeps posting");
      },
    };
  }
  let Ctor: (new (opts: unknown) => Tap) | undefined;
  const register = (_name: string, c: new (opts: unknown) => Tap) => {
    Ctor = c;
  };
  new Function("AudioWorkletProcessor", "registerProcessor", SRC)(Processor, register);
  return { tap: new Ctor!({ processorOptions: { chunkSize } }), posted };
}

const quantum = (start: number) => Float32Array.from({ length: 128 }, (_, i) => start + i);

describe("speech worklet tap", () => {
  it("posts full chunks of chunkSize, again and again (the buffer is transferred)", () => {
    const { tap, posted } = loadTap(256);
    for (let q = 0; q < 10; q++) assert.equal(tap.process([[quantum(q * 128)]]), true);
    assert.equal(posted.length, 5);
    for (const [i, chunk] of posted.entries()) {
      assert.equal(chunk.length, 256);
      assert.equal(chunk[0], i * 256);
      assert.equal(chunk[255], i * 256 + 255);
    }
  });

  it("stops on 'stop'", () => {
    const { tap } = loadTap(256);
    tap.port.onmessage!({ data: "stop" });
    assert.equal(tap.process([[quantum(0)]]), false);
  });
});
