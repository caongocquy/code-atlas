import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error dependency-free JavaScript tooling
import { compareReports } from "../scripts/compare-ca01-tests.mjs";

const identity = { file: "test/phase0-incremental.test.ts", line: 1, column: 1707, nesting: 0,
  name: "incremental sync handles unchanged, one changed importer impact, deletion, and deterministic output" };
const graph = (ids = ["a", "b"]) => ({ nodes: [
  { id: ids[0], type: "file", name: "a.ts", file: "a.ts" },
  { id: ids[1], type: "file", name: "b.ts", file: "b.ts" },
], edges: [{ from: ids[0], to: ids[1], type: "imports", confidence: 1 }] });
function failure(value = graph()) {
  return { name: "AssertionError", code: "ERR_ASSERTION", operator: "strictEqual", generatedMessage: true,
    actual: JSON.stringify(value), expected: JSON.stringify(graph()),
    message: "Expected values to be strictly equal:\nrendered diff", stack: "AssertionError: Expected values to be strictly equal:\nrendered diff\n    at fixture (test.ts:92:14)" };
}
function events(error: unknown, file = identity.file) {
  return [{ type: "test:fail", identity: { ...identity, file }, skip: false, todo: false, error },
    ...Object.entries({ tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 }).map(([key, value]) => ({ type: "test:diagnostic", message: `${key} ${value}` }))];
}
const locations = { baseline: { root: "/base", tempRoot: "/tmp" }, candidate: { root: "/candidate", tempRoot: "/tmp" } };
const compare = (a: unknown, b: unknown, file?: string) => compareReports(events(a, file), events(b, file), locations);
test("graph assertion accepts UUID and serialization permutations and retains evidence", () => {
  const a = failure(), b = failure(graph(["x", "y"]));
  b.expected = JSON.stringify(graph(["x", "y"]));
  const reordered = graph(["x", "y"]); reordered.nodes.reverse();
  b.actual = JSON.stringify(reordered); b.message += " different presentation";
  assert.equal(compare(a, b).differentialPass, true);
  assert.equal(a.actual, JSON.stringify(graph()));
});
for (const [name, mutate] of Object.entries({
  node: (g: ReturnType<typeof graph>) => { g.nodes[0]!.name = "changed"; },
  edge: (g: ReturnType<typeof graph>) => { g.edges[0]!.type = "calls"; },
  attribute: (g: ReturnType<typeof graph>) => { g.edges[0]!.confidence = 0; },
  duplicate: (g: ReturnType<typeof graph>) => { g.nodes[1]!.id = g.nodes[0]!.id; },
  reference: (g: ReturnType<typeof graph>) => { g.edges[0]!.to = "missing"; },
  missing: (g: ReturnType<typeof graph>) => { g.nodes.pop(); },
})) test(`graph assertion rejects ${name}`, () => {
  const g = graph(); mutate(g);
  assert.equal(compare(failure(), failure(g)).differentialPass, false);
});
test("graph assertion rejects missing evidence and preserves non-graph comparisons", () => {
  assert.throws(() => compare({}, {}), /evidence/);
  assert.equal(compare(failure(), { ...failure(), expected: "missing" }).differentialPass, false);
  assert.equal(compare(failure(), failure(graph(["x", "y"])), "test/other.test.ts").differentialPass, false);
  assert.equal(compare(failure(), { ...failure(), stack: failure().stack.replace("92", "93") }).differentialPass, false);
  assert.equal(compare(failure(), { ...failure(), stack: "Expected values to be strictly equal: truncated" }).differentialPass, false);
});
test("graph assertion handles edge order and rejects valid semantic deletion", () => {
  const g = graph(); g.edges.push({ from: "b", to: "a", type: "imports", confidence: 1 });
  const a = failure(g), b = failure({ ...g, edges: [...g.edges].reverse() });
  assert.equal(compare(a, b).differentialPass, true);
  assert.equal(compare(a, failure({ nodes: [g.nodes[0]!], edges: [] })).differentialPass, false);
});
test("graph assertion rejects unsupported UUID attributes", () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const g = graph(ids);
  const a = failure({ ...g, edges: [{ ...g.edges[0]!, evidenceNode: ids[0] }] } as ReturnType<typeof graph>);
  const b = failure({ ...g, edges: [{ ...g.edges[0]!, evidenceNode: ids[1] }] } as ReturnType<typeof graph>);
  assert.equal(compare(a, b).differentialPass, false);
});
