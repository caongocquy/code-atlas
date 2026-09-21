import assert from "node:assert/strict";
import test from "node:test";

import { compileTaskContext } from "../src/core/context/task-context-compiler.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";

test("compiler returns deterministic compact plans without delivery calls", async () => {
  const candidate: TaskContextCandidate = {
    subject: { kind: "file", path: "src/app.ts" },
    evidence: [{ kind: "explicit_changed_path", path: "src/app.ts" }],
    sourceRanks: {},
    exact: true,
    estimatedTokens: 4,
  };
  const deps = {
    repositoryPath: "/repo",
    repositoryIdentity: "repo-1",
    workspaceIdentity: "workspace-1",
    collect: async () => ({ candidates: [candidate], reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] } }),
  };

  const first = await compileTaskContext({ task: "update app", changedPaths: ["src/app.ts"] }, deps);
  const second = await compileTaskContext({ task: " update app ", changedPaths: ["src/app.ts"] }, deps);
  assert.equal(first.taskIdentity, second.taskIdentity);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.subject.kind, "file");
  assert.equal(first.projection.detail, "compact");
});

test("full projection caps evidence and omitted candidates", async () => {
  const candidates = [
    { subject: { kind: "file" as const, path: "src/required.ts" }, evidence: [{ kind: "explicit_changed_path" as const, path: "src/required.ts" }], sourceRanks: {}, exact: true },
    ...Array.from({ length: 25 }, (_, index) => ({ subject: { kind: "file" as const, path: `src/optional-${index}.ts` }, evidence: Array.from({ length: 10 }, (_, rank) => ({ kind: "lexical" as const, query: `${index}-${rank}`, rank: rank + 1 })), sourceRanks: {}, exact: true })),
  ];
  const plan = await compileTaskContext({ task: "required", changedPaths: ["src/required.ts"], detail: "full", budget: { maxItems: 1, maxEstimatedTokens: 1 } }, { repositoryPath: "/repo", repositoryIdentity: "repo", workspaceIdentity: "workspace", collect: async () => ({ candidates, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] } }) });
  assert.equal(plan.fullItems?.every((item) => item.evidence.length <= 8), true);
  assert.equal(plan.projection.omitted, 20);
  assert.equal(plan.projection.truncated, true);
});
