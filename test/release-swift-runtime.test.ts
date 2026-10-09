import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as pruning from "../scripts/prune-release-bundle.mjs";

function npm(args: string[], cwd: string) {
  const cli = path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  return process.platform === "win32"
    ? spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30_000 })
    : spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 30_000 });
}

test("portable Swift override removes the download-only CLI before install while native lifecycle scripts still run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-swift-runtime-"));
  const manifest = {
    name: "tree-sitter-swift", version: "0.7.1", main: "bindings/node/index.js",
    scripts: { install: "node-gyp-build" },
    dependencies: { "node-gyp-build": "^4.8.0", "tree-sitter-cli": "^0.23", "node-addon-api": "^8.0.0", which: "2.0.2" },
  };
  try {
    for (const name of ["cli", "swift", "consumer", "bundle"]) fs.mkdirSync(path.join(root, name));
    const write = (relative: string, value: unknown) => fs.writeFileSync(path.join(root, relative), typeof value === "string" ? value : JSON.stringify(value));
    const pack = (name: string) => {
      const result = npm(["pack", "--json", "--pack-destination", root], path.join(root, name));
      assert.equal(result.status, 0, result.stderr);
      return path.join(root, JSON.parse(result.stdout)[0].filename);
    };
    write("cli/package.json", { name: "tree-sitter-cli", version: "0.23.2", scripts: { install: "node install.js" } });
    write("cli/install.js", "throw new Error('HTTP 500 downloading tree-sitter-macos-x64.gz')");
    const cliArchive = pack("cli");
    const fixtureManifest = { ...manifest, scripts: { install: "node install.js" }, dependencies: { "tree-sitter-cli": `file:${cliArchive}` } };
    write("swift/package.json", fixtureManifest);
    write("swift/install.js", "require('node:fs').writeFileSync('native-install-ran', 'installed')");
    write("swift/parser.node", "unchanged native parser bytes");
    write("swift/node-types.json", "[]");
    const beforeArchive = pack("swift");
    write("consumer/package.json", { name: "test-consumer", version: "1.0.0", dependencies: { "tree-sitter-swift": "0.7.1" } });
    const consumer = pack("consumer");
    const install = (swift: string) => {
      write("bundle/package.json", { private: true, overrides: { "tree-sitter-swift@0.7.1": `file:${swift}` } });
      return npm(["install", "--omit=dev", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", consumer], path.join(root, "bundle"));
    };
    const before = install(beforeArchive);
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /HTTP 500 downloading/);
    // Validate the audited upstream contract separately from the offline lifecycle fixture.
    write("swift/package.json", manifest);
    pruning.removeSwiftBuildDependency(path.join(root, "swift"));
    const patched = JSON.parse(fs.readFileSync(path.join(root, "swift/package.json"), "utf8"));
    assert.deepEqual(patched, { ...manifest, dependencies: { "node-gyp-build": "^4.8.0", "node-addon-api": "^8.0.0", which: "2.0.2" } });
    assert.equal(fs.readFileSync(path.join(root, "swift/parser.node"), "utf8"), "unchanged native parser bytes");
    write("swift/package.json", { ...patched, scripts: fixtureManifest.scripts, dependencies: {} });
    fs.rmSync(path.join(root, "bundle"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "bundle"));
    const after = install(pack("swift"));
    assert.equal(after.status, 0, after.stderr);
    const installed = path.join(root, "bundle/node_modules/tree-sitter-swift");
    assert.equal(fs.readFileSync(path.join(installed, "native-install-ran"), "utf8"), "installed");
    assert.equal(fs.readFileSync(path.join(installed, "parser.node"), "utf8"), "unchanged native parser bytes");
    assert.equal(fs.readFileSync(path.join(installed, "node-types.json"), "utf8"), "[]");
    assert.equal(fs.existsSync(path.join(root, "bundle/node_modules/tree-sitter-cli")), false);
    for (const changed of [{ ...manifest, version: "0.8.0" }, { ...manifest, scripts: { install: "tree-sitter generate" } }]) {
      write("swift/package.json", changed);
      assert.throws(() => pruning.removeSwiftBuildDependency(path.join(root, "swift")), /Unaudited/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
