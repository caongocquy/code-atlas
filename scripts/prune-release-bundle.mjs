import fs from "node:fs";
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
  return removed;
}
