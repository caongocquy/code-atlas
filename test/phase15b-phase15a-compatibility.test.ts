import assert from "node:assert/strict";
import test from "node:test";

import { validateContextSubject } from "../src/core/context/context-identity.js";
import { compileTaskContext } from "../src/core/context/task-context-compiler.js";

test("every emitted v1 subject is accepted directly by the Phase15A subject boundary", async () => {
  const plan = await compileTaskContext({ task: "subjects" }, {
    repositoryPath: "/repo",
    repositoryIdentity: "repo",
    workspaceIdentity: "workspace",
    collect: async () => ({ candidates: [
      { subject: { kind: "file", path: "src/app.ts" }, evidence: [{ kind: "explicit_anchor", anchor: { kind: "file", path: "src/app.ts" } }], sourceRanks: {}, exact: true },
      { subject: { kind: "symbol", path: "src/app.ts", symbolId: "fn:main", selectorVersion: "1" }, evidence: [{ kind: "task_exact_resolution", query: "main", resolution: "symbol" }], sourceRanks: {}, exact: true },
    ], reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] } }),
  });

  assert.deepEqual(plan.items.map((item) => validateContextSubject(item.subject)), plan.items.map((item) => item.subject));
});
