#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ONNX_RUNTIME_SOURCE_COMMIT,
  ONNX_RUNTIME_VERSION,
  validateDarwinX64OnnxPayload,
} from "./onnx-darwin-x64.mjs";

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

export function createOnnxDarwinX64BuildArguments(sourceDir, buildDir, parallel = 0) {
  return [
    path.join(sourceDir, "tools/ci_build/build.py"),
    "--build_dir", buildDir,
    "--update",
    "--build",
    "--build_nodejs",
    "--build_shared_lib",
    "--use_coreml",
    "--use_webgpu",
    "--use_vcpkg",
    "--config", "Release",
    "--parallel", String(parallel),
    "--skip_submodule_sync",
    "--skip_tests",
    "--skip_nodejs_tests",
    "--cmake_extra_defines", "CMAKE_OSX_ARCHITECTURES=x86_64",
  ];
}

export function assertPinnedOnnxRuntimeSource(sourceDir, runCapture = capture) {
  const commit = runCapture("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
  if (commit !== ONNX_RUNTIME_SOURCE_COMMIT) {
    throw new Error(`Expected ONNX Runtime source commit ${ONNX_RUNTIME_SOURCE_COMMIT}; found ${commit}`);
  }
  const version = fs.readFileSync(path.join(sourceDir, "VERSION_NUMBER"), "utf8").trim();
  if (version !== ONNX_RUNTIME_VERSION) {
    throw new Error(`Expected ONNX Runtime ${ONNX_RUNTIME_VERSION} source; found ${version}`);
  }
  const submodules = runCapture("git", ["-C", sourceDir, "submodule", "status", "--recursive"]);
  if (submodules.split("\n").some((line) => /^[+-U]/.test(line))) {
    throw new Error("ONNX Runtime source submodules are missing or differ from the pinned commit");
  }
}

function assertBuildTools() {
  if (process.platform !== "darwin" || process.arch !== "x64") {
    throw new Error("The ONNX Runtime x64 build must run under x86_64 macOS Node.js");
  }
  if (Number(process.versions.node.split(".")[0]) < 22) {
    throw new Error(`ONNX Runtime build requires Node.js 22 or newer; found ${process.version}`);
  }
  const python = capture("python3", ["--version"]);
  if (!/^Python 3\.12\./.test(python)) throw new Error(`ONNX Runtime build requires Python 3.12; found ${python}`);
  const cmake = capture("cmake", ["--version"]);
  if (!/^cmake version 3\.31\.8(?:\s|$)/.test(cmake)) {
    throw new Error(`ONNX Runtime build requires CMake 3.31.8; found ${cmake.split("\n")[0]}`);
  }
}

export function buildDarwinX64OnnxRuntime(sourceDir, outputDir) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (!fs.existsSync(path.join(source, "tools/ci_build/build.py"))) {
    throw new Error(`ONNX Runtime source checkout is missing: ${source}`);
  }
  if (fs.existsSync(output)) throw new Error(`ONNX output directory already exists: ${output}`);
  assertBuildTools();
  assertPinnedOnnxRuntimeSource(source);

  const sourcePayload = path.join(source, "js/node/bin/napi-v6/darwin/x64");
  if (fs.existsSync(sourcePayload)) throw new Error(`ONNX source payload already exists: ${sourcePayload}`);

  const temporaryBuild = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-onnx-x64-build-"));
  try {
    run("python3", createOnnxDarwinX64BuildArguments(source, path.join(temporaryBuild, "build")), { cwd: source });
    const files = validateDarwinX64OnnxPayload(sourcePayload);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.cpSync(sourcePayload, output, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      verbatimSymlinks: true,
    });
    validateDarwinX64OnnxPayload(output);
    console.log(`Built ONNX Runtime ${ONNX_RUNTIME_VERSION} for Darwin x64 (${files.join(", ")})`);
  } finally {
    fs.rmSync(temporaryBuild, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [sourceDir, outputDir, ...extra] = process.argv.slice(2);
  if (!sourceDir || !outputDir || extra.length > 0) {
    console.error("Usage: node scripts/build-onnx-darwin-x64.mjs <onnxruntime-source> <native-output-dir>");
    process.exit(2);
  }
  try {
    buildDarwinX64OnnxRuntime(sourceDir, outputDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
