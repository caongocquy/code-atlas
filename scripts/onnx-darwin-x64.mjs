import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ONNX_RUNTIME_VERSION = "1.30.0";
export const ONNX_RUNTIME_SOURCE_COMMIT = "f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7";
export const DARWIN_X64_MINIMUM_VERSION = "13.5";

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout.trim();
}

function nativeFiles(nativeDir) {
  const rootStat = fs.lstatSync(nativeDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`ONNX native payload must be a real directory: ${nativeDir}`);
  }
  const realRoot = fs.realpathSync(nativeDir);
  const files = [];
  for (const entry of fs.readdirSync(nativeDir, { withFileTypes: true })) {
    if (entry.isDirectory()) throw new Error(`Unexpected directory in ONNX native payload: ${entry.name}`);
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const file = path.join(nativeDir, entry.name);
    const realFile = fs.realpathSync(file);
    if (!realFile.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(realFile).isFile()) {
      throw new Error(`ONNX native payload path escapes its directory: ${entry.name}`);
    }
    if (entry.name.endsWith(".node") || entry.name.endsWith(".dylib")) files.push(entry.name);
  }
  return files.sort();
}

function containedRealFile(root, file) {
  if (!fs.existsSync(file)) return false;
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  return realFile.startsWith(`${realRoot}${path.sep}`) && fs.statSync(realFile).isFile();
}

function minimumMacOSVersions(loadCommands) {
  const versions = [];
  for (const block of loadCommands.split(/(?=Load command \d+)/)) {
    if (/^\s*cmd LC_BUILD_VERSION\s*$/m.test(block)) {
      const match = /^\s*minos\s+(\d+(?:\.\d+){1,2})\s*$/m.exec(block);
      if (match) versions.push(match[1]);
    } else if (/^\s*cmd LC_VERSION_MIN_MACOSX\s*$/m.test(block)) {
      const match = /^\s*version\s+(\d+(?:\.\d+){1,2})\s*$/m.exec(block);
      if (match) versions.push(match[1]);
    }
  }
  return versions;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateMacOSMinimum(binary, loadCommands) {
  const versions = minimumMacOSVersions(loadCommands);
  if (versions.length === 0) {
    throw new Error(`Native binary has no macOS deployment target metadata: ${binary}`);
  }
  const tooNew = versions.filter((version) => compareVersions(version, DARWIN_X64_MINIMUM_VERSION) > 0);
  if (tooNew.length > 0) {
    throw new Error(
      `Native binary ${binary} targets macOS ${[...new Set(tooNew)].join(", ")}, above bundled Node floor ${DARWIN_X64_MINIMUM_VERSION}`,
    );
  }
}

export function validateDarwinX64OnnxPayload(nativeDir, runCapture = capture) {
  if (!fs.existsSync(nativeDir)) throw new Error(`Missing ONNX native payload: ${nativeDir}`);
  const files = nativeFiles(nativeDir);
  const fileSet = new Set(files);
  for (const required of [
    "onnxruntime_binding.node",
    `libonnxruntime.${ONNX_RUNTIME_VERSION}.dylib`,
    "libonnxruntime.1.dylib",
  ]) {
    if (!fileSet.has(required)) throw new Error(`ONNX native payload is missing ${required}`);
  }

  for (const file of files) {
    const binary = path.join(nativeDir, file);
    const description = runCapture("file", ["-b", "-L", binary]);
    if (!/\bx86_64\b/.test(description) || /\barm64\b/.test(description)) {
      throw new Error(`ONNX native file is not x86_64: ${file} (${description})`);
    }
    const loadCommands = runCapture("otool", ["-arch", "x86_64", "-l", binary]);
    validateMacOSMinimum(file, loadCommands);
    const dependencies = runCapture("otool", ["-arch", "x86_64", "-L", binary]).split("\n").slice(1);
    for (const line of dependencies) {
      const dependency = line.trim().split(" (")[0];
      if (dependency.startsWith("@rpath/")) {
        const name = path.basename(dependency);
        if (!fileSet.has(name)) throw new Error(`ONNX dependency ${dependency} is missing from native payload`);
      } else if (dependency.startsWith("@loader_path/")) {
        const resolved = path.resolve(nativeDir, dependency.slice("@loader_path/".length));
        if (!containedRealFile(nativeDir, resolved)) {
          throw new Error(`ONNX dependency ${dependency} is missing from or escapes the native payload`);
        }
      } else if (!dependency.startsWith("/usr/lib/") && !dependency.startsWith("/System/Library/")) {
        throw new Error(`Unexpected external ONNX dependency: ${dependency}`);
      }
    }
  }

  const bindingLoadCommands = runCapture("otool", ["-arch", "x86_64", "-l", path.join(nativeDir, "onnxruntime_binding.node")]);
  if (!/cmd LC_RPATH[\s\S]*?path\s+@loader_path(?:\s|\()/m.test(bindingLoadCommands)) {
    throw new Error("ONNX Node binding does not load its dylib from @loader_path");
  }
  return files;
}

function findOnnxPackages(directory, found = []) {
  if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      findOnnxPackages(root, found);
      continue;
    }
    const manifestPath = path.join(root, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === "onnxruntime-node") found.push({ root, version: manifest.version });
    }
    findOnnxPackages(path.join(root, "node_modules"), found);
  }
  return found;
}

