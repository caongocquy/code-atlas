import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { LocalScipIndexer, localScipIndexer } from "../src/infrastructure/scip/local-scip-indexer.js";
import { encodeScipDocument, encodeScipIndex, type ScipFixtureOccurrence } from "./helpers/phase16b-scip-fixture.js";

const targetSymbol = "scip-typescript npm fixture 1.0.0 src/target().";

async function makeFixture(): Promise<{ root: string; bin: string; fixture: string; invocation: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16b-scip-"));
  const bin = path.join(root, "tools");
  await mkdir(bin, { recursive: true });
  const fixture = path.join(root, "index-fixture.scip");
  const invocation = path.join(root, "invocation.json");
  await writeFile(fixture, encodeScipIndex([]));
  return { root, bin, fixture, invocation };
}

async function writeExecutable(file: string, version: string): Promise<void> {
const script = `#!/usr/bin/env node\nimport fs from "node:fs";\nconst args = process.argv.slice(2);\nif (args[0] === "--version") { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(0); }\nfs.writeFileSync(process.env.SCIP_INVOCATION_FILE, JSON.stringify({ args, cwd: process.cwd() }));\nif (process.env.SCIP_MODE === "flood") process.stdout.write("x".repeat(4096));\nconst output = args[args.indexOf("--output") + 1];\nif (process.env.SCIP_MODE === "empty") fs.writeFileSync(output, Buffer.alloc(0));\nelse fs.copyFileSync(process.env.SCIP_FIXTURE_FILE, output);\n`;
  await writeFile(file, script);
  await chmod(file, 0o755);
}

function makeUnit(root: string, relativePath: string, language: "typescript" | "javascript", source: string) {
  const extracted = extractParsedFacts({ source, language, filePath: relativePath, repositoryId: "repo-id", contentHash: "fixture-hash" });
  assert.equal(extracted.kind, "facts");
  return { relativePath, source, facts: extracted.facts };
}

function occurrence(source: string, token: string, roles: number): ScipFixtureOccurrence {
  const start = source.lastIndexOf(token);
  return { range: [0, start, start + token.length], symbol: targetSymbol, roles };
}

