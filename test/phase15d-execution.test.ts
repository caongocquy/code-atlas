import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeCase } from "../eval/context/runner/execute-case.js";
import type { EvalCase, EvalExecutionDeps } from "../eval/context/types.js";
import type { PreparedContextAwareRead } from "../src/core/context/context.types.js";
import type { TaskContextPlanDetail } from "../src/core/context/task-context.types.js";

function evalCase(): EvalCase {
  return {
    caseId: "execution-case",
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "exact-target",
    workspaceRef: "synthetic/typescript/execution-case",
    task: "trace context delivery",
    anchors: [{ path: "src/first.ts" }],
    changedPaths: ["src/first.ts"],
    truth: {
      requiredSubjects: [{ kind: "file", path: "src/first.ts" }],
      supportingSubjects: [{ kind: "file", path: "src/second.ts" }],
      forbiddenRequiredSubjects: [],
    },
  };
}

function plan(): TaskContextPlanDetail {
  return {
    taskIdentity: "task-identity",
    planIdentity: "plan-identity",
    repositoryIdentity: "repository-identity",
    workspaceIdentity: "workspace-identity",
    items: [
      { subject: { kind: "file", path: "src/first.ts" }, priority: "required", rank: 1, reasons: ["anchor"], estimatedTokens: 21 },
      { subject: { kind: "file", path: "src/second.ts" }, priority: "supporting", rank: 2, reasons: ["related"], estimatedTokens: 12 },
    ],
    budget: { maxItems: 20, maxEstimatedTokens: 4_000, selectedItems: 2, estimatedTokens: 33, omittedItems: 0, budgetExceeded: false },
    reliability: { mayBeIncomplete: false, capabilityStates: { graph: "ready" }, diagnostics: [] },
    capabilityFingerprint: "capability-fingerprint",
    compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" },
    projection: { detail: "full", detailsAvailable: true, omitted: 0, truncated: false },
  };
}

function prepared(input: { subject: TaskContextPlanDetail["items"][number]["subject"]; mode: "full" | "delta"; content: string; requestedBytes: number; returnedBytes: number }): PreparedContextAwareRead {
  const receipt = {
    receiptId: `receipt-${input.subject.path}`,
    sessionId: "session",
    repositoryIdentity: "repository-identity",
    workspaceIdentity: "workspace-identity",
    subject: input.subject,
    subjectIdentity: `subject-${input.subject.path}`,
    projectionIdentity: "source-v1",
    contextGeneration: "generation",
    deliveryMode: input.mode,
    deliveredContentIdentity: `content-${input.subject.path}`,
    snapshotId: `snapshot-${input.subject.path}`,
    reliability: { mayBeIncomplete: false },
    deliveredAt: "2026-09-14T00:00:00.000Z",
    state: "active" as const,
    schemaVersion: 1,
  };
  return {
    session: { sessionId: "session", repositoryIdentity: receipt.repositoryIdentity, workspaceIdentity: receipt.workspaceIdentity, createdAt: receipt.deliveredAt, lastSeenAt: receipt.deliveredAt, contextGeneration: "generation", schemaVersion: 1 },
    receipt,
    snapshot: { snapshotId: receipt.snapshotId, receiptId: receipt.receiptId, subjectIdentity: receipt.subjectIdentity, projectionIdentity: receipt.projectionIdentity, content: input.content, contentIdentity: receipt.deliveredContentIdentity, createdAt: receipt.deliveredAt, schemaVersion: 1 },
    result: {
      mode: input.mode,
      receipt,
      current: { contentIdentity: receipt.deliveredContentIdentity, reliability: receipt.reliability },
      ...(input.mode === "full" ? { content: input.content } : { delta: { before: "old", after: input.content } }),
    },
    metrics: { requestedBytes: input.requestedBytes, returnedBytes: input.returnedBytes, savedBytes: input.requestedBytes - input.returnedBytes },
  };
}

