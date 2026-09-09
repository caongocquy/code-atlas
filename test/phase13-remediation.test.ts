import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { affectedTests } from "../src/core/change/affected-tests.service.js";
import { architectureDrift } from "../src/core/architecture/architecture-drift.service.js";
import { classifyArchitectureFile, parseArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";
import { architecturePolicySemanticHash } from "../src/core/architecture/architecture-policy-snapshot.js";
import { changeGate } from "../src/core/gate/change-gate.service.js";
import { explainIncomplete } from "../src/core/diagnostics/explain-incomplete.service.js";
import { createCoverageDiagnostics } from "../src/core/diagnostics/coverage-diagnostics.service.js";
import { graphDelta, readGraphDeltaContext } from "../src/core/change/graph-delta.service.js";
import { analyzeInspectChangeFromContext, inspectChange } from "../src/core/change/inspect-change.service.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";

const execFile = promisify(execFileCallback);

test("legacy unresolved coverage remains compatibility-only and non-authoritative", () => {
  const result = createCoverageDiagnostics({
    resolutionDiagnostics: [{
      kind: "unresolved",
      evidence: [],
      reason: "legacy unresolved result",
      source: { file: "src/legacy.ts", line: 1 },
    }],
  });
  assert.equal(result.mayBeIncomplete, true);
  assert.equal(result.authoritativeNegativeResults, false);
  assert.equal(result.gaps.some((gap) => gap.kind === "ambiguous_target"), false);
});

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function writeFiles(repoPath: string, files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repoPath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function withRepo(files: Record<string, string>, callback: (repoPath: string) => Promise<void>): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-remediation-"));
  try {
    await writeFiles(repoPath, files);
    await git(repoPath, ["init", "-q"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "initial"]);
    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

test("inspect_change maps commit and staged symbols from their selected snapshots", async () => {
  await withRepo({ "src/value.ts": "export function oldName() { return 1; }\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/value.ts"), "export function commitName() { return 2; }\n");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "commit-name"]);
    const commit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "src/value.ts"), "export function workingName() { return 3; }\n");

    const historical = await inspectChange(repoPath, { mode: "commit", commit });
    assert.equal(historical.changedSymbols.some((symbol) => symbol.name === "commitName"), true);
    assert.equal(historical.changedSymbols.some((symbol) => symbol.name === "workingName"), false);

    await git(repoPath, ["reset", "--quiet", "HEAD^", "--"]);
    await writeFile(path.join(repoPath, "src/value.ts"), "export function stagedName() { return 4; }\n");
    await git(repoPath, ["add", "src/value.ts"]);
    await writeFile(path.join(repoPath, "src/value.ts"), "export function workingName() { return 5; }\n");
    const staged = await inspectChange(repoPath, { mode: "staged" });
    assert.equal(staged.changedSymbols.some((symbol) => symbol.name === "stagedName"), true);
    assert.equal(staged.changedSymbols.some((symbol) => symbol.name === "workingName"), false);
  });
});

test("historical affected_tests inherits snapshot-correct symbols", async () => {
  await withRepo({
    "src/value.ts": "export function oldName() { return 1; }\n",
    "test/value.test.ts": "import { oldName } from '../src/value.js';\nexport function check() { return oldName(); }\n",
  }, async (repoPath) => {
    await writeFiles(repoPath, {
      "src/value.ts": "export function commitName() { return 2; }\n",
      "test/value.test.ts": "import { commitName } from '../src/value.js';\nexport function check() { return commitName(); }\n",
    });
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "historical-target"]);
    const commit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFiles(repoPath, {
      "src/value.ts": "export function workingName() { return 3; }\n",
      "test/value.test.ts": "import { workingName } from '../src/value.js';\nexport function check() { return workingName(); }\n",
    });
    const result = await affectedTests(repoPath, { mode: "commit", commit });
    assert.equal(result.change.changedSymbols > 0, true);
    assert.equal(result.uncoveredAffectedSymbols.some((symbol) => symbol.name === "workingName"), false);
    assert.equal(result.changedTests.includes("test/value.test.ts"), true);
  });
});

