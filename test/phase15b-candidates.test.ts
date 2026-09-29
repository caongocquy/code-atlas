import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_SUBJECT_SELECTOR_VERSION } from "../src/core/context/context.types.js";
import { canonicalContextSubjectKey } from "../src/core/context/task-context-normalizer.js";
import { mergeTaskContextCandidates } from "../src/core/context/task-context-candidates.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";

const file = (path: string, rank: number): TaskContextCandidate => ({
  subject: { kind: "file", path },
  evidence: [{ kind: "explicit_changed_path", path }],
  sourceRanks: { explicit_changed_path: rank },
  exact: true,
});

test("merges duplicate subjects and accumulates deterministic unique evidence", () => {
  const candidates = mergeTaskContextCandidates([
    file("src/z.ts", 2),
    { ...file("src/z.ts", 1), evidence: [{ kind: "explicit_anchor", anchor: { kind: "file", path: "src/z.ts" } }], sourceRanks: { explicit_anchor: 1 }, exact: false },
    file("src/a.ts", 3),
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.subject?.path), ["src/a.ts", "src/z.ts"]);
  const merged = candidates[1]!;
  assert.equal(merged.exact, true);
  assert.equal(merged.evidence.length, 2);
  assert.deepEqual(merged.evidence.map((item) => item.kind), ["explicit_anchor", "explicit_changed_path"]);
  assert.deepEqual(merged.sourceRanks, { explicit_anchor: 1, explicit_changed_path: 2 });
});

test("dedupes exact symbols by the Phase15A subject identity", () => {
  const subject = { kind: "symbol" as const, path: "src/index.ts", symbolId: "fn:main", selectorVersion: CONTEXT_SUBJECT_SELECTOR_VERSION };
  const candidates = mergeTaskContextCandidates([
    { subject, evidence: [{ kind: "explicit_anchor", anchor: { kind: "symbol", path: subject.path, name: "main" } }], sourceRanks: { explicit_anchor: 1 }, exact: true },
    { subject: { ...subject }, evidence: [{ kind: "task_exact_resolution", query: "main", resolution: "symbol" }], sourceRanks: { task_exact_resolution: 1 }, exact: true },
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(canonicalContextSubjectKey(candidates[0]!.subject!), canonicalContextSubjectKey(subject));
  assert.equal(candidates[0]!.evidence.length, 2);
});

test("keeps unresolved candidates as separate non-exact diagnostics", () => {
  const candidates = mergeTaskContextCandidates([
    { query: "missing", evidence: [{ kind: "diagnostic", message: "not found" } as never], sourceRanks: {}, exact: false },
    { query: "missing", evidence: [{ kind: "diagnostic", message: "ambiguous" } as never], sourceRanks: {}, exact: false },
  ]);

  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => !candidate.subject && !candidate.exact));
});
