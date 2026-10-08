import assert from "node:assert/strict";
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
