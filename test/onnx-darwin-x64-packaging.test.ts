import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installDarwinX64OnnxRuntime, validateDarwinX64NativeBundle, validateDarwinX64OnnxPayload } from "../scripts/onnx-darwin-x64.mjs";
import { assertPinnedOnnxRuntimeSource, createOnnxDarwinX64BuildArguments } from "../scripts/build-onnx-darwin-x64.mjs";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-onnx-x64-"));
  const native = path.join(root, "native");
  fs.mkdirSync(native);
  fs.writeFileSync(path.join(native, "onnxruntime_binding.node"), "binding");
  fs.writeFileSync(path.join(native, "libonnxruntime.1.30.0.dylib"), "runtime");
  if (process.platform === "win32") fs.writeFileSync(path.join(native, "libonnxruntime.1.dylib"), "alias");
  else fs.symlinkSync("libonnxruntime.1.30.0.dylib", path.join(native, "libonnxruntime.1.dylib"));
  return { root, native };
}

function inspectMachO(_command: string, args: string[]) {
  if (args[0] === "-b") return "Mach-O 64-bit bundle x86_64";
  if (args[0] === "-L") return `${args[1]}:\n\t@rpath/libonnxruntime.1.30.0.dylib (compatibility version 1.0.0)`;
  if (args[0] === "-l") return "cmd LC_RPATH\n path @loader_path (offset 12)";
  throw new Error(`Unexpected inspection command: ${args.join(" ")}`);
}

