import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const baseline = process.env.CA02_BASELINE_DIR;
if (!baseline) throw new Error("CA02_BASELINE_DIR must point to an installed baseline git worktree");
const require = createRequire(path.join(root, "package.json"));
const inspectorPackage = require.resolve("@modelcontextprotocol/inspector/package.json");
const pkg = require(inspectorPackage);
const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["mcp-inspector"];
assert.ok(bin, "MCP Inspector executable missing");
const inspector = path.resolve(path.dirname(inspectorPackage), bin);

function request(cwd, method, home, toolName, toolArgs) {
  const localRequire = createRequire(path.join(cwd, "package.json"));
  const tsx = localRequire.resolve("tsx/esm");
  const args = [
    inspector, "--cli", process.execPath, "--import", pathToFileURL(tsx).href,
    path.join(cwd, "src", "cli.ts"), "mcp", "--",
    "--method", method, "--format", "json",
    ...(toolName ? ["--tool-name", toolName] : []),
    ...(toolArgs ? ["--tool-args-json", JSON.stringify(toolArgs)] : []),
  ];
  const output = spawnSync(process.execPath, args, {
    cwd, encoding: "utf8",
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") },
    timeout: 30_000, maxBuffer: 2_000_000,
  });
  assert.equal(output.error, undefined, output.stderr);
  assert.equal(output.status, 0, `${cwd} ${method} ${toolName ?? ""}: ${output.stderr}\n${output.stdout}`);
  return JSON.parse(output.stdout).result;
}
function normalizeTools(list) {
  return new Map((list.tools ?? []).map((tool) => [tool.name, tool]));
}
const fixture = mkdtempSync(path.join(os.tmpdir(), "ca02-mcp-contract-"));
try {
  const oldHome = path.join(fixture, "old");
  const newHome = path.join(fixture, "new");
  const oldTools = normalizeTools(request(baseline, "tools/list", oldHome));
  const newTools = normalizeTools(request(root, "tools/list", newHome));
  const removed = [...oldTools.keys()].filter((name) => !newTools.has(name));
  const incompatible = [];
  for (const [name, before] of oldTools) {
    const after = newTools.get(name);
    if (!after) continue;
    const requiredBefore = new Set(before.inputSchema?.required ?? []);
    const requiredAfter = new Set(after.inputSchema?.required ?? []);
    const additionalRequired = [...requiredAfter].filter((key) => !requiredBefore.has(key));
    if (additionalRequired.length) incompatible.push({ name, additionalRequired });
    const fieldsBefore = before.inputSchema?.properties ?? {};
    const fieldsAfter = after.inputSchema?.properties ?? {};
    for (const key of Object.keys(fieldsBefore)) {
      if (!(key in fieldsAfter)) incompatible.push({ name, removedProperty: key });
    }
  }
  // The public call envelope is checked on an unindexed repository so no
  // expected graph accuracy change is mistaken for a protocol regression.
  const oldResponse = request(baseline, "tools/call", oldHome, "repository_status", { repoPath: fixture });
  const newResponse = request(root, "tools/call", newHome, "repository_status", { repoPath: fixture });
  const envelopeKeys = (value) => Object.keys(value ?? {}).sort();
  const removedEnvelope = envelopeKeys(oldResponse).filter((key) => !(key in (newResponse ?? {})));
  const oldStructured = oldResponse?.structuredContent ?? {};
  const newStructured = newResponse?.structuredContent ?? {};
  const removedStructured = envelopeKeys(oldStructured).filter((key) => !(key in newStructured));
  const report = {
    baselineRef: process.env.CA02_BASELINE_REF,
    baselineToolCount: oldTools.size, currentToolCount: newTools.size,
    removedTools: removed, incompatibleInputSchemas: incompatible,
    removedResponseEnvelopeKeys: removedEnvelope, removedStatusStructuredKeys: removedStructured,
    checkedCall: "repository_status", method: "real stdio MCP Inspector",
    caveat: "Compares tool names, required/available input fields and repository_status envelope. Dynamic graph result values and all-tool output semantics are not byte-for-byte compared.",
  };
  console.log("CA02_MCP_COMPAT " + JSON.stringify(report));
  assert.deepEqual(removed, []);
  assert.deepEqual(incompatible, []);
  assert.deepEqual(removedEnvelope, []);
  assert.deepEqual(removedStructured, []);
} finally { rmSync(fixture, { recursive: true, force: true }); }