test("Phase 13 analyses do not update indexed repository metadata", async () => {
  await withRepo({
    ".gitignore": ".codeatlas/\n",
    "src/value.ts": "export function value() { return 1; }\n",
  }, async (repoPath) => {
    await indexRepository(repoPath, { skipGit: true });
    const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
    const beforeDb = await stat(databasePath);
    const beforeSidecars = await Promise.all(["-wal", "-shm"].map(async (suffix) => {
      try { const value = await lstat(`${databasePath}${suffix}`); return [suffix, value.mtimeMs, value.size] as const; }
      catch { return [suffix, undefined, undefined] as const; }
    }));
    const beforeStatus = await git(repoPath, ["status", "--porcelain"]);
    const database = new DatabaseSync(`file:${path.resolve(databasePath)}?immutable=1`, { readOnly: true });
    const beforeUpdatedAt = (database.prepare("SELECT updated_at FROM repositories LIMIT 1").get() as { updated_at: string }).updated_at;
    database.close();

    await writeFile(path.join(repoPath, "src/value.ts"), "export function value() { return 2; }\n");
    await inspectChange(repoPath);
    await affectedTests(repoPath);
    await explainIncomplete(repoPath);
    await graphDelta(repoPath);
    await architectureDrift(repoPath);
    await changeGate(repoPath);

    const afterDb = await stat(databasePath);
    const afterSidecars = await Promise.all(["-wal", "-shm"].map(async (suffix) => {
      try { const value = await lstat(`${databasePath}${suffix}`); return [suffix, value.mtimeMs, value.size] as const; }
      catch { return [suffix, undefined, undefined] as const; }
    }));
    const afterDatabase = new DatabaseSync(`file:${path.resolve(databasePath)}?immutable=1`, { readOnly: true });
    const afterUpdatedAt = (afterDatabase.prepare("SELECT updated_at FROM repositories LIMIT 1").get() as { updated_at: string }).updated_at;
    afterDatabase.close();
    assert.equal(afterUpdatedAt, beforeUpdatedAt);
    assert.equal(afterDb.mtimeMs, beforeDb.mtimeMs);
    assert.deepEqual(afterSidecars, beforeSidecars);
    assert.equal(await git(repoPath, ["status", "--porcelain"]), beforeStatus || " M src/value.ts\n");
  });
});

test("Gate enforces baseline architecture policy when target weakens it", async () => {
  const baseline = JSON.stringify({
    version: 1,
    architecture: {
      groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }],
      rules: [{ id: "ui-no-data", from: "ui", to: "data", action: "deny", edgeKinds: ["imports"], severity: "high" }],
    },
    gate: { architecture: { failOnSeverityAtLeast: "high" } },
  }, null, 2);
  await withRepo({
    "codeatlas.config.json": baseline,
    "src/ui/screen.ts": "export function screen() { return true; }\n",
    "src/data/repository.ts": "export function repository() { return true; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/ui/screen.ts"), 'import { repository } from "../data/repository.js";\nexport function screen() { return repository(); }\n');
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({ version: 1, gate: { risk: { allowUnknown: true }, architecture: { failOnSeverityAtLeast: "high" } } }));
    const result = await changeGate(repoPath);
    assert.equal(result.status, "fail");
    assert.equal(result.checks.find((check) => check.id === "architecture.introducedSeverity")?.status, "fail");
    assert.equal(result.preview?.status, "pass");
  });
});

test("Gate enforces baseline cycle policy when target disables cycle checks", async () => {
  await withRepo({
    "codeatlas.config.json": JSON.stringify({
      version: 1,
      architecture: { cycles: { enabled: true, severity: "high" } },
      gate: { architecture: { failOnSeverityAtLeast: "high" } },
    }),
    "src/a.ts": "import { b } from './b.js';\nexport const a = b;\n",
    "src/b.ts": "export const b = true;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/b.ts"), "import { a } from './a.js';\nexport const b = a;\n");
    await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({
      version: 1,
      architecture: { cycles: { enabled: false } },
      gate: { risk: { allowUnknown: true }, architecture: { failOnSeverityAtLeast: "high" } },
    }));
    const result = await changeGate(repoPath);
    assert.equal(result.status, "fail");
    assert.equal(result.checks.find((check) => check.id === "architecture.introducedSeverity")?.status, "fail");
  });
});

test("architecture policy hashing preserves duplicate matcher behavior and rejects unknown keys", () => {
  const one = parseArchitecturePolicy({ version: 1, architecture: { groups: [{ id: "one", include: ["src/**"] }] } });
  const two = parseArchitecturePolicy({ version: 1, architecture: { groups: [{ id: "one", include: ["src/**"] }, { id: "two", include: ["src/**"] }] } });
  assert.notEqual(architecturePolicySemanticHash(one), architecturePolicySemanticHash(two));
  assert.equal(classifyArchitectureFile(two, "src/file.ts").state, "ambiguous");
  assert.throws(() => parseArchitecturePolicy({ version: 1, architecture: { defaultCrossGroupActoin: "deny" } }), /not supported/);
});

