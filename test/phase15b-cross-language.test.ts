import assert from "node:assert/strict";
import test from "node:test";

import { compileTaskContext } from "../src/core/context/task-context-compiler.js";

const fixtures = [
  ["typescript", "src/app.ts", "main"],
  ["python", "src/app.py", "main"],
  ["java", "src/App.java", "main"],
  ["go", "src/app.go", "main"],
] as const;

for (const [language, file, symbol] of fixtures) {
  test(`language-neutral compiler emits Phase15A subjects for ${language}`, async () => {
    const plan = await compileTaskContext({ task: symbol }, { repositoryPath: "/repo", repositoryIdentity: language, workspaceIdentity: `${language}-workspace`, collect: async () => ({ candidates: [{ subject: { kind: "symbol", path: file, symbolId: `${language}:${symbol}`, selectorVersion: "1" }, evidence: [{ kind: "task_exact_resolution", query: symbol, resolution: "symbol" }], sourceRanks: {}, exact: true }], reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] } }) });
    assert.equal(plan.items[0]?.subject.kind, "symbol");
    assert.equal(plan.items[0]?.subject.path, file);
  });
}