test("Darwin x64 ONNX payload requires the binding, versioned dylib, x64 slices and local loader path", () => {
  const { root, native } = makeFixture();
  try {
    assert.deepEqual(validateDarwinX64OnnxPayload(native, inspectMachO), [
      "libonnxruntime.1.30.0.dylib",
      "libonnxruntime.1.dylib",
      "onnxruntime_binding.node",
    ]);
    assert.throws(() => validateDarwinX64OnnxPayload(native, (command, args) => {
      if (args[0] === "-b") return "Mach-O 64-bit bundle arm64";
      return inspectMachO(command, args);
    }), /x86_64/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned ONNX source build keeps full Node, CoreML, WebGPU and x86_64 runtime features", () => {
  const args = createOnnxDarwinX64BuildArguments("/tmp/onnxruntime", "/tmp/onnx-build", 2);
  const defaultArgs = createOnnxDarwinX64BuildArguments("/tmp/onnxruntime", "/tmp/onnx-build");
  for (const flag of ["--build_nodejs", "--build_shared_lib", "--use_coreml", "--use_webgpu", "--use_vcpkg"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.ok(args.includes("CMAKE_OSX_ARCHITECTURES=x86_64"));
  assert.ok(args.includes("--skip_tests"));
  assert.ok(args.includes("--skip_nodejs_tests"));
  assert.equal(args.includes("--minimal_build"), false);
  assert.equal(args.includes("--disable_contrib_ops"), false);
  assert.equal(defaultArgs[defaultArgs.indexOf("--parallel") + 1], "0");
});

test("source build rejects any checkout outside the pinned ONNX Runtime commit", () => {
  const { root } = makeFixture();
  try {
    assert.throws(() => assertPinnedOnnxRuntimeSource(root, () => "deadbeef"), /Expected ONNX Runtime source commit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin x64 ONNX payload copies into every installed ONNX package, including nested copies", () => {
  const { root, native } = makeFixture();
  const bundle = path.join(root, "bundle");
  const packageDirs = [
    path.join(bundle, "node_modules/onnxruntime-node"),
    path.join(bundle, "node_modules/@showdar2112/code-atlas/node_modules/onnxruntime-node"),
  ];
  try {
    for (const packageDir of packageDirs) {
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.30.0" }));
    }
    const installed = installDarwinX64OnnxRuntime(bundle, native, inspectMachO);
    assert.equal(installed, 2);
    for (const packageDir of packageDirs) {
      for (const file of ["onnxruntime_binding.node", "libonnxruntime.1.30.0.dylib", "libonnxruntime.1.dylib"]) {
        assert.equal(fs.readFileSync(path.join(packageDir, "bin/napi-v6/darwin/x64", file), "utf8"), fs.readFileSync(path.join(native, file), "utf8"));
      }
      if (process.platform !== "win32") {
        assert.equal(fs.readlinkSync(path.join(packageDir, "bin/napi-v6/darwin/x64/libonnxruntime.1.dylib")), "libonnxruntime.1.30.0.dylib");
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin x64 bundle scan resolves native dependencies and permits universal x64 binaries", () => {
  const { root } = makeFixture();
  const bundle = path.join(root, "bundle");
  const nativeDir = path.join(bundle, "node_modules/example/build/Release");
  const binding = path.join(nativeDir, "addon.node");
  const library = path.join(nativeDir, "libexample.dylib");
  const runtime = path.join(bundle, "runtime/node");
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  fs.writeFileSync(binding, "binding");
  fs.writeFileSync(library, "library");
  fs.writeFileSync(runtime, "node");
  const inspect = (_command: string, args: string[]) => {
    if (args[0] === "-b") return "Mach-O universal binary with 2 architectures: [x86_64] [arm64]";
    if (args[0] === "-L") {
      const file = args[1];
      return file === binding
        ? `${file}:\n\t@rpath/libexample.dylib (compatibility version 1.0.0)`
        : `${file}:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)`;
    }
    if (args[0] === "-l") return args[1] === binding ? "cmd LC_RPATH\n path @loader_path (offset 12)" : "";
    throw new Error(`Unexpected inspection command: ${args.join(" ")}`);
  };
  try {
    assert.deepEqual(validateDarwinX64NativeBundle(bundle, inspect), [
      "node_modules/example/build/Release/addon.node",
      "node_modules/example/build/Release/libexample.dylib",
      "runtime/node",
    ]);
    assert.throws(() => validateDarwinX64NativeBundle(bundle, (_command, args) => {
      if (args[0] === "-b") return "Mach-O 64-bit bundle arm64";
      return inspect("", args);
    }), /x86_64/);
    assert.throws(() => validateDarwinX64NativeBundle(bundle, (_command, args) => {
      if (args[0] === "-L" && args[1] === binding) {
        return `${binding}:\n\t${path.join(root, "native/libonnxruntime.1.30.0.dylib")} (compatibility version 1.0.0)`;
      }
      return inspect("", args);
    }), /Unresolved native dependency/);
    assert.deepEqual(validateDarwinX64NativeBundle(bundle, (_command, args) => {
      if (args[0] === "-L" && args[1] === binding) {
        return `${binding}:\n\t${library} (compatibility version 1.0.0)`;
      }
      return inspect("", args);
    }), [
      "node_modules/example/build/Release/addon.node",
      "node_modules/example/build/Release/libexample.dylib",
      "runtime/node",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin x64 bundle scan requires the bundled Node executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-onnx-x64-empty-bundle-"));
  try {
    assert.throws(() => validateDarwinX64NativeBundle(root), /missing its bundled Node runtime/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Darwin x64 ONNX overlay fails closed for absent native payloads or incompatible ONNX versions", () => {
  const { root, native } = makeFixture();
  const bundle = path.join(root, "bundle");
  const packageDir = path.join(bundle, "node_modules/onnxruntime-node");
  try {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.30.0" }));
    assert.throws(() => installDarwinX64OnnxRuntime(bundle, path.join(root, "missing"), inspectMachO), /native payload/);
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "onnxruntime-node", version: "1.29.0" }));
    assert.throws(() => installDarwinX64OnnxRuntime(bundle, native, inspectMachO), /requires onnxruntime-node@1.30.0/);
    assert.equal(fs.existsSync(path.join(packageDir, "bin/napi-v6/darwin/x64")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
