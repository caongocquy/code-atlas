import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CONTEXT_AWARE_SOURCE_PROJECTION } from "../src/core/context/context-delivery-preparation.js";
import { refreshTaskContext, startTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import type { TaskContextPlanDetail } from "../src/core/context/task-context.types.js";
import { TaskContextLifecycleDomainError } from "../src/core/context/task-context-lifecycle.types.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/cli.js");

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout;
}

async function cli(cwd: string, ...args: string[]): Promise<Record<string, any>> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(result.stdout) as Record<string, any>;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const wrapped = new Error(`${failure.message ?? "CLI failed"}\nstdout: ${failure.stdout ?? ""}\nstderr: ${failure.stderr ?? ""}`) as Error & { stdout?: string; stderr?: string };
    wrapped.stdout = failure.stdout;
    wrapped.stderr = failure.stderr;
    throw wrapped;
  }
}

function deliveryFor(result: Record<string, any>, subjectPath: string): Record<string, any> {
  const delivery = result.deliveries.find((candidate: Record<string, any>) => candidate.subject?.path === subjectPath);
  assert.ok(delivery, `missing delivery for ${subjectPath}`);
  return delivery;
}

async function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function plan(items: TaskContextPlanDetail["items"]): TaskContextPlanDetail {
  return {
    taskIdentity: "task-v1-smoke",
    planIdentity: "plan-v1-smoke",
    repositoryIdentity: "repo-smoke",
    workspaceIdentity: "workspace-smoke",
    items,
    budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: items.length, estimatedTokens: items.length, omittedItems: 0, budgetExceeded: false },
    reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] },
    capabilityFingerprint: "none",
    compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" },
    projection: { detail: "compact", detailsAvailable: false, omitted: 0, truncated: false },
  };
}

