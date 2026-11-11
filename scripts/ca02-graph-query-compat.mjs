import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const current = process.cwd();
const baseline = process.env.CA02_BASELINE_DIR;
assert.ok(baseline, "CA02_BASELINE_DIR must reference an installed audited baseline worktree");
const require = createRequire(path.join(current, "package.json"));
const packagePath = require.resolve("@modelcontextprotocol/inspector/package.json");
const inspectorPackage = require(packagePath);
const bin = typeof inspectorPackage.bin === "string" ? inspectorPackage.bin : inspectorPackage.bin["mcp-inspector"];
assert.ok(bin);
const inspector = path.resolve(path.dirname(packagePath), bin);

function inspectorCall(checkout, home, method, toolName, args) {
  const localRequire = createRequire(path.join(checkout, "package.json"));
  const loader = localRequire.resolve("tsx/esm");
  const command = [
    inspector, "--cli", process.execPath, "--import", pathToFileURL(loader).href,
    path.join(checkout, "src/cli.ts"), "mcp", "--",
    "--method", method, "--format", "json",
    ...(toolName ? ["--tool-name", toolName] : []),
    ...(args ? ["--tool-args-json", JSON.stringify(args)] : []),
  ];
  const output = spawnSync(process.execPath, command, {
    cwd: checkout, encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") },
    timeout: 45_000, maxBuffer: 4_000_000,
  });
  assert.equal(output.error, undefined, String(output.stderr));
  assert.equal(output.status, 0, `${toolName ?? method} failed in ${checkout}: ${output.stderr}\n${output.stdout}`);
  const result = JSON.parse(output.stdout).result;
  assert.ok(result && typeof result === "object", `${toolName}: missing MCP result`);
  return result;
}

function git(repo, ...args) {
  const output = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
}

function makeRepo(parent, suffix) {
  const root = path.join(parent, suffix);
  mkdirSync(root);
  const source = [
    "export function target() { return 1; }",
    "export function caller() { target(); return target(); }",
    "export function unrelated() { return 2; }",
    "",
  ].join("\n");
  writeFileSync(path.join(root, "source.ts"), source);
  git(root, "init", "-q");
  git(root, "add", "source.ts");
  git(root, "-c", "user.name=CA02 Fixture", "-c", "user.email=ca02@example.invalid", "commit", "-qm", "fixture");
  return root;
}

const keys = (value) => Object.keys(value ?? {}).sort();
const meaningfulKeys = ["status", "entity", "candidates", "relations", "items", "path", "nodes", "edges", "changes", "files", "capabilityState", "mayBeIncomplete"];
const checks = [
  { tool: "get_symbol", args: { query: "target" } },
  { tool: "find_callers", args: { query: "target" } },
  { tool: "find_callees", args: { query: "caller" } },
  { tool: "trace", args: { from: "caller", to: "target" } },
  { tool: "inspect_change", args: { mode: "working" } },
];
const scratch = mkdtempSync(path.join(os.tmpdir(), "ca02-graph-mcp-"));
try {
  const before = makeRepo(scratch, "old-repo");
  const after = makeRepo(scratch, "new-repo");
  const oldHome = path.join(scratch, "old-home");
  const newHome = path.join(scratch, "new-home");
  for (const [checkout, home, repo] of [[baseline, oldHome, before], [current, newHome, after]]) {
    const published = inspectorCall(checkout, home, "tools/call", "index_repository", { repoPath: repo, skipGit: true });
    assert.equal(published.isError, undefined, JSON.stringify(published).slice(0, 600));
    assert.ok(published.structuredContent, "Index operation must return structured content");
  }
  // Keep both Git working trees in the same meaningful 'working change' state.
  appendFileSync(path.join(before, "source.ts"), "// changed source comment\n");
  appendFileSync(path.join(after, "source.ts"), "// changed source comment\n");

  const results = [];
  for (const check of checks) {
    const left = inspectorCall(baseline, oldHome, "tools/call", check.tool, { repoPath: before, ...check.args });
    const right = inspectorCall(current, newHome, "tools/call", check.tool, { repoPath: after, ...check.args });
    assert.notEqual(left.isError, true, `${check.tool}: baseline rejected valid arguments`);
    assert.notEqual(right.isError, true, `${check.tool}: current rejected valid arguments`);
    const missingEnvelope = keys(left).filter((key) => !(key in right));
    assert.deepEqual(missingEnvelope, [], `${check.tool}: missing MCP result envelope keys`);
    assert.ok(left.structuredContent && right.structuredContent, `${check.tool}: structuredContent must exist on both`);
    const oldKeys = keys(left.structuredContent);
    const newKeys = keys(right.structuredContent);
    // Dynamic graph resolution is allowed to improve. Shape keys with unchanged
    // status are contractual; with different status, report rather than hide.
    const oldStatus = left.structuredContent.status;
    const newStatus = right.structuredContent.status;
    const removedKeys = oldKeys.filter((key) => !(key in right.structuredContent));
    const missingCore = oldKeys.filter((key) => meaningfulKeys.includes(key) && !(key in right.structuredContent));
    if (oldStatus === newStatus) assert.deepEqual(missingCore, [], `${check.tool}: missing stable public fields`);
    results.push({
      tool: check.tool,
      baselineStatus: oldStatus ?? null,
      currentStatus: newStatus ?? null,
      removedKeys,
      removedCoreKeys: missingCore,
      addedKeys: newKeys.filter((key) => !(key in left.structuredContent)),
      baselineEnvelopeKeys: keys(left), currentEnvelopeKeys: keys(right),
    });
  }
  const report = {
    baselineRef: process.env.CA02_BASELINE_REF, toolCount: results.length, results,
    caveat: "Real indexed/git-backed baseline and current repositories. Compatible MCP envelopes and stable core fields enforced; semantic graph edge values, dynamic IDs and conditional fields are reported, not forced equal.",
  };
  console.log("CA02_GRAPH_MCP_COMPAT " + JSON.stringify(report));
} finally { rmSync(scratch, { recursive: true, force: true }); }
