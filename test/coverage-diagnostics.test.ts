import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { coverageForResolverDiagnostics, createCoverageDiagnostics, mergeCoverageDiagnostics } from "../src/core/diagnostics/coverage-diagnostics.service.js";
import { explainIncomplete } from "../src/core/diagnostics/explain-incomplete.service.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { buildCodeGraphWithResolution } from "../src/core/graph/build-graph.js";
import { inspectChange } from "../src/core/change/inspect-change.service.js";
import { affectedTests } from "../src/core/change/affected-tests.service.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

const execFile = promisify(execFileCallback);

test("resolver diagnostic categories mark coverage incomplete without authoritative negatives", () => {
  const kinds = ["unknown", "unsupported", "budgetExhausted", "weakEvidenceDropped", "candidateOverflow"] as const;
  for (const kind of kinds) {
    const result = coverageForResolverDiagnostics([{
      kind,
      language: "typescript",
      file: "src/source.ts",
      count: 1,
      reason: "resolver coverage is incomplete",
    }]);
    assert.equal(result.mayBeIncomplete, true, kind);
    assert.equal(result.authoritativeNegative, false, kind);
  }
});

test("resolver diagnostics keep legacy resolved-only coverage non-authoritative", () => {
  assert.deepEqual(coverageForResolverDiagnostics([{
    kind: "resolved",
    language: "typescript",
    file: "src/source.ts",
    count: 1,
  }]), { mayBeIncomplete: false, authoritativeNegative: false });
  const result = createCoverageDiagnostics({ resolverDiagnostics: [{
    kind: "unknown",
    language: "typescript",
    file: "src/source.ts",
    count: 1,
    reason: "unknown target",
  }] });
  assert.equal(result.mayBeIncomplete, true);
  assert.equal(result.authoritativeNegativeResults, false);
});

test("ambiguous resolver diagnostics add the existing ambiguous-target coverage gap", () => {
  const result = createCoverageDiagnostics({ resolverDiagnostics: [{
    kind: "ambiguous",
    language: "typescript",
    file: "src/ambiguous.ts",
    count: 2,
    reason: "two equally ranked targets",
  }] });
  assert.equal(result.mayBeIncomplete, true);
  assert.equal(result.authoritativeNegativeResults, false);
  assert.deepEqual(result.gaps, [{
    kind: "ambiguous_target",
    count: 2,
    files: ["src/ambiguous.ts"],
    details: ["two equally ranked targets"],
  }]);
  assert.deepEqual(result.reasons, ["2 ambiguous targets prevent authoritative resolution"]);
});

test("coverage diagnostics aggregate gaps, targets, and only defensible metrics", () => {
  const diagnostics = createCoverageDiagnostics({
    graphState: "ready",
    resolutionCoverage: {
      calls: 0,
      resolvedCalls: 0,
      unresolvedCalls: 0,
      ambiguousCalls: 0,
      extends: 0,
      resolvedExtends: 0,
      unresolvedExtends: 0,
      ambiguousExtends: 0,
      parserErrors: 0,
      unsupportedDynamic: 2,
      mayBeIncomplete: true,
    },
    resolutionDiagnostics: [
      {
        kind: "ambiguous",
        candidates: ["b", "a"],
        ambiguityReason: "two internal targets",
        source: { file: "src/a.ts", line: 4 },
      },
      {
        kind: "unresolved",
        reason: "caller identity is unavailable",
        source: { file: "src/b.ts", line: 8 },
      },
      {
        kind: "unresolved",
        reason: "external dependency is not indexed",
        source: { file: "src/vendor.ts", line: 2 },
      },
    ],
    internalCallResolution: { resolved: 3, total: 4 },
  });

  assert.equal(diagnostics.mayBeIncomplete, true);
  assert.equal(diagnostics.authoritativeNegativeResults, false);
  assert.deepEqual(diagnostics.gaps.map((gap) => [gap.kind, gap.count]), [
    ["ambiguous_target", 1],
    ["dynamic_dispatch", 2],
    ["missing_caller_context", 1],
  ]);
  assert.deepEqual(diagnostics.metrics, [{
    name: "internalCallResolution",
    resolved: 3,
    total: 4,
    ratio: 0.75,
  }]);
  assert.equal(diagnostics.gaps.some((gap) => gap.kind === "broken_internal_import"), false);
  assert.equal(diagnostics.reasons.some((reason) => reason.includes("external")), false);
});

