import assert from "node:assert/strict";
import test from "node:test";

import { enrichTaskContextGraph } from "../src/core/context/task-context-candidates.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";
import type { CodeGraph } from "../src/core/graph/types.js";

test("graph enrichment is one-hop and capped per required seed", () => {
  const seed: TaskContextCandidate = { subject: { kind: "symbol", path: "src/a.ts", symbolId: "a", selectorVersion: "1" }, evidence: [{ kind: "explicit_anchor", anchor: { kind: "symbol", path: "src/a.ts", name: "a" } }], sourceRanks: {}, exact: true };
  const graph: CodeGraph = { nodes: [
    { id: "a", type: "function", name: "a", file: "src/a.ts" },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `b${index}`, type: "function" as const, name: `b${index}`, file: `src/b${index}.ts` })),
    { id: "c", type: "function", name: "c", file: "src/c.ts" },
  ], edges: [
    ...Array.from({ length: 6 }, (_, index) => ({ from: "a", to: `b${index}`, type: "calls" as const })),
    { from: "b0", to: "c", type: "calls" as const },
  ] };
  const result = enrichTaskContextGraph([seed], graph);
  assert.equal(result.filter((candidate) => candidate.subject?.symbolId?.startsWith("b")).length, 5);
  assert.equal(result.some((candidate) => candidate.subject?.symbolId === "c"), false);
  assert.equal(result.find((candidate) => candidate.subject?.symbolId === "b0")?.exact, true);
});
