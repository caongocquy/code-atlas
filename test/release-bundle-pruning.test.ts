import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Packaging scripts run directly in Node rather than through the TypeScript build.
import { pruneReleaseBundle } from "../scripts/prune-release-bundle.mjs";

test("portable pruning preserves runtime metadata and target binaries in nested packages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-prune-"));
  const put = (relative: string, contents = "kept") => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const grammar = "node_modules/@showdar2112/code-atlas/node_modules/tree-sitter-typescript";
  const ort = "node_modules/onnxruntime-node";
  try {
    put(`${grammar}/package.json`, JSON.stringify({ name: "tree-sitter-typescript" }));
    for (const file of ["bindings/node/index.js", "typescript/src/node-types.json", "tsx/src/node-types.json", "prebuilds/darwin-x64+arm64/addon.node", "build/Release/addon.node", "LICENSE"]) put(`${grammar}/${file}`);
    for (const file of ["typescript/src/parser.c", "tsx/src/scanner.cc", "typescript/src/grammar.json", "prebuilds/linux-x64/addon.node", "build/Release/obj.target/addon.o"]) put(`${grammar}/${file}`);
    put(`${ort}/package.json`, JSON.stringify({ name: "onnxruntime-node" }));
    put(`${ort}/bin/napi-v6/darwin/arm64/addon.node`);
    put(`${ort}/bin/napi-v6/darwin/arm64/libonnxruntime.dylib`);
    put(`${ort}/bin/napi-v6/win32/x64/addon.node`);
    put(`${ort}/dist/index.js`);
    put(`${ort}/dist/index.js.map`);
    put("node_modules/onnxruntime-web/package.json", JSON.stringify({ name: "onnxruntime-web" }));
    put("node_modules/onnxruntime-web/dist/runtime.wasm");
    put("node_modules/onnxruntime-web/dist/index.mjs");
    put("node_modules/onnxruntime-web/dist/index.mjs.map");
    put("node_modules/tree-sitter-cli/package.json", JSON.stringify({ name: "tree-sitter-cli", version: "0.23.2" }));
    put("node_modules/tree-sitter-cli/tree-sitter");
    put("node_modules/.bin/tree-sitter.cmd");
    put("node_modules/unrelated/package.json", JSON.stringify({ name: "unrelated" }));
    put("node_modules/unrelated/src/parser.c");
    put("node_modules/unrelated/index.js.map");
    fs.symlinkSync(path.join(root, "node_modules/unrelated"), path.join(root, "node_modules/link"), "junction");
    const removed = pruneReleaseBundle(root, "darwin", "arm64");
    assert.ok(removed.length > 0);
    for (const file of ["bindings/node/index.js", "typescript/src/node-types.json", "tsx/src/node-types.json", "prebuilds/darwin-x64+arm64/addon.node", "build/Release/addon.node", "LICENSE"]) assert.ok(fs.existsSync(path.join(root, grammar, file)), file);
    for (const file of ["typescript/src/parser.c", "tsx/src/scanner.cc", "typescript/src/grammar.json", "prebuilds/linux-x64/addon.node", "build/Release/obj.target/addon.o"]) assert.equal(fs.existsSync(path.join(root, grammar, file)), false, file);
    for (const file of [`${ort}/bin/napi-v6/darwin/arm64/addon.node`, `${ort}/bin/napi-v6/darwin/arm64/libonnxruntime.dylib`, `${ort}/dist/index.js`, "node_modules/onnxruntime-web/dist/runtime.wasm", "node_modules/onnxruntime-web/dist/index.mjs", "node_modules/unrelated/src/parser.c", "node_modules/unrelated/index.js.map"]) assert.ok(fs.existsSync(path.join(root, file)), file);
    for (const file of [`${ort}/bin/napi-v6/win32/x64`, `${ort}/dist/index.js.map`, "node_modules/onnxruntime-web/dist/index.mjs.map", "node_modules/tree-sitter-cli", "node_modules/.bin/tree-sitter.cmd"]) assert.equal(fs.existsSync(path.join(root, file)), false, file);
    assert.deepEqual(pruneReleaseBundle(root, "darwin", "arm64"), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pruning scopes vendored parser inventory and files to the release target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-prune-vendor-"));
  const codeAtlas = "node_modules/@showdar2112/code-atlas";
  const vendor = `${codeAtlas}/vendor/parsers`;
  const grammar = `${vendor}/tree-sitter-typescript`;
  const put = (relative: string, contents: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return contents;
  };
  const sha256 = (contents: string) => createHash("sha256").update(contents).digest("hex");
  try {
    put(`${codeAtlas}/package.json`, JSON.stringify({ name: "@showdar2112/code-atlas" }));
    const grammarFiles = {
      "package.json": put(`${grammar}/package.json`, '{"name":"tree-sitter-typescript","version":"0.23.2"}'),
      "bindings/node/index.js": put(`${grammar}/bindings/node/index.js`, "module.exports = {};"),
      "typescript/src/node-types.json": put(`${grammar}/typescript/src/node-types.json`, "[]"),
      "typescript/src/parser.d.ts": put(`${grammar}/typescript/src/parser.d.ts`, "export {};"),
      "typescript/src/parser.js": put(`${grammar}/typescript/src/parser.js`, "export {};"),
      "typescript/src/parser.wasm": put(`${grammar}/typescript/src/parser.wasm`, "wasm"),
      "typescript/src/parser.c": put(`${grammar}/typescript/src/parser.c`, "source"),
      "typescript/src/grammar.json": put(`${grammar}/typescript/src/grammar.json`, "build metadata"),
      "LICENSE": put(`${grammar}/LICENSE`, "license"),
      "prebuilds/darwin-arm64/napi.node": put(`${grammar}/prebuilds/darwin-arm64/napi.node`, "host native"),
      "prebuilds/linux-x64/napi.node": put(`${grammar}/prebuilds/linux-x64/napi.node`, "other native"),
    };
    const files = Object.fromEntries(Object.entries(grammarFiles).map(([file, contents]) => [file, sha256(contents)]));
    const distribution = {
      schemaVersion: 1,
      runtime: "tree-sitter@0.25.1",
      requiredTargets: ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
      packages: [{
        name: "tree-sitter-typescript",
        version: "0.23.2",
        integrity: "sha512-original-archive",
        sourceSha256: "a".repeat(64),
        files,
        prebuilds: {
          "darwin-arm64": [{ file: "prebuilds/darwin-arm64/napi.node", sha256: files["prebuilds/darwin-arm64/napi.node"] }],
          "linux-x64": [{ file: "prebuilds/linux-x64/napi.node", sha256: files["prebuilds/linux-x64/napi.node"] }],
        },
      }],
    };
    const manifestPath = path.join(root, vendor, "parser-distribution.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(distribution, null, 2));

    const unrelatedManifest = put("node_modules/unrelated/vendor/parsers/parser-distribution.json", '{"requiredTargets":["all"]}');
    pruneReleaseBundle(root, "darwin", "arm64");

    for (const file of ["bindings/node/index.js", "typescript/src/node-types.json", "typescript/src/parser.d.ts", "typescript/src/parser.js", "typescript/src/parser.wasm", "LICENSE", "prebuilds/darwin-arm64/napi.node"]) {
      assert.ok(fs.existsSync(path.join(root, grammar, file)), file);
    }
    for (const file of ["typescript/src/parser.c", "typescript/src/grammar.json", "prebuilds/linux-x64/napi.node"]) {
      assert.equal(fs.existsSync(path.join(root, grammar, file)), false, file);
    }

    const pruned = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(pruned.distributionTarget, "darwin-arm64");
    assert.deepEqual(pruned.requiredTargets, ["darwin-arm64"]);
    assert.equal(pruned.packages[0].integrity, distribution.packages[0].integrity);
    assert.equal(pruned.packages[0].sourceSha256, distribution.packages[0].sourceSha256);
    const actualFiles = Object.fromEntries(Object.entries(grammarFiles)
      .filter(([file]) => !["typescript/src/parser.c", "typescript/src/grammar.json", "prebuilds/linux-x64/napi.node"].includes(file))
      .map(([file, contents]) => [file, sha256(contents)]));
    assert.deepEqual(pruned.packages[0].files, actualFiles);
    assert.deepEqual(pruned.packages[0].prebuilds, {
      "darwin-arm64": [{ file: "prebuilds/darwin-arm64/napi.node", sha256: actualFiles["prebuilds/darwin-arm64/napi.node"] }],
    });
    assert.equal(fs.readFileSync(path.join(root, "node_modules/unrelated/vendor/parsers/parser-distribution.json"), "utf8"), unrelatedManifest);
    assert.deepEqual(pruneReleaseBundle(root, "darwin", "arm64"), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pruning rejects invalid vendored package names before changing vendor files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-prune-vendor-name-"));
  const codeAtlas = "node_modules/@showdar2112/code-atlas";
  const vendor = `${codeAtlas}/vendor/parsers`;
  try {
    fs.mkdirSync(path.join(root, codeAtlas), { recursive: true });
    fs.writeFileSync(path.join(root, codeAtlas, "package.json"), JSON.stringify({ name: "@showdar2112/code-atlas" }));
    const parser = path.join(root, vendor, "escape", "parser.c");
    fs.mkdirSync(path.dirname(parser), { recursive: true });
    fs.writeFileSync(parser, "source");
    const manifestPath = path.join(root, vendor, "parser-distribution.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ packages: [{ name: "..\\escape" }] }));

    assert.throws(() => pruneReleaseBundle(root, "darwin", "arm64"), /Invalid vendored parser package name/);
    assert.equal(fs.readFileSync(parser, "utf8"), "source");
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).packages[0].name, "..\\escape");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pruning requires the host vendored parser prebuild before changing vendor files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-prune-vendor-prebuild-"));
  const codeAtlas = "node_modules/@showdar2112/code-atlas";
  const vendor = `${codeAtlas}/vendor/parsers`;
  const grammar = `${vendor}/tree-sitter-typescript`;
  try {
    const packageRoot = path.join(root, grammar);
    fs.mkdirSync(path.join(packageRoot, "prebuilds/linux-x64"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "typescript/src"), { recursive: true });
    fs.mkdirSync(path.join(root, codeAtlas), { recursive: true });
    fs.writeFileSync(path.join(root, codeAtlas, "package.json"), JSON.stringify({ name: "@showdar2112/code-atlas" }));
    fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "tree-sitter-typescript" }));
    fs.writeFileSync(path.join(packageRoot, "prebuilds/linux-x64/addon.node"), "other target");
    fs.writeFileSync(path.join(packageRoot, "typescript/src/parser.c"), "source");
    const manifestPath = path.join(root, vendor, "parser-distribution.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ packages: [{
      name: "tree-sitter-typescript",
      prebuilds: { "linux-x64": [{ file: "prebuilds/linux-x64/addon.node" }] },
    }] }));

    assert.throws(() => pruneReleaseBundle(root, "darwin", "arm64"), /Missing host vendored parser prebuild/);
    assert.equal(fs.readFileSync(path.join(packageRoot, "typescript/src/parser.c"), "utf8"), "source");
    assert.ok(fs.existsSync(path.join(packageRoot, "prebuilds/linux-x64/addon.node")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("pruning rejects unsupported targets and missing ONNX target before removing files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-prune-"));
  try {
    const ort = path.join(root, "node_modules/onnxruntime-node");
    fs.mkdirSync(path.join(ort, "bin/napi-v6/linux/x64"), { recursive: true });
    fs.writeFileSync(path.join(ort, "package.json"), JSON.stringify({ name: "onnxruntime-node" }));
    assert.throws(() => pruneReleaseBundle(root, "linux", "arm64"), /Unsupported/);
    assert.throws(() => pruneReleaseBundle(root, "windows", "x64"), /ONNX target/);
    assert.ok(fs.existsSync(path.join(ort, "bin/napi-v6/linux/x64")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [platform, arch, nativePlatform] of [["darwin", "x64", "darwin"], ["linux", "x64", "linux"], ["windows", "x64", "win32"]]) {
  test(`pruning keeps the native target for ${platform}-${arch}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-prune-"));
    try {
      const ort = path.join(root, "node_modules/onnxruntime-node");
      fs.mkdirSync(ort, { recursive: true });
      fs.writeFileSync(path.join(ort, "package.json"), JSON.stringify({ name: "onnxruntime-node" }));
      for (const osName of ["darwin", "linux", "win32"]) for (const cpu of ["arm64", "x64"]) {
        const directory = path.join(ort, "bin/napi-v6", osName, cpu);
        fs.mkdirSync(directory, { recursive: true });
        for (const asset of ["onnxruntime_binding.node", "libonnxruntime.dylib", "libonnxruntime.so.1", "onnxruntime.dll", "onnxruntime_providers_shared.dll", "libonnxruntime_providers_cuda.so"]) {
          fs.writeFileSync(path.join(directory, asset), "native");
        }
      }
      const web = path.join(root, "node_modules/onnxruntime-web");
      fs.mkdirSync(path.join(web, "dist"), { recursive: true });
      fs.writeFileSync(path.join(web, "package.json"), JSON.stringify({ name: "onnxruntime-web" }));
      const wasmAssets = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.mjs", "ort.webgpu.mjs", "ort.node.min.mjs"];
      for (const asset of wasmAssets) fs.writeFileSync(path.join(web, "dist", asset), "runtime");
      pruneReleaseBundle(root, platform, arch);
      for (const asset of wasmAssets) assert.equal(fs.readFileSync(path.join(web, "dist", asset), "utf8"), "runtime", asset);
      for (const asset of ["onnxruntime_binding.node", "libonnxruntime.dylib", "libonnxruntime.so.1", "onnxruntime.dll", "onnxruntime_providers_shared.dll", "libonnxruntime_providers_cuda.so"]) {
        assert.equal(fs.readFileSync(path.join(ort, "bin/napi-v6", nativePlatform, arch, asset), "utf8"), "native", asset);
      }
      for (const osName of ["darwin", "linux", "win32"]) for (const cpu of ["arm64", "x64"]) {
        assert.equal(fs.existsSync(path.join(ort, "bin/napi-v6", osName, cpu)), osName === nativePlatform && cpu === arch);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
