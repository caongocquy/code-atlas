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