test("real lifecycle smoke preserves exact deliveries across restart and detail modes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-smoke-"));
  try {
    const sourcePath = path.join(root, "source.ts");
    await writeFile(sourcePath, "one\ntwo\n");
    const item = { subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: ["smoke"] };
    const compile = async (_repoPath: string, input: { detail?: "compact" | "full" }) => ({ ...plan([item]), projection: { detail: input.detail ?? "compact", detailsAvailable: input.detail === "full", omitted: 0, truncated: false } });
    const common = { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository: compile };

    const started = await startTaskContext({ task: "read source", detail: "full" }, common);
    const startedDelivery = started.deliveries[0] as unknown as { mode: string; content?: string; delta?: unknown };
    assert.equal(startedDelivery.mode, "full");
    assert.equal(startedDelivery.content, "one\ntwo\n");
    assert.match((started.deliveries[0] as { current: { contentIdentity: string } }).current.contentIdentity, /.+/);
    assert.equal((started.deliveries[0] as { reason: string }).reason, "first_read");

    const restarted = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId, detail: "compact" }, common);
    const unchanged = restarted.deliveries[0] as unknown as { mode: string; content?: string; delta?: unknown };
    assert.equal(unchanged.mode, "unchanged");
    assert.match((restarted.deliveries[0] as { current: { contentIdentity: string } }).current.contentIdentity, /.+/);
    assert.equal("content" in unchanged, false);
    assert.equal("delta" in unchanged, false);

    await writeFile(sourcePath, "one\ntwo\nthree\n");
    const changed = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId, detail: "full" }, common);
    const delta = changed.deliveries[0] as unknown as { mode: string; content?: string; delta?: { operations?: unknown[] } };
    assert.equal(delta.mode, "delta");
    assert.ok(delta.delta);
    assert.equal("content" in delta, false);
    assert.match((changed.deliveries[0] as { current: { contentIdentity: string } }).current.contentIdentity, /.+/);
    assert.equal(changed.lifecycle.sessionId, started.lifecycle.sessionId);
    assert.equal(changed.lifecycle.contextGeneration, started.lifecycle.contextGeneration);

    const database = new DatabaseSync(path.join(root, ".codeatlas", "context.db"));
    const latestReceipt = database.prepare("SELECT receipt_id AS receiptId FROM context_receipts ORDER BY delivered_at DESC, receipt_id DESC LIMIT 1").get() as { receiptId: string };
    database.prepare("UPDATE context_receipts SET workspace_identity = 'other-workspace' WHERE receipt_id = ?").run(latestReceipt.receiptId);
    database.close();
    await writeFile(sourcePath, "one\ntwo\nthree\nfour\n");
    const rehydrated = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId, detail: "full" }, common);
    const rehydrateDelivery = rehydrated.deliveries[0] as unknown as { mode: string; content?: string; delta?: unknown; reason?: string; current?: unknown };
    assert.equal(rehydrateDelivery.mode, "rehydrate");
    assert.equal(rehydrateDelivery.content, "one\ntwo\nthree\nfour\n");
    assert.equal("delta" in rehydrateDelivery, false);
    assert.equal(rehydrateDelivery.reason, "identity_mismatch");
    assert.ok(rehydrateDelivery.current);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lifecycle handle does not resume from another worktree", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-worktree-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-worktree-b-"));
  try {
    const compile = async () => plan([]);
    const start = await startTaskContext({ task: "empty smoke task", anchors: [], detail: "compact" }, { repositoryPath: first, compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => [] });
    await assert.rejects(
      refreshTaskContext({ taskContextId: start.lifecycle.taskContextId }, { repositoryPath: second, compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => [] }),
      (error: unknown) => error instanceof TaskContextLifecycleDomainError && error.operationError.code === "lifecycle_not_found",
    );
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

assert.equal(CONTEXT_AWARE_SOURCE_PROJECTION, "source-v1");

test("real Git repository smoke preserves delivery history across CLI/process restart", async () => {
  const primary = process.cwd();
  const before = await git(primary, "status", "--short");
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-real-smoke-"));
  const repo = path.join(root, "repo");
  const second = path.join(root, "second");
  try {
    await git(root, "init", "-q", "-b", "main");
    await writeFile(path.join(root, "codeatlas-head.ts"), await git(primary, "show", "HEAD:src/cli.ts"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "phase15c-smoke" }));
    await writeFile(path.join(root, "auth.ts"), "export const auth = \"one\";\n");
    await git(root, "config", "user.email", "phase15c-smoke@example.invalid");
    await git(root, "config", "user.name", "Phase15C smoke");
    await git(root, "add", "package.json", "auth.ts", "codeatlas-head.ts");
    await git(root, "commit", "-qm", "smoke fixture sourced from CodeAtlas HEAD");
    assert.equal(await git(root, "show", "HEAD:codeatlas-head.ts"), await readFile(path.join(root, "codeatlas-head.ts"), "utf8"));
    await git(root, "clone", "-q", "--no-local", root, repo);
    await git(repo, "worktree", "add", "-q", second, "HEAD");

    await cli(primary, "init", repo, "--no-guidance", "--json");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-qm", "smoke index metadata");
    await cli(primary, "sync", repo, "--json");
    await writeFile(path.join(repo, "auth.ts"), "export const auth = \"one\";\nexport const pending = true;\n");

    const started = await cli(primary, "context-start", repo, "--task", "update auth", "--json");
    const handle = started.lifecycle.taskContextId as string;
    const sessionId = started.lifecycle.sessionId as string;
    const generation = started.lifecycle.contextGeneration as string;
    const initial = deliveryFor(started, "auth.ts");
    assert.equal(initial.mode, "full");
    assert.equal(initial.content, "export const auth = \"one\";\nexport const pending = true;\n");
    assert.equal(started.lifecycle.revision, 1);

    const unchanged = await cli(primary, "context-refresh", repo, handle, "--json");
    const unchangedDelivery = deliveryFor(unchanged, "auth.ts");
    assert.equal(unchangedDelivery.mode, "unchanged");
    assert.equal("content" in unchangedDelivery, false);

    await writeFile(path.join(repo, "auth.ts"), "export const auth = \"one\";\nexport const refreshed = true;\n");
    const changed = await cli(primary, "context-refresh", repo, handle, "--full", "--json");
    const changedDelivery = deliveryFor(changed, "auth.ts");
    assert.ok(["delta", "rehydrate", "full"].includes(changedDelivery.mode));
    if (changedDelivery.mode === "delta") assert.ok(changedDelivery.delta);
    if (changedDelivery.mode === "rehydrate" || changedDelivery.mode === "full") assert.match(changedDelivery.content, /refreshed/);
    assert.equal(changed.lifecycle.sessionId, sessionId);
    assert.equal(changed.lifecycle.contextGeneration, generation);

    const mcp = spawn(process.execPath, [cliPath, "mcp"], { cwd: primary, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { mcp.once("spawn", resolve); mcp.once("error", reject); });
    await stopProcess(mcp);

    const restarted = await cli(primary, "context-refresh", repo, handle, "--json");
    assert.equal(restarted.lifecycle.sessionId, sessionId);
    assert.equal(restarted.lifecycle.contextGeneration, generation);
    assert.equal(deliveryFor(restarted, "auth.ts").mode, "unchanged");

    const isolated = await cli(primary, "context-refresh", second, handle, "--json").catch((error: { stdout?: string }) => JSON.parse(error.stdout ?? "{}"));
    assert.equal(isolated.error.code, "lifecycle_not_found");
    assert.equal(await readFile(path.join(repo, "auth.ts"), "utf8"), "export const auth = \"one\";\nexport const refreshed = true;\n");
  } finally {
    try { await git(repo, "worktree", "remove", "--force", second); } catch { /* best-effort cleanup of the temporary worktree */ }
    await rm(root, { recursive: true, force: true });
    assert.equal(await git(primary, "status", "--short"), before);
  }
});
