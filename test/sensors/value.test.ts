import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  asciiPreview,
  candidateDecodings,
  canonicalUuid,
  hexBytes,
  isValueFormat,
  normalizeUuid,
  parseAsciiNumber,
  parseValue,
  rankDecodings,
  shortUuid,
  VALUE_FORMATS,
} from "../../src/sensors/value.ts";

const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);
const text = (s: string) => dv([...s].map((c) => c.charCodeAt(0)));

describe("parseValue", () => {
  it("decodes every binary format at an offset", () => {
    const b = dv([0xaa, 0x34, 0x12, 0x00, 0x00]);
    assert.equal(parseValue(b, "uint8", 1), 0x34);
    assert.equal(parseValue(b, "uint16le", 1), 0x1234);
    assert.equal(parseValue(b, "uint16be", 1), 0x3412);
    assert.equal(parseValue(b, "uint32le", 1), 0x1234);
    assert.equal(parseValue(dv([0xfe, 0xff]), "int16le"), -2);
    assert.equal(parseValue(dv([0xfe, 0xff]), "uint16le"), 65534);
    const f = new DataView(new ArrayBuffer(6));
    f.setFloat32(2, 123.5, true);
    assert.equal(parseValue(f, "float32le", 2), 123.5);
  });

  it("applies the scale", () => {
    assert.equal(parseValue(dv([0xe8, 0x03]), "uint16le", 0, 0.1), 100);
    assert.equal(parseValue(dv([10]), "uint8", 0, 2), 20);
    // a broken scale is ignored, not NaN
    assert.equal(parseValue(dv([10]), "uint8", 0, Number.NaN), 10);
  });

  it("is undefined when the notification is too short or the offset is bad", () => {
    assert.equal(parseValue(dv([1]), "uint16le"), undefined);
    assert.equal(parseValue(dv([1, 2, 3]), "uint32le"), undefined);
    assert.equal(parseValue(dv([1, 2]), "uint8", 2), undefined);
    assert.equal(parseValue(dv([1, 2]), "uint8", -1), undefined);
    assert.equal(parseValue(dv([1, 2]), "uint8", 0.5), undefined);
    assert.equal(parseValue(dv([]), "ascii"), undefined);
  });

  it("rejects NaN floats", () => {
    const f = new DataView(new ArrayBuffer(4));
    f.setFloat32(0, Number.NaN, true);
    assert.equal(parseValue(f, "float32le"), undefined);
  });

  it("reads ascii numbers", () => {
    assert.equal(parseValue(text("123\n"), "ascii"), 123);
    assert.equal(parseValue(text("123\r\n"), "ascii"), 123);
    assert.equal(parseValue(text("d=45.5mm"), "ascii"), 45.5);
    assert.equal(parseValue(text("12,5"), "ascii"), 12.5);
    assert.equal(parseValue(text("-7"), "ascii"), -7);
    assert.equal(parseValue(text("R0123"), "ascii", 1), 123);
    assert.equal(parseValue(text("abc"), "ascii"), undefined);
    assert.equal(parseValue(text("250"), "ascii", 0, 0.1), 25);
    // stops at a NUL terminator
    assert.equal(parseValue(dv([0x34, 0x32, 0, 0x39]), "ascii"), 42);
    assert.equal(parseAsciiNumber("  88 "), 88);
  });

  it("knows its formats", () => {
    for (const f of VALUE_FORMATS) assert.ok(isValueFormat(f));
    assert.ok(!isValueFormat("int8"));
    assert.ok(!isValueFormat(3));
  });
});

describe("UUIDs", () => {
  it("normalizes aliases, full UUIDs and names", () => {
    assert.equal(normalizeUuid("0x181a"), 0x181a);
    assert.equal(normalizeUuid("181A"), 0x181a);
    assert.equal(normalizeUuid(" 0xFFE0 "), 0xffe0);
    assert.equal(normalizeUuid("0000ffe1"), 0xffe1);
    assert.equal(normalizeUuid("6E400001-B5A3-F393-E0A9-E50E24DCCA9E"), "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    assert.equal(normalizeUuid("environmental_sensing"), "environmental_sensing");
    assert.equal(normalizeUuid(0x2a00), 0x2a00);
    assert.equal(normalizeUuid(""), undefined);
    assert.equal(normalizeUuid("xyz-1"), undefined);
    assert.equal(normalizeUuid("0x18"), undefined);
    assert.equal(normalizeUuid(undefined), undefined);
  });

  it("converts between short and canonical forms", () => {
    assert.equal(canonicalUuid(0xffe0), "0000ffe0-0000-1000-8000-00805f9b34fb");
    assert.equal(shortUuid("0000ffe0-0000-1000-8000-00805f9b34fb"), "0xffe0");
    assert.equal(shortUuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e"), "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
  });
});

describe("raw bytes and candidate decodings", () => {
  it("formats bytes as hex and ascii", () => {
    assert.equal(hexBytes(dv([0, 15, 255])), "00 0f ff");
    assert.equal(asciiPreview(text("12\n")), "12\\n");
    assert.equal(asciiPreview(dv([0x41, 0x01])), "A.");
  });

  it("lists every format/offset that decodes", () => {
    const c = candidateDecodings([dv([1, 2, 3])]);
    const keys = c.map((d) => `${d.format}@${d.offset}`);
    assert.ok(keys.includes("uint8@0") && keys.includes("uint8@2"));
    assert.ok(keys.includes("uint16le@1"));
    assert.ok(!keys.includes("uint16le@2"));
    assert.ok(!keys.some((k) => k.startsWith("uint32le")));
    assert.ok(!keys.some((k) => k.startsWith("ascii"))); // no digits
  });

  it("ranks a changing little-endian distance first", () => {
    // header byte 0x01, then uint16le distance 120, 180, 240 mm
    const samples = [dv([1, 120, 0]), dv([1, 180, 0]), dv([1, 240, 0])];
    const best = rankDecodings(samples)[0]!;
    assert.equal(best.format, "uint16le");
    assert.equal(best.offset, 1);
    assert.deepEqual(best.values, [120, 180, 240]);
  });

  it("ranks ascii text sensors first", () => {
    const best = rankDecodings([text("101\n"), text("140\n"), text("99\n")])[0]!;
    assert.equal(best.format, "ascii");
    assert.deepEqual(best.values, [101, 140, 99]);
  });

  it("marks decodings that fail on some samples as implausible", () => {
    const r = rankDecodings([dv([1, 2]), dv([1])]);
    const u16 = r.find((d) => d.format === "uint16le" && d.offset === 0)!;
    assert.equal(u16.score, 0);
  });
});