export function installDarwinX64OnnxRuntime(bundleDir, nativeDir, runCapture = capture) {
  validateDarwinX64OnnxPayload(nativeDir, runCapture);
  const packages = findOnnxPackages(path.join(bundleDir, "node_modules"));
  if (packages.length === 0) throw new Error("Portable bundle does not contain onnxruntime-node");
  for (const pkg of packages) {
    if (pkg.version !== ONNX_RUNTIME_VERSION) {
      throw new Error(`Darwin x64 ONNX runtime requires onnxruntime-node@${ONNX_RUNTIME_VERSION}; found ${pkg.version}`);
    }
    const target = path.join(pkg.root, "bin/napi-v6/darwin/x64");
    if (fs.existsSync(target) || fs.existsSync(path.dirname(target)) && fs.lstatSync(path.dirname(target)).isSymbolicLink()) {
      throw new Error(`Refusing to replace an existing ONNX x64 target: ${target}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(nativeDir, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  return packages.length;
}

function bundleNativeFiles(bundleDir) {
  const root = fs.realpathSync(bundleDir);
  const files = [];
  const visit = (directory) => {
    if (fs.lstatSync(directory).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:node|dylib)$/.test(entry.name)) {
        const realFile = fs.realpathSync(file);
        if (!realFile.startsWith(`${root}${path.sep}`) || !fs.statSync(realFile).isFile()) {
          throw new Error(`Native bundle path escapes the release bundle: ${path.relative(root, file)}`);
        }
        files.push(file);
      }
    }
  };
  visit(bundleDir);
  const runtime = path.join(bundleDir, "runtime", "node");
  if (!containedRealFile(bundleDir, runtime)) {
    throw new Error("Darwin x64 release bundle is missing its bundled Node runtime or it escapes the bundle");
  }
  if (!files.includes(runtime)) files.push(runtime);
  return files.sort();
}

function rpathsFrom(loadCommands) {
  const paths = [];
  for (const block of loadCommands.split(/(?=Load command \d+)/)) {
    if (!/\bcmd LC_RPATH\b/.test(block)) continue;
    const match = /^\s*path\s+(.+?)\s+\(offset \d+\)/m.exec(block);
    if (match) paths.push(match[1]);
  }
  return paths;
}

function resolveLoadPath(loadPath, binary, bundleDir, rpaths) {
  const binaryDir = path.dirname(binary);
  if (loadPath.startsWith("@loader_path/")) return [path.resolve(binaryDir, loadPath.slice("@loader_path/".length))];
  if (loadPath.startsWith("@executable_path/")) {
    return [path.resolve(bundleDir, "runtime", loadPath.slice("@executable_path/".length))];
  }
  if (!loadPath.startsWith("@rpath/")) return [loadPath];
  const suffix = loadPath.slice("@rpath/".length);
  return rpaths.map((rpath) => {
    if (rpath.startsWith("@loader_path")) {
      return path.resolve(binaryDir, rpath.slice("@loader_path".length).replace(/^\//, ""), suffix);
    }
    if (rpath.startsWith("@executable_path")) {
      return path.resolve(bundleDir, "runtime", rpath.slice("@executable_path".length).replace(/^\//, ""), suffix);
    }
    if (path.isAbsolute(rpath)) return path.resolve(rpath, suffix);
    return null;
  }).filter(Boolean);
}

function isSystemPath(file) {
  return file.startsWith("/usr/lib/") || file.startsWith("/System/Library/");
}

function isBundledPath(file, bundleDir) {
  return containedRealFile(bundleDir, file);
}

export function validateDarwinX64NativeBundle(bundleDir, runCapture = capture) {
  const files = bundleNativeFiles(bundleDir);
  for (const binary of files) {
    const description = runCapture("file", ["-b", "-L", binary]);
    if (!/\bx86_64\b/.test(description)) {
      throw new Error(`Native bundle file does not support x86_64: ${path.relative(bundleDir, binary)} (${description})`);
    }
    const loadCommands = runCapture("otool", ["-arch", "x86_64", "-l", binary]);
    validateMacOSMinimum(path.relative(bundleDir, binary), loadCommands);
    const rpaths = rpathsFrom(loadCommands);
    const dependencies = runCapture("otool", ["-arch", "x86_64", "-L", binary]).split("\n").slice(1);
    for (const line of dependencies) {
      const dependency = line.trim().split(" (")[0];
      if (!dependency) continue;
      const candidates = resolveLoadPath(dependency, binary, bundleDir, rpaths);
      if (!candidates.some((candidate) => isSystemPath(candidate) || isBundledPath(candidate, bundleDir))) {
        throw new Error(`Unresolved native dependency ${dependency} from ${path.relative(bundleDir, binary)}`);
      }
    }
  }
  return files.map((file) => path.relative(bundleDir, file).split(path.sep).join("/"));
}
