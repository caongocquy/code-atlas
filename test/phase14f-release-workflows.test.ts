import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
const publish = readFileSync(path.join(root, ".github/workflows/publish.yml"), "utf8");
const release = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const smoke = readFileSync(path.join(root, ".github/workflows/release-smoke.yml"), "utf8");
const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");

test("Phase14F release workflows are valid YAML", () => {
  const result = spawnSync("ruby", ["-e", "require 'yaml'; ARGV.each { |file| YAML.load_file(file) }", ".github/workflows/publish.yml", ".github/workflows/release.yml", ".github/workflows/release-smoke.yml"], { cwd: root, encoding: "utf8" });
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
  assert.match(smoke, /GITHUB_STEP_SUMMARY/);
  assert.match(smoke, /upload-artifact@v4/);
  assert.doesNotMatch(smoke, /--legacy-peer-deps|--force|--ignore-scripts/);
});

test("native parser build policy allows every required grammar", () => {
  for (const packageName of [
    "@driftlog/tree-sitter-dart",
    "esbuild",
    "onnxruntime-node",
    "protobufjs",
    "sharp",
    "tree-sitter",
    "tree-sitter-c",
    "tree-sitter-cli",
    "tree-sitter-cpp",
    "tree-sitter-go",
    "tree-sitter-java",
    "tree-sitter-javascript",
    "tree-sitter-kotlin",
    "tree-sitter-python",
    "tree-sitter-rust",
    "tree-sitter-swift",
    "tree-sitter-typescript",
  ]) {
    assert.match(workspace, new RegExp(`["']?${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}['"]?: true`));
  }
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
  assert.equal(packageJson.version, "1.0.2");
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
  assert.match(release, /for attempt in \{1\.\.12\}/);
  assert.match(release, /sleep 10/);
});
