import assert from "node:assert/strict";
import test from "node:test";

import { compileTaskContext } from "../src/core/context/task-context-compiler.js";

test("task identity stays stable across budget and capability inputs", async () => {
  const deps = { repositoryPath: "/repo", repositoryIdentity: "repo", workspaceIdentity: "workspace", capabilityFingerprint: "generation-a", collect: async () => ({ candidates: [], reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] } }) };
  const first = await compileTaskContext({ task: "same", budget: { maxItems: 1 } }, deps);
  const second = await compileTaskContext({ task: "same", budget: { maxItems: 10 }, detail: "full" }, { ...deps, capabilityFingerprint: "generation-b" });
  assert.equal(first.taskIdentity, second.taskIdentity);
  assert.notEqual(first.planIdentity, second.planIdentity);
});
