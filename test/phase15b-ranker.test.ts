import assert from "node:assert/strict";
import test from "node:test";

import { rankTaskContextCandidates } from "../src/core/context/task-context-ranker.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";

const candidate = (evidence: TaskContextCandidate["evidence"], exact = true): TaskContextCandidate => ({
  subject: { kind: "symbol", path: "src/app.ts", symbolId: "fn:main", selectorVersion: "1" },
  evidence,
  sourceRanks: Object.fromEntries(evidence.map((item, index) => [item.kind, index + 1])),
  exact,
});

test("only authoritative evidence promotes required priority", () => {
  const [explicit, direct, retrieval] = rankTaskContextCandidates([
    candidate([{ kind: "explicit_anchor", anchor: { kind: "symbol", name: "main" } }]),
    candidate([{ kind: "task_exact_resolution", query: "main", resolution: "symbol" }]),
    candidate([{ kind: "lexical", rank: 1, query: "mai" }], true),
  ]);

  assert.equal(explicit!.priority, "required");
  assert.equal(direct!.priority, "required");
  assert.notEqual(retrieval!.priority, "required");
  assert.equal(retrieval!.subject.kind, "symbol");
});

test("weak and diagnostic evidence remain optional", () => {
  const [item] = rankTaskContextCandidates([candidate([{ kind: "lexical", rank: 4, query: "substring" }], false)]);
  assert.equal(item!.priority, "optional");
});