test("executeCase indexes each independent workspace, compiles the full plan, and observes ordered production deliveries", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-execution-fixture-"));
  const roots: string[] = [];
  const compileInputs: unknown[] = [];
  const prepareCalls: unknown[][] = [];
  try {
    await writeFile(path.join(fixtureRoot, "source.ts"), "export const source = true;\n");
    const deps: EvalExecutionDeps = {
      indexRepository: (async (root, options) => {
        roots.push(root);
        assert.deepEqual(options, { skipGit: true });
        return {};
      }) as EvalExecutionDeps["indexRepository"],
      compileTaskContextForRepository: (async (root, input) => {
        assert.equal(root, roots.at(-1));
        compileInputs.push(input);
        return plan();
      }) as EvalExecutionDeps["compileTaskContextForRepository"],
      prepareContextAwareRead: (async (...args: unknown[]) => {
        prepareCalls.push(args);
        const request = args[1] as { subject: { path: string } };
        return request.subject.path.endsWith("first.ts")
          ? prepared({ subject: request.subject as TaskContextPlanDetail["items"][number]["subject"], mode: "full", content: "first\n", requestedBytes: 10, returnedBytes: 6 })
          : prepared({ subject: request.subject as TaskContextPlanDetail["items"][number]["subject"], mode: "delta", content: "second\n", requestedBytes: 12, returnedBytes: 5 });
      }) as EvalExecutionDeps["prepareContextAwareRead"],
      now: () => "2026-09-14T00:00:00.000Z",
    };

    const first = await executeCase({ evalCase: evalCase(), fixtureRoot }, deps);
    const second = await executeCase({ evalCase: evalCase(), fixtureRoot }, deps);

    assert.equal(roots.length, 2);
    assert.notEqual(roots[0], roots[1]);
    assert.equal(roots.every((root) => root !== process.cwd() && root.startsWith(tmpdir())), true);
    assert.deepEqual(compileInputs, [
      { task: "trace context delivery", anchors: [{ path: "src/first.ts" }], changedPaths: ["src/first.ts"], detail: "full" },
      { task: "trace context delivery", anchors: [{ path: "src/first.ts" }], changedPaths: ["src/first.ts"], detail: "full" },
    ]);
    assert.deepEqual(first.selectedItems.map((item) => [item.subject.path, item.priority, item.rank]), [["src/first.ts", "required", 1], ["src/second.ts", "supporting", 2]]);
    assert.deepEqual(first.deliveries.map((delivery) => [delivery.subject.path, delivery.mode]), [["src/first.ts", "full"], ["src/second.ts", "delta"]]);
    assert.deepEqual(first.reconstructedContents, { "file:src/first.ts": "first\n", "file:src/second.ts": "second\n" });
    assert.deepEqual({ ...first.metrics, timingsMs: undefined }, {
      selectedItems: 2,
      estimatedTokens: 33,
      returnedBytes: 11,
      requiredHitRate: 1,
      supportingHitRate: 1,
      contextPrecision: 1,
      fullItems: 1,
      deltaItems: 1,
      unchangedItems: 0,
      rehydratedItems: 0,
      requestedBytes: 22,
      savedBytes: 11,
      reuseRate: 0.5,
      bodyResendCount: 1,
      timingsMs: undefined,
    });
    assert.equal(first.metrics.timingsMs.indexLoad >= 0, true);
    assert.equal(first.metrics.timingsMs.compile >= 0, true);
    assert.equal(second.caseId, first.caseId);
    assert.equal(prepareCalls.length, 4);
    for (const [root, request, storeOrDeps, storeError] of prepareCalls) {
      assert.equal(root, roots.includes(root as string) ? root : undefined);
      assert.equal((request as { projection: string }).projection, "source-v1");
      assert.equal(typeof (storeOrDeps as { now: unknown }).now, "function");
      assert.ok((storeOrDeps as { store: unknown }).store);
      assert.equal(storeError, undefined);
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
