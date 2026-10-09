import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

const root = path.resolve(".");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
const publish = readFileSync(path.join(root, ".github/workflows/publish.yml"), "utf8");
const release = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const smoke = readFileSync(path.join(root, ".github/workflows/release-smoke.yml"), "utf8");
const portable = readFileSync(path.join(root, ".github/workflows/portable-packaging-smoke.yml"), "utf8");
const parserBuild = readFileSync(path.join(root, ".github/workflows/tree-sitter-installation.yml"), "utf8");
const bundleSmoke = readFileSync(path.join(root, "scripts/smoke-release-bundle.mjs"), "utf8");
const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");

test("Phase14F release workflows are valid YAML", () => {
  const result = spawnSync("ruby", ["-e", "require 'yaml'; ARGV.each { |file| YAML.load_file(file) }", ".github/workflows/publish.yml", ".github/workflows/release.yml", ".github/workflows/release-smoke.yml", ".github/workflows/portable-packaging-smoke.yml", ".github/workflows/tree-sitter-installation.yml"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "Ruby YAML parser failed");
});

test("manual release smoke verifies a real clean npm consumer", () => {
  assert.match(smoke, /workflow_dispatch/);
  assert.match(smoke, /ubuntu-latest/);
  assert.match(smoke, /node-version: 24/);
  assert.match(smoke, /npm@11\.5\.1/);
  assert.match(smoke, /pnpm@11\.22\.0/);
  assert.match(smoke, /pnpm install --frozen-lockfile/);
  assert.match(smoke, /npm pack --silent/);
  assert.match(smoke, /workspace:|link:|file:/);
  assert.match(smoke, /npm install "\$TARBALL"/);
  assert.match(smoke, /npm install -g "\$TARBALL" --prefix/);
  assert.match(smoke, /code-atlas-init|init --no-guidance/);
  assert.match(smoke, /code-atlas-status|status/);
  assert.match(smoke, /code-atlas-mcp|initialize/);
  assert.match(smoke, /context-compile --help/);
  assert.match(smoke, /compile_task_context/);
  assert.match(smoke, /GITHUB_STEP_SUMMARY/);
  assert.match(smoke, /upload-artifact@v4/);
  assert.doesNotMatch(smoke, /--legacy-peer-deps|--force|--ignore-scripts/);
});

test("release and portable checks restore and verify the complete parser payload before builds", () => {
  assert.match(parserBuild, /workflow_call:[\s\S]*assemble_only:[\s\S]*type: boolean/);
  for (const workflow of [smoke, portable]) {
    assert.match(workflow, /uses: \.\/\.github\/workflows\/tree-sitter-installation\.yml/);
    assert.match(workflow, /code-atlas-parser-consumer-package/);
    assert.match(workflow, /tar -xzf/);
    assert.match(workflow, /node scripts\/parser-distribution\.mjs verify --all-targets/);
    const verified = workflow.indexOf("verify --all-targets");
    const build = Math.max(workflow.indexOf("pnpm run build"), workflow.indexOf("pnpm build"));
    assert.ok(verified >= 0 && build >= 0 && verified < build);
  }
  assert.match(smoke, /node --import tsx\/esm --input-type=module[^\n]*native-runtime\.ts/);
  assert.match(smoke, /native-runtime\.js/);
  assert.match(smoke, /require\.resolve\("@showdar2112\/code-atlas\/dist\/core\/graph\/parsers\/native-runtime\.js"\)/);
  assert.match(bundleSmoke, /native parsers load every supported language from the artifact/);
  assert.match(bundleSmoke, /load\("core\/graph\/parsers\/native-runtime\.js"\)/);
});

test("native parser policy delivers every grammar with only required tooling approvals", () => {
  const approved = workspace.split(/\r?\n/).flatMap((line) => {
    const match = /^ {2}["']?([^"':]+)["']?: true$/.exec(line);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(approved.sort(), [
    "@modelcontextprotocol/inspector", "esbuild", "onnxruntime-node", "protobufjs", "tree-sitter", "tree-sitter-cli",
  ].sort());
  const sources = JSON.parse(readFileSync(path.join(root, "scripts/parser-sources.json"), "utf8"));
  assert.equal(sources.runtime.version, "0.25.1");
  assert.deepEqual(sources.grammars.map((grammar: { name: string }) => grammar.name).sort(), [
    "@driftlog/tree-sitter-dart", "tree-sitter-c", "tree-sitter-cpp", "tree-sitter-go", "tree-sitter-java",
    "tree-sitter-javascript", "tree-sitter-kotlin", "tree-sitter-python", "tree-sitter-rust", "tree-sitter-swift", "tree-sitter-typescript",
  ].sort());
  const dependencies = packageJson.dependencies as Record<string, string>;
  for (const name of [sources.runtime.name, ...sources.grammars.map((grammar: { name: string }) => grammar.name), "tree-sitter-cli"]) {
    assert.equal(dependencies[name], undefined, `${name} must not reintroduce consumer install hooks or peer conflicts`);
  }
  const devDependencies = packageJson.devDependencies as Record<string, string>;
  assert.equal(devDependencies["tree-sitter"], "0.25.1");
  assert.equal(devDependencies["tree-sitter-cli"], "0.23.2");
  assert.ok((packageJson.files as string[]).includes("vendor/parsers"));
  assert.match((packageJson.scripts as Record<string, string>)["parsers:verify"], /verify --all-targets/);
  assert.equal((packageJson.scripts as Record<string, string>).prepack, "npm run parsers:verify");
});

test("publish workflow validates the exact tag and package contract", () => {
  assert.match(publish, /tags:\s*\n\s+- ["']v\*["']/);
  assert.match(publish, /node-version: 24/);
  assert.match(publish, /npm@11\.5\.1/);
  assert.match(publish, /id-token:\s*write/);
  assert.match(publish, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(publish, /package_name.*@showdar2112\/code-atlas|== "@showdar2112\/code-atlas"/);
  assert.match(publish, /bin_path.*dist\/cli\.js/);
  assert.match(publish, /npm install --global pnpm@11\.22\.0/);
  assert.match(publish, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(publish, /npm publish.*NPM_TOKEN/);
});

test("public package metadata points to the canonical repository", () => {
  assert.equal(packageJson.name, "@showdar2112/code-atlas");
  assert.equal(packageJson.version, "1.6.0");
  assert.deepEqual(packageJson.bin, { "code-atlas": "dist/cli.js" });
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.equal(packageJson.license, "ISC");
  assert.deepEqual(packageJson.repository, {
    type: "git",
    url: "git+https://github.com/caongocquy/code-atlas.git",
  });
  assert.equal(packageJson.homepage, "https://github.com/caongocquy/code-atlas#readme");
  assert.deepEqual(packageJson.bugs, {
    url: "https://github.com/caongocquy/code-atlas/issues",
  });
});

test("CLI and MCP advertise the package release version", async () => {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "release-version-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.getServerVersion();
    assert.equal(result?.version, packageJson.version);
  } finally {
    await client.close();
    await server.close();
  }
});

test("publish workflow validates package contents and real packed consumers", () => {
  for (const file of ["dist/cli.js", "dist/adapters/cli/cli-presentation.js", "dist/adapters/mcp/mcp-server.js", "README.md", "LICENSE", "package.json"]) {
    assert.match(publish, new RegExp(file.replaceAll(".", "\\.")));
  }
  assert.match(publish, /npm pack --dry-run --json/);
  assert.match(publish, /npm install --ignore-scripts=false/);
  assert.match(publish, /--help/);
  assert.match(publish, /init --no-index --no-guidance/);
  assert.match(publish, /status/);
  assert.match(publish, /JSON\.parse/);
  assert.match(publish, /code-atlas-mcp|"initialize"/);
});

test("publish workflow is duplicate-safe and fails closed on registry errors", () => {
  assert.match(publish, /npm view "@showdar2112\/code-atlas@\$VERSION"/);
  assert.match(publish, /@showdar2112\/code-atlas/);
  assert.match(publish, /already exists; skipping duplicate publish/);
  assert.match(publish, /npm publish --access public --provenance/);
  assert.match(publish, /else[\s\S]*cat "\$error_file" >&2[\s\S]*exit "\$query_status"/);
});

test("release workflow requires npm first and safely handles duplicate releases", () => {
  assert.match(release, /needs: verify-npm/);
  assert.match(release, /contents:\s*write/);
  assert.match(release, /npm view "@showdar2112\/code-atlas@\$VERSION"/);
  assert.match(release, /bin\['code-atlas'\].*dist\/cli\.js/);
  assert.match(release, /releases\/tags\/\$TAG/);
  assert.match(release, /CodeAtlas \$TAG/);
  assert.match(release, /--verify-tag/);
  assert.match(release, /--generate-notes/);
  assert.match(release, /--latest/);
  assert.match(release, /Existing GitHub Release does not match/);
  assert.match(release, /HTTP\/\[\^ \]\+ 404|status code 404/);
  assert.match(release, /for attempt in \{1\.\.60\}/);
  assert.match(release, /sleep 10/);
});
