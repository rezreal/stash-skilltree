import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeRequirement,
  formatRequirement,
  nodeKey,
  normalizeTopic,
  parseNodeKey,
  parseRequirement,
} from "../../src/core/index.ts";

test("empty and undefined parse to no requirement", () => {
  assert.deepEqual(parseRequirement(undefined), { req: [], errors: [] });
  assert.deepEqual(parseRequirement(""), { req: [], errors: [] });
  assert.deepEqual(parseRequirement("   "), { req: [], errors: [] });
});

test("AND of OR groups with costs", () => {
  const { req, errors } = parseRequirement("relaxation:1,deepening:2|fixation:2|$80");
  assert.deepEqual(errors, []);
  assert.deepEqual(req, [
    [{ kind: "level", topic: "relaxation", level: 1 }],
    [
      { kind: "level", topic: "deepening", level: 2 },
      { kind: "level", topic: "fixation", level: 2 },
      { kind: "cost", amount: 80 },
    ],
  ]);
});

test("whitespace tolerant and topics normalized", () => {
  const { req, errors } = parseRequirement("  Deep  Trance : 3 | $ 50 ,  Eye_Fix-2 :0 ");
  assert.deepEqual(errors, []);
  assert.deepEqual(req, [
    [
      { kind: "level", topic: "deep trance", level: 3 },
      { kind: "cost", amount: 50 },
    ],
    [{ kind: "level", topic: "eye_fix-2", level: 0 }],
  ]);
});

test("invalid alternatives are dropped and reported, empty groups dropped", () => {
  const { req, errors } = parseRequirement("a:1|b:x, $0, c, :2, d:-1, e:1.5, $abc, f:1:2, g!:1, h:2");
  assert.deepEqual(req, [[{ kind: "level", topic: "a", level: 1 }], [{ kind: "level", topic: "h", level: 2 }]]);
  assert.equal(errors.length, 9);
  for (const e of errors) assert.equal(typeof e, "string");
});

test("empty tokens are ignored silently", () => {
  const { req, errors } = parseRequirement("a:1,,|b:2|, ");
  assert.deepEqual(errors, []);
  assert.deepEqual(req, [[{ kind: "level", topic: "a", level: 1 }], [{ kind: "level", topic: "b", level: 2 }]]);
});

test("unicode letters are allowed in topics", () => {
  const { req, errors } = parseRequirement("Entspännung:1");
  assert.deepEqual(errors, []);
  assert.deepEqual(req, [[{ kind: "level", topic: "entspännung", level: 1 }]]);
});

test("format is canonical and round-trips", () => {
  const src = " Relaxation : 1 ,deepening:2 | fixation:2|$80";
  const { req } = parseRequirement(src);
  const canon = formatRequirement(req);
  assert.equal(canon, "relaxation:1,deepening:2|fixation:2|$80");
  assert.deepEqual(parseRequirement(canon).req, req);
  assert.equal(formatRequirement([]), "");
});

test("describe in plain English", () => {
  assert.equal(
    describeRequirement(parseRequirement("relaxation:1,deepening:2|fixation:2").req),
    "relaxation L1 and (deepening L2 or fixation L2)",
  );
  assert.equal(describeRequirement(parseRequirement("a:0|$80").req), "a L0 or pay 80");
  assert.equal(describeRequirement(parseRequirement("$80").req), "pay 80");
  assert.equal(describeRequirement([]), "no requirements");
});

test("key helpers", () => {
  assert.equal(normalizeTopic("  Deep   Trance "), "deep trance");
  assert.equal(nodeKey(" Fixation", 2), "fixation:2");
  assert.deepEqual(parseNodeKey("deep trance:3"), { topic: "deep trance", level: 3 });
  assert.equal(parseNodeKey("nope"), undefined);
});