test("not-indexed diagnostics are non-authoritative and do not invent metrics", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-diagnostics-"));
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await explainIncomplete(repoPath, {});
    assert.equal(result.scope, "repository");
    assert.equal(result.mayBeIncomplete, true);
    assert.equal(result.authoritativeNegativeResults, false);
    assert.deepEqual(result.gaps.map((gap) => gap.kind), ["not_indexed"]);
    assert.deepEqual(result.metrics, []);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("ready graph diagnostics still expose known dynamic gaps", async () => {
  const repoPath = await fixture();
  try {
    await indexRepository(repoPath, { skipGit: true });
    const result = await explainIncomplete(repoPath);
    assert.equal(result.gaps.some((gap) => gap.kind === "dynamic_dispatch"), true);
    assert.equal(result.mayBeIncomplete, true);
    assert.equal(result.authoritativeNegativeResults, false);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("diagnostic merges deduplicate targets and do not double-count persisted evidence", () => {
  const value = createCoverageDiagnostics({
    resolutionCoverage: {
      calls: 1,
      resolvedCalls: 0,
      unresolvedCalls: 1,
      ambiguousCalls: 0,
      extends: 0,
      resolvedExtends: 0,
      unresolvedExtends: 0,
      ambiguousExtends: 0,
      parserErrors: 0,
      unsupportedDynamic: 1,
      mayBeIncomplete: true,
    },
    resolutionDiagnostics: [{
      kind: "unresolved",
      reason: "dynamic member dispatch",
      unsupportedDynamic: true,
      source: { file: "src/a.ts", line: 1 },
    }],
  });
  const merged = mergeCoverageDiagnostics(value, value);
  assert.equal(value.gaps.find((gap) => gap.kind === "dynamic_dispatch")?.count, 1);
  assert.equal(merged.gaps.find((gap) => gap.kind === "dynamic_dispatch")?.count, 2);
  assert.equal(merged.verificationTargets.length, 1);
});

test("repository-state diagnostics remain singleton when inherited", () => {
  const value = createCoverageDiagnostics({ graphState: "not_indexed" });
  const merged = mergeCoverageDiagnostics(value, value);
  assert.deepEqual(merged.gaps.map((gap) => [gap.kind, gap.count]), [["not_indexed", 1]]);
});

test("resolver telemetry keeps external and builtin imports out of internal gap categories", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-diagnostics-resolution-"));
  try {
    await writeFile(path.join(repoPath, "source.ts"), [
      'import { existsSync } from "node:fs";',
      'import { missing } from "./missing.js";',
      "export function run() { existsSync(\"file\"); missing(); }",
    ].join("\n"));
    const built = await buildCodeGraphWithResolution(repoPath);
    const diagnostics = built.resolutionByFile.get("source.ts")?.diagnostics ?? [];
    assert.equal(diagnostics.some((item) => item.kind === "unresolved" && item.reason.includes("builtin dependency")), true);
    assert.equal(diagnostics.some((item) => item.kind === "unresolved" && item.reason.includes("broken internal import")), true);
    const normalized = createCoverageDiagnostics({ resolutionDiagnostics: diagnostics });
    assert.equal(normalized.gaps.some((gap) => gap.kind === "broken_internal_import"), true);
    assert.equal(normalized.reasons.some((reason) => reason.includes("external dependency")), false);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function fixture(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-diagnostics-change-"));
  for (const [file, content] of Object.entries({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function alpha() { return 1; }\n",
    "src/b.ts": "import { alpha } from './a.js';\nexport function beta() { return alpha(); }\n",
    "src/dynamic.ts": "export function dynamic(obj: unknown, method: string) { return obj[method](); }\n",
  })) {
    const target = path.join(repoPath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(repoPath, ["init", "-q"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-qm", "initial"]);
  return repoPath;
}

test("change and test diagnostics reuse existing analysis and preserve source semantics", async () => {
  const repoPath = await fixture();
  try {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "src/a.ts"), "export function alpha() { return 2; }\n");
    const change = await inspectChange(repoPath);
    const tests = await affectedTests(repoPath);
    const explainedChange = await explainIncomplete(repoPath, { scope: "change", mode: "working" });
    const explainedTests = await explainIncomplete(repoPath, { scope: "tests", mode: "working" });
    assert.equal(explainedChange.mayBeIncomplete, change.diagnostics.mayBeIncomplete);
    assert.equal(explainedTests.mayBeIncomplete, tests.diagnostics.mayBeIncomplete);
    assert.equal(explainedTests.authoritativeNegativeResults, !explainedTests.mayBeIncomplete);
    assert.equal(change.diagnostics.gaps.every((gap) => gap.kind !== "not_indexed"), true);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("explain_incomplete is listed and returns structured diagnostics", async () => {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "coverage-diagnostics-test", version: "1.0.0" });
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-diagnostics-mcp-"));
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === "explain_incomplete"), true);
    const response = await client.callTool({ name: "explain_incomplete", arguments: { repoPath } });
    const text = response.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    const result = JSON.parse(text.text) as { scope: string; gaps: Array<{ kind: string }> };
    assert.equal(result.scope, "repository");
    assert.equal(result.gaps[0]?.kind, "not_indexed");
    const invalid = await client.callTool({ name: "explain_incomplete", arguments: { repoPath, scope: "change", mode: "range", base: "HEAD" } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("explain-incomplete CLI emits JSON only", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-diagnostics-cli-"));
  try {
    const cliPath = path.resolve("src/cli.ts");
    const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
    const result = await execFile(process.execPath, ["--import", tsxLoader, cliPath, "explain-incomplete", repoPath, "--json"], {
      cwd: repoPath,
      env: { ...process.env, NO_COLOR: "1", NODE_NO_WARNINGS: "1" },
    });
    const output = JSON.parse(result.stdout) as { scope: string; authoritativeNegativeResults: boolean };
    assert.equal(output.scope, "repository");
    assert.equal(output.authoritativeNegativeResults, false);
    assert.equal(result.stderr, "");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