test("SCIP discovery prefers project-local executable over PATH in stable order", async () => {
  const fixture = await makeFixture();
  try {
    const local = path.join(fixture.root, "node_modules", ".bin", "scip-typescript");
    const fromPath = path.join(fixture.bin, "scip-typescript");
    await mkdir(path.dirname(local), { recursive: true });
    await writeExecutable(local, "local-0.4.0");
    await writeExecutable(fromPath, "path-0.4.0");

    const indexer = new LocalScipIndexer({
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ""}`, SCIP_FIXTURE_FILE: fixture.fixture, SCIP_INVOCATION_FILE: fixture.invocation },
    });
    const discovery = await indexer.discover(fixture.root);

    assert.equal(discovery.status, "ready");
    assert.equal(discovery.tool?.source, "project-local");
    assert.equal(discovery.tool?.version, "local-0.4.0");
    assert.equal(discovery.tool?.executablePath, await realpath(local));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("SCIP uses PATH only when no project-local executable exists, and never downloads", async () => {
  const fixture = await makeFixture();
  try {
    const fromPath = path.join(fixture.bin, "scip-typescript");
    await writeExecutable(fromPath, "path-0.4.0");
    const indexer = new LocalScipIndexer({ env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH ?? ""}` } });
    const found = await indexer.discover(fixture.root);
    assert.equal(found.status, "ready");
    assert.equal(found.tool?.source, "path");

    await rm(fromPath);
    const absent = await new LocalScipIndexer({ env: { ...process.env, PATH: "" } }).discover(fixture.root);
    assert.equal(absent.status, "unavailable");
    assert.equal(absent.tool, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("SCIP index runs into a temporary artifact with project cwd and JS inference", async () => {
  const fixture = await makeFixture();
  try {
    const local = path.join(fixture.root, "node_modules", ".bin", "scip-typescript");
    await mkdir(path.dirname(local), { recursive: true });
    await writeExecutable(local, "0.4.0");
    const source = "export function target() { return true; }\n";
    const target = makeUnit(fixture.root, "target.js", "javascript", source);
    const callerSource = "import { target } from './target.js'; target();\n";
    const caller = makeUnit(fixture.root, "caller.js", "javascript", callerSource);
    await writeFile(fixture.fixture, encodeScipIndex([
      encodeScipDocument("target.js", [occurrence(source, "target", 1)]),
      encodeScipDocument("caller.js", [occurrence(callerSource, "target", 8)]),
    ]));
    const indexer = new LocalScipIndexer({
      env: { ...process.env, PATH: process.env.PATH ?? "", SCIP_FIXTURE_FILE: fixture.fixture, SCIP_INVOCATION_FILE: fixture.invocation },
    });
    const discovery = await indexer.discover(fixture.root);
    assert.equal(discovery.status, "ready");

    const evidence = await indexer.index({
      projectRoot: fixture.root,
      repositoryId: "repo-id",
      tool: discovery.tool!,
      units: [target, caller],
    });

    assert.ok(evidence.some((item) => item.target.relativePath === "target.js"));
    const invocation = JSON.parse(await readFile(fixture.invocation, "utf8")) as { args: string[]; cwd: string };
    assert.equal(invocation.args[0], "index");
    assert.equal(invocation.cwd, await realpath(fixture.root));
    assert.ok(invocation.args.includes("--cwd"));
    assert.ok(invocation.args.includes("--output"));
    assert.ok(invocation.args.includes("--infer-tsconfig"));
    assert.ok(!invocation.args.includes("npx"));
    assert.equal(await readFile(path.join(fixture.root, "index.scip")).then(() => true, () => false), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("SCIP rejects excessive subprocess output and oversized artifacts", async () => {
  const fixture = await makeFixture();
  try {
    const local = path.join(fixture.root, "node_modules", ".bin", "scip-typescript");
    await mkdir(path.dirname(local), { recursive: true });
    await writeExecutable(local, "0.4.0");
    const target = makeUnit(fixture.root, "target.ts", "typescript", "export function target() {}\n");
    const env = { ...process.env, PATH: process.env.PATH ?? "", SCIP_FIXTURE_FILE: fixture.fixture, SCIP_INVOCATION_FILE: fixture.invocation };
    const discovery = await new LocalScipIndexer({ env, maxProcessOutputBytes: 64 }).discover(fixture.root);
    assert.equal(discovery.status, "ready");

    env.SCIP_MODE = "flood";
    await assert.rejects(
      new LocalScipIndexer({ env, maxProcessOutputBytes: 64 }).index({ projectRoot: fixture.root, repositoryId: "repo-id", tool: discovery.tool!, units: [target] }),
      /stdout exceeded 64 bytes/,
    );

    delete env.SCIP_MODE;
    await writeFile(fixture.fixture, Buffer.alloc(65, 1));
    await assert.rejects(
      new LocalScipIndexer({ env, maxScipIndexBytes: 64 }).index({ projectRoot: fixture.root, repositoryId: "repo-id", tool: discovery.tool!, units: [target] }),
      /SCIP index exceeded 64 bytes/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("optional real scip-typescript smoke indexes a fixture without a pre-generated artifact", {
  skip: process.env.CODE_ATLAS_SCIP_SMOKE === "1" ? false : "set CODE_ATLAS_SCIP_SMOKE=1 to run local SCIP smoke",
}, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16b-real-scip-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "phase16b-scip-smoke", private: true }));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }));
    const targetSource = "export function target() { return true; }\n";
    const callerSource = "import { target as local } from './dep.js';\nlocal();\n";
    await writeFile(path.join(root, "dep.ts"), targetSource);
    await writeFile(path.join(root, "index.ts"), callerSource);
    const discovery = await localScipIndexer.discover(root);
    if (discovery.status !== "ready" || !discovery.tool) {
      context.skip("scip-typescript is unavailable on this machine");
      return;
    }
    const target = makeUnit(root, "dep.ts", "typescript", targetSource);
    const caller = makeUnit(root, "index.ts", "typescript", callerSource);
    const call = caller.facts.callSites.find((item) => item.calleeText === "local");
    assert.ok(call);
    const evidence = await localScipIndexer.index({ projectRoot: root, repositoryId: "repo-id", tool: discovery.tool, units: [target, caller] });
    assert.ok(evidence.some((item) => item.sourceUnit.relativePath === "index.ts"
      && item.siteLocalId === call.localId && item.target.relativePath === "dep.ts"));
    assert.equal(await readFile(path.join(root, "index.scip")).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
