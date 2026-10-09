import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Only inspect installed package directories; never follow links outside the bundle.
function installedPackages(directory) {
  if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return [];
  const packages = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = path.join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      packages.push(...installedPackages(root));
      continue;
    }
    const manifest = path.join(root, "package.json");
    if (fs.existsSync(manifest)) packages.push({ ...JSON.parse(fs.readFileSync(manifest, "utf8")), root });
    packages.push(...installedPackages(path.join(root, "node_modules")));
  }
  return packages;
}

export function pruneReleaseBundle(bundleDir, platform, arch) {
  if (!["darwin-arm64", "darwin-x64", "linux-x64", "windows-x64"].includes(`${platform}-${arch}`)) {
    throw new Error(`Unsupported release target: ${platform}-${arch}`);
  }
  const nativePlatform = platform === "windows" ? "win32" : platform;
  const packages = installedPackages(path.join(bundleDir, "node_modules"));
  // Fail before pruning anything if the native ONNX install is incomplete.
  for (const pkg of packages.filter((pkg) => pkg.name === "onnxruntime-node")) {
    if (!fs.existsSync(path.join(pkg.root, "bin/napi-v6", nativePlatform, arch))) {
      throw new Error(`Missing ONNX target: ${nativePlatform}/${arch} in ${pkg.root}`);
    }
  }
  const removed = [];
  const remove = (file) => {
    fs.rmSync(file, { recursive: true, force: true });
    removed.push(path.relative(bundleDir, file));
  };
  const pruneFiles = (directory, predicate) => {
    if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pruneFiles(file, predicate);
      else if (entry.isFile() && predicate(file)) remove(file);
    }
  };
  for (const pkg of packages) {
    if (pkg.name === "tree-sitter-cli" && pkg.version === "0.23.2") {
      remove(pkg.root);
      const bin = path.join(path.dirname(pkg.root), ".bin");
      for (const name of ["tree-sitter", "tree-sitter.cmd", "tree-sitter.ps1"]) {
        const file = path.join(bin, name);
        if (fs.existsSync(file) || fs.existsSync(bin) && fs.readdirSync(bin).includes(name)) remove(file);
      }
      continue;
    }
    if (pkg.name === "onnxruntime-node") {
      const nativeRoot = path.join(pkg.root, "bin/napi-v6");
      for (const os of fs.readdirSync(nativeRoot, { withFileTypes: true })) {
        if (!os.isDirectory()) continue;
        const osRoot = path.join(nativeRoot, os.name);
        if (os.name !== nativePlatform) remove(osRoot);
        else for (const cpu of fs.readdirSync(osRoot, { withFileTypes: true })) {
          if (cpu.isDirectory() && cpu.name !== arch) remove(path.join(osRoot, cpu.name));
        }
      }
    }
    if (/^tree-sitter(?:-|$)/.test(pkg.name) || pkg.name === "@driftlog/tree-sitter-dart") {
      const prebuilds = path.join(pkg.root, "prebuilds");
      if (fs.existsSync(prebuilds)) for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
        const match = /^(darwin|linux|win32)-(.+)$/.exec(entry.name);
        if (entry.isDirectory() && match && (match[1] !== nativePlatform || !match[2].split("+").includes(arch))) {
          remove(path.join(prebuilds, entry.name));
        }
      }
      // Bindings read node-types.json at runtime. Keep JSON except build-only grammar.json.
      pruneFiles(pkg.root, (file) => !path.relative(pkg.root, file).split(path.sep).includes("node_modules") && (/\.(c|cc|cpp|h|o)$/.test(file) || path.basename(file) === "grammar.json"));
      for (const relative of ["build/Release/obj", "build/Release/obj.target", "build/Debug/obj", "build/Debug/obj.target"]) {
        const file = path.join(pkg.root, relative);
        if (fs.existsSync(file)) remove(file);
      }
    }
    if (["onnxruntime-node", "onnxruntime-web", "@huggingface/transformers"].includes(pkg.name)) {
      pruneFiles(path.join(pkg.root, "dist"), (file) => file.endsWith(".map"));
    }
  }
  const expectedCodeAtlasRoot = path.resolve(bundleDir, "node_modules", "@showdar2112", "code-atlas");
  const codeAtlasPackage = packages.find((pkg) => pkg.name === "@showdar2112/code-atlas" && path.resolve(pkg.root) === expectedCodeAtlasRoot);
  if (codeAtlasPackage) {
    const vendorDirectory = path.join(codeAtlasPackage.root, "vendor");
    const vendorRoot = path.join(codeAtlasPackage.root, "vendor", "parsers");
    const distributionPath = path.join(vendorRoot, "parser-distribution.json");
    if (fs.existsSync(vendorDirectory) && fs.lstatSync(vendorDirectory).isSymbolicLink()) throw new Error("Vendor directory must not be a symlink");
    if (fs.existsSync(vendorRoot) && fs.lstatSync(vendorRoot).isSymbolicLink()) throw new Error("Vendored parser directory must not be a symlink");
    if (fs.existsSync(distributionPath)) {
      if (fs.lstatSync(distributionPath).isSymbolicLink()) throw new Error("Parser distribution manifest must not be a symlink");
      const distribution = JSON.parse(fs.readFileSync(distributionPath, "utf8"));
      if (!Array.isArray(distribution.packages)) throw new Error("Invalid parser distribution manifest: packages must be an array");
      const target = `${nativePlatform}-${arch}`;
      const vendorPackages = distribution.packages.map((record) => {
        if (!record || typeof record !== "object") throw new Error("Invalid parser distribution package record");
        if (typeof record.name !== "string" || !/^(?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(record.name)) {
          throw new Error(`Invalid vendored parser package name: ${record.name}`);
        }
        let packageRoot = vendorRoot;
        for (const part of record.name.split("/")) {
          packageRoot = path.join(packageRoot, part);
          if (!fs.existsSync(packageRoot) || fs.lstatSync(packageRoot).isSymbolicLink()) {
            throw new Error(`Missing or linked vendored parser package: ${record.name}`);
          }
        }
        const hostPrebuilds = record.prebuilds?.[target];
        if (!Array.isArray(hostPrebuilds) || hostPrebuilds.length === 0) {
          throw new Error(`Missing host vendored parser prebuild: ${record.name} (${target})`);
        }
        for (const entry of hostPrebuilds) {
          const prebuild = typeof entry?.file === "string" && /^prebuilds\/(darwin|linux|win32)-([^/]+)\/.+\.node$/.exec(entry.file);
          if (typeof entry?.file !== "string" || !entry.file.endsWith(".node") || entry.file.includes("\\")
            || path.posix.normalize(entry.file) !== entry.file || entry.file.startsWith("../") || path.posix.isAbsolute(entry.file)
            || !prebuild || prebuild[1] !== nativePlatform || !prebuild[2].split("+").includes(arch)) {
            throw new Error(`Invalid host vendored parser prebuild path: ${record.name}`);
          }
          let file = packageRoot;
          for (const part of entry.file.split("/")) {
            file = path.join(file, part);
            if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
              throw new Error(`Missing host vendored parser prebuild: ${record.name} (${target})`);
            }
          }
          if (!fs.statSync(file).isFile()) throw new Error(`Missing host vendored parser prebuild: ${record.name} (${target})`);
        }
        return { record, packageRoot };
      });
      distribution.distributionTarget = target;
      distribution.requiredTargets = [target];
      for (const { record, packageRoot } of vendorPackages) {
        pruneFiles(packageRoot, (file) => !path.relative(packageRoot, file).split(path.sep).includes("node_modules")
          && (/\.(c|cc|cpp|h|o)$/.test(file) || path.basename(file) === "grammar.json"));
        const prebuildRoot = path.join(packageRoot, "prebuilds");
        if (fs.existsSync(prebuildRoot)) {
          if (fs.lstatSync(prebuildRoot).isSymbolicLink()) throw new Error(`Vendored parser prebuilds must not be a symlink: ${record.name}`);
          for (const entry of fs.readdirSync(prebuildRoot, { withFileTypes: true })) {
            const match = /^(darwin|linux|win32)-(.+)$/.exec(entry.name);
            if (entry.isDirectory() && match && (match[1] !== nativePlatform || !match[2].split("+").includes(arch))) {
              remove(path.join(prebuildRoot, entry.name));
            }
          }
        }
        for (const relative of ["build/Release/obj", "build/Release/obj.target", "build/Debug/obj", "build/Debug/obj.target"]) {
          const file = path.join(packageRoot, relative);
          if (fs.existsSync(file)) remove(file);
        }
        const previousPrebuilds = new Map(Object.values(record.prebuilds ?? {}).flat().map((entry) => [entry.file, entry]));
        record.files = {};
        record.prebuilds = {};
        const collectFiles = (directory) => {
          if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Vendored parser directory must not be a symlink: ${directory}`);
          for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) collectFiles(file);
            else if (entry.isFile()) {
              const relative = path.relative(packageRoot, file).split(path.sep).join("/");
              const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
              record.files[relative] = sha256;
              const prebuild = /^prebuilds\/(darwin|linux|win32)-([^/]+)\/(.+\.node)$/.exec(relative);
              if (prebuild && prebuild[1] === nativePlatform && prebuild[2].split("+").includes(arch)) {
                record.prebuilds[target] ??= [];
                const previous = previousPrebuilds.get(relative);
                record.prebuilds[target].push({ file: relative, sha256, ...(previous?.format ? { format: previous.format } : {}) });
              }
            } else throw new Error(`Unsupported vendored parser asset type: ${file}`);
          }
        };
        collectFiles(packageRoot);
        for (const entries of Object.values(record.prebuilds)) entries.sort((left, right) => left.file.localeCompare(right.file));
      }
      fs.writeFileSync(distributionPath, `${JSON.stringify(distribution, null, 2)}\n`);
    }
  }
  return removed;
}

// Swift's CLI dependency is only used by its generation/playground scripts.
export function removeSwiftBuildDependency(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "tree-sitter-swift" || manifest.version !== "0.7.1"
    || manifest.scripts?.install !== "node-gyp-build" || manifest.dependencies?.["tree-sitter-cli"] !== "^0.23") {
    throw new Error("Unaudited tree-sitter-swift runtime manifest");
  }
  delete manifest.dependencies["tree-sitter-cli"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