test("Gate CLI accepts the shared maxDepth zero contract", async () => {
  await withRepo({
    "codeatlas.config.json": JSON.stringify({ version: 1, gate: { risk: { allowUnknown: true } } }),
    "src/value.ts": "export function value() { return 1; }\n",
  }, async (repoPath) => {
    const result = await execFile("node", ["--import", "tsx/esm", "src/cli.ts", "gate", "--max-depth", "0", "--json", repoPath], { cwd: path.resolve(".") }).catch((error) => error as { stdout?: string; stderr?: string; code?: number });
    const output = typeof result.stdout === "string" ? result.stdout : "";
    assert.equal(output.includes("max-depth"), false, String(result.stderr ?? ""));
    assert.equal(JSON.parse(output).status !== undefined, true);

    const unsupported = await execFile("node", ["--import", "tsx/esm", "src/cli.ts", "gate", "--config", "alternate.json", "--json", repoPath], { cwd: path.resolve(".") }).catch((error) => error as { stdout?: string; stderr?: string });
    assert.match(typeof unsupported.stdout === "string" ? unsupported.stdout : "", /configPath is not supported|--config is not supported/i);
  });
});

test("Change Gate is pinned to the repository root policy and rejects alternate paths", async () => {
  await withRepo({
    "codeatlas.config.json": JSON.stringify({ version: 1, gate: { risk: { allowUnknown: false, maxAllowed: "medium" } } }),
    "src/value.ts": "export const value = 1;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/value.ts"), "export const value = 2;\n");
    await writeFile(path.join(repoPath, "alternate.json"), JSON.stringify({ version: 1, gate: { risk: { allowUnknown: true, maxAllowed: "high" } } }));

    const result = await changeGate(repoPath);
    assert.equal(result.policy.baseline.path, "codeatlas.config.json");
    assert.equal(result.status, "fail");
    await assert.rejects(
      () => changeGate(repoPath, { configPath: "alternate.json" } as never),
      /configPath.*not supported|root.*codeatlas\.config\.json/i,
    );
  });
});

test("Gate analysis can continue from one captured source context", async () => {
  await withRepo({ "src/value.ts": "export function oldName() { return 1; }\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/value.ts"), "export function capturedName() { return 2; }\n");
    const context = await readGraphDeltaContext(repoPath, {});
    await writeFile(path.join(repoPath, "src/value.ts"), "export function laterName() { return 3; }\n");

    const analysis = analyzeInspectChangeFromContext({}, context);
    assert.equal(analysis.result.changedSymbols.some((symbol) => symbol.name === "capturedName"), true);
    assert.equal(analysis.result.changedSymbols.some((symbol) => symbol.name === "laterName"), false);
  });
});

test("root-commit Gate bootstrap reads code and policy from one target snapshot", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-root-gate-"));
  try {
    await writeFiles(repoPath, {
      "codeatlas.config.json": JSON.stringify({ version: 1, gate: { risk: { allowUnknown: true } } }),
      "src/value.ts": "export function rootName() { return 1; }\n",
    });
    await git(repoPath, ["init", "-q"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "root"]);
    const rootCommit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "src/value.ts"), "export function dirtyName() { return 2; }\n");

    const result = await changeGate(repoPath, { mode: "commit", commit: rootCommit });
    assert.equal(result.source.mode, "commit");
    assert.equal(result.policy.enforcementSource, "target_bootstrap");
    assert.equal(result.policy.baseline.configured, false);
    assert.equal(result.policy.target.sourceKind, "git_revision");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("transient-complete change analysis does not invent not_indexed gaps", async () => {
  await withRepo({
    "codeatlas.config.json": JSON.stringify({ version: 1, gate: { risk: { allowUnknown: true }, diagnostics: { forbidGapKinds: ["not_indexed"] } } }),
    "src/value.ts": "export const value = 1;\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/value.ts"), "export const value = 2;\n");
    const result = await inspectChange(repoPath);
    assert.equal(result.diagnostics.gaps.some((gap) => gap.kind === "not_indexed"), false);
    assert.equal(result.reasons.some((reason) => reason.includes("not indexed")), false);
    await assert.rejects(() => changeGate(repoPath), /not_indexed.*unsupported|unsupported value.*not_indexed/i);
  });
});
