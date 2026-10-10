import assert from "node:assert/strict";
import console from "node:console";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

export const APPROVALS = { "onnxruntime-node": "1.30.0", protobufjs: "7.6.6" };
const COMPILER_TOOLS = new Set(["node-gyp", "cc", "gcc", "c++", "g++", "clang", "clang++", "make", "cmake", "python", "python3", "cl", "msbuild"]);
const PARSER_PACKAGES = /^(?:tree-sitter(?:-.+)?|@driftlog\/tree-sitter-dart)$/;
const EXPECTED = {
  "tree-sitter": "0.25.1",
  "tree-sitter-typescript": "0.23.2",
  "tree-sitter-javascript": "0.25.0",
  "tree-sitter-python": "0.25.0",
  "tree-sitter-java": "0.23.5",
  "tree-sitter-kotlin": "0.3.8",
  "tree-sitter-go": "0.25.0",
  "tree-sitter-rust": "0.24.0",
  "tree-sitter-swift": "0.7.1",
  "tree-sitter-c": "0.24.1",
  "tree-sitter-cpp": "0.23.4",
  "@driftlog/tree-sitter-dart": "1.0.4",
};
const SAMPLES = {
  "a.ts": "export function value(): number { return 1; }",
  "a.tsx": "export const Page = () => <div />;",
  "a.js": "export function value() { return 1; }",
  "a.py": "def value():\n    return 1\n",
  "a.java": "class Value { int value() { return 1; } }",
  "a.kt": "fun value(): Int { return 1 }",
  "a.go": "package main\nfunc value() int { return 1 }",
  "a.rs": "fn value() -> i32 { 1 }",
  "a.swift": "func value() -> Int { return 1 }",
  "a.dart": "int value() { return 1; }",
  "a.c": "int value(void) { return 1; }",
  "a.cpp": "int value() { return 1; }",
};

export function supportsNpmAllowScripts(version) {
  return Number.parseInt(String(version).split(".")[0], 10) >= 11;
}

export function npmConfigFiles(root) {
  return {
    user: path.join(root, "empty-user.npmrc"),
    global: path.join(root, "empty-global.npmrc"),
  };
}

export function createConsumerConfig({ manager, mode, tarball }) {
  assert.ok(["npm", "pnpm"].includes(manager), "manager must be npm or pnpm");
  assert.ok(["default", "approved"].includes(mode), "mode must be default or approved");
  const manifest = {
    name: "code-atlas-parser-consumer",
    version: "1.0.0",
    private: true,
    dependencies: { "@showdar2112/code-atlas": `file:${path.resolve(tarball)}` },
  };
  if (manager === "npm" && mode === "approved") {
    manifest.allowScripts = Object.fromEntries(Object.entries(APPROVALS).map(([name, version]) => [`${name}@${version}`, true]));
  }
  const pnpmWorkspace = manager === "pnpm"
    ? ["sideEffectsCache: false", ...(mode === "approved" ? ["allowBuilds:", ...Object.keys(APPROVALS).map((name) => `  ${JSON.stringify(name)}: true`)] : [])].join("\n") + "\n"
    : undefined;
  return { manifest, pnpmWorkspace };
}

export function isBlockedCompilerCommand(command) {
  return String(command).toLowerCase().replaceAll("\\", "/").split(/[\s"']+/).filter(Boolean).some((token) =>
    COMPILER_TOOLS.has(token.split("/").at(-1).replace(/\.(exe|cmd|bat)$/i, "")),
  );
}

export function classifyInstallLog(log) {
  const lines = String(log).split(/\r?\n/).filter(Boolean);
  return {
    peerWarnings: lines.filter((line) => /(?:npm\s+(?:warn|error).*\b(?:ERESOLVE|peer)\b|\bWARN\b.*\bpeer dependencies?\b|\b(?:unmet peer|invalid peer|peer dependency conflict)\b)/i.test(line)),
    compilationWarnings: lines.filter((line) => /(?:gyp (?:info|ERR!) using node-gyp|node-gyp(?:\.cmd)? rebuild|\b(?:CC|CXX)\(target\)|\b(?:gcc|g\+\+|clang(?:\+\+)?|cl\.exe|msbuild|make|cmake)\b.*(?:\berror\b|\bwarning\b)|\bwarning:\s)/i.test(line)),
    lifecyclePolicyWarnings: lines.filter((line) => /(?:npm\s+(?:warn|error)\s+install-scripts|ERR_PNPM_IGNORED_BUILDS|ignored build scripts)/i.test(line)),
    nativePrebuildErrors: lines.filter((line) => /No native build (?:was )?found/i.test(line)),
    deprecatedWarnings: lines.filter((line) => /\bdeprecated\b/i.test(line)),
  };
}

export function approvedLogFindings(log) {
  const classified = classifyInstallLog(log);
  return [...classified.peerWarnings, ...classified.compilationWarnings, ...classified.lifecyclePolicyWarnings, ...classified.nativePrebuildErrors];
}

export function assertProductionParserGraph(manifest, graph) {
  if (manifest.dependencies?.["node-gyp-build"] !== "4.8.4") throw new Error("Production node-gyp-build must remain pinned at 4.8.4");
  if (!graph || typeof graph !== "object" || (Array.isArray(graph) && graph.length === 0) || Object.keys(graph).length === 0) throw new Error("Dependency graph JSON is missing or empty");
  const edges = [];
  const packages = new Set();
  const visit = (value, trail = []) => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, trail);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.name === "string") packages.add(value.name);
    if (typeof value.name === "string" && PARSER_PACKAGES.test(value.name)) {
      edges.push(`${[...trail, value.name].join(" -> ")}${value.peer ? " (peer edge)" : ""}`);
    }
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const children = value[section];
      if (!children || typeof children !== "object") continue;
      for (const [name, child] of Object.entries(children)) {
        packages.add(name);
        if (PARSER_PACKAGES.test(name)) edges.push(`${[...trail, section, name].join(" -> ")}${child?.peer ? " (peer edge)" : ""}`);
        visit(child, [...trail, name]);
      }
    }
  };
  visit(graph);
  if (edges.length) throw new Error(`Production parser package edges remain: ${edges.join(", ")}`);
  if (!packages.has("@showdar2112/code-atlas") || !packages.has("node-gyp-build")) {
    throw new Error("Dependency graph is missing the installed CodeAtlas package or node-gyp-build runtime");
  }
  return true;
}

export function assertApprovedEvidence({ install, parser, graph, installLog, manifest, graphJson }) {
  if (install.exitCode !== 0) throw new Error(`Approved consumer install failed with exit ${install.exitCode}`);
  if (parser?.exitCode !== 0) throw new Error(`Installed parser smoke failed with exit ${parser?.exitCode ?? "not run"}`);
  if (graph?.exitCode !== 0) throw new Error(`Dependency graph command failed with exit ${graph?.exitCode ?? "not run"}`);
  const findings = approvedLogFindings(installLog);
  if (findings.length) throw new Error(`Approved install log contains peer, lifecycle-policy, missing-prebuild, or compilation findings: ${findings.join(" | ")}`);
  assertProductionParserGraph(manifest, graphJson);
  return true;
}

function argsFrom(argv) {
  const result = { tarball: undefined, manager: undefined, mode: undefined, evidenceDir: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manager") result.manager = argv[++i];
    else if (arg === "--mode") result.mode = argv[++i];
    else if (arg === "--evidence-dir") result.evidenceDir = argv[++i];
    else if (!arg.startsWith("-")) result.tarball ??= arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  assert.ok(result.tarball, "usage: node scripts/test-parser-consumer.mjs <tarball> --manager npm|pnpm --mode default|approved --evidence-dir DIR");
  assert.ok(["npm", "pnpm"].includes(result.manager), "--manager must be npm or pnpm");
  assert.ok(["default", "approved"].includes(result.mode), "--mode must be default or approved");
  assert.ok(result.evidenceDir, "--evidence-dir is required");
  result.tarball = path.resolve(result.tarball);
  result.evidenceDir = path.resolve(result.evidenceDir);
  return result;
}

function run(command, args, cwd, env, logPath, captureStdout = false) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const output = fs.createWriteStream(logPath);
    let stdout = "";
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: process.platform === "win32" });
    child.on("error", reject);
    child.stdout?.on("data", (chunk) => { process.stdout.write(chunk); output.write(chunk); if (captureStdout) stdout += chunk; });
    child.stderr?.on("data", (chunk) => { process.stderr.write(chunk); output.write(chunk); });
    child.on("close", (code, signal) => {
      output.end(() => resolve({ exitCode: code ?? 1, signal, durationMs: Date.now() - started, ...(captureStdout ? { stdout } : {}) }));
    });
  });
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });
}

export function compilerGuardSource(event) {
  return `const fs = require("node:fs");
const event = ${JSON.stringify(event)};
const blocked = new Set(${JSON.stringify([...COMPILER_TOOLS])});
const child = require("node:child_process");
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = child[name];
  child[name] = function(command, ...args) {
    const commandLine = [command, ...(Array.isArray(args[0]) ? args[0] : [])].join(" ");
    const tokens = commandLine.toLowerCase().replaceAll("\\\\", "/").split(/[\\s"']+/).filter(Boolean);
    const blockedName = tokens.map((token) => token.split("/").at(-1).replace(/\\.(exe|cmd|bat)$/, "")).find((token) => blocked.has(token));
    if (blockedName) {
      fs.appendFileSync(event, blockedName + " " + commandLine + "\\n");
      throw new Error("Consumer install attempted native compilation via " + blockedName);
    }
    return original.call(this, command, ...args);
  };
}
`;
}

function installCompilerGuards(root) {
  const bin = path.join(root, "compiler-guard");
  fs.mkdirSync(bin, { recursive: true });
  const tools = [...COMPILER_TOOLS];
  const event = path.join(root, "compiler-invocations.log");
  const preload = path.join(root, "compiler-guard.cjs");
  fs.writeFileSync(preload, compilerGuardSource(event));
  for (const name of tools) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(bin, `${name}.cmd`), `@echo off\r\necho ${name} %*>>"${event}"\r\nexit /b 97\r\n`);
      fs.writeFileSync(path.join(bin, `${name}.bat`), `@echo off\r\necho ${name} %*>>"${event}"\r\nexit /b 97\r\n`);
    } else {
      const script = `#!/bin/sh\nprintf '%s\\n' '${name} $*' >> '${event}'\nexit 97\n`;
      const target = path.join(bin, name);
      fs.writeFileSync(target, script, { mode: 0o755 });
    }
  }
  return { bin, event, preload };
}

async function main() {
  const options = argsFrom(process.argv);
  assert.ok(fs.statSync(options.tarball).isFile(), `tarball does not exist: ${options.tarball}`);
  fs.mkdirSync(options.evidenceDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-parser-consumer-"));
  const consumer = path.join(root, "consumer");
  const cache = path.join(root, options.manager === "npm" ? "npm-cache" : "pnpm-store");
  fs.mkdirSync(consumer, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const tarballBytes = fs.readFileSync(options.tarball);
  const { manifest, pnpmWorkspace } = createConsumerConfig(options);
  if (pnpmWorkspace) fs.writeFileSync(path.join(consumer, "pnpm-workspace.yaml"), pnpmWorkspace);
  fs.writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const npmConfigs = npmConfigFiles(root);
  fs.writeFileSync(npmConfigs.user, "");
  fs.writeFileSync(npmConfigs.global, "");
  const guard = installCompilerGuards(root);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:npm|pnpm)_config_(?:ignore_scripts|legacy_peer_deps|force|allow_scripts)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    npm_config_userconfig: npmConfigs.user,
    npm_config_globalconfig: npmConfigs.global,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(guard.preload)}`.trim(),
    npm_config_cache: options.manager === "npm" ? cache : process.env.npm_config_cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_foreground_scripts: "true",
    PATH: `${guard.bin}${path.delimiter}${process.env.PATH ?? ""}`,
  });
  const command = options.manager === "npm" ? "npm" : "pnpm";
  const commandArgs = options.manager === "npm"
    ? ["install", "--foreground-scripts", "--loglevel=verbose", "--no-audit", "--no-fund", "--cache", cache]
    : ["install", "--reporter=append-only", "--store-dir", cache, "--config.side-effects-cache=false"];
  const versions = await run(command, ["--version"], consumer, env, path.join(options.evidenceDir, "manager-version.log"));
  assert.equal(versions.exitCode, 0, `${command} --version failed`);
  const versionLine = fs.readFileSync(path.join(options.evidenceDir, "manager-version.log"), "utf8").trim().split(/\r?\n/).at(-1);
  const install = await run(command, commandArgs, consumer, env, path.join(options.evidenceDir, "install.log"));
  const result = {
    mode: options.mode,
    manager: command,
    managerVersion: versionLine,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    tarball: path.basename(options.tarball),
    tarballBytes: tarballBytes.length,
    tarballSha256: crypto.createHash("sha256").update(tarballBytes).digest("hex"),
    cleanNodeModules: true,
    isolatedRegistryStore: true,
    sideEffectsCache: false,
    install,
    parser: null,
    graph: null,
    installedPackageBytes: null,
    compilerInvocations: [],
    approvals: options.mode === "approved" ? APPROVALS : {},
    lifecyclePolicy: options.mode !== "approved" ? "default" : options.manager === "pnpm"
      ? "pnpm-allowBuilds-exact-two-packages"
      : supportsNpmAllowScripts(versionLine) ? "npm-allowScripts-exact-two-packages" : "npm-before-11-hooks-run-approval-field-is-informational",
  };

  let graphJson;
  let installedManifest;
  let approvedError;
  if (install.exitCode === 0) {
    const packageRoot = path.join(consumer, "node_modules", "@showdar2112", "code-atlas");
    installedManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(installedManifest.name, "@showdar2112/code-atlas");
    result.packageVersion = installedManifest.version;
    assert.equal(result.packageVersion, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, "installed package version must match the checkout");
    result.installedPackageBytes = filesUnder(packageRoot).reduce((sum, file) => sum + fs.statSync(file).size, 0);
    const probe = path.join(root, "parser-probe.mjs");
    fs.writeFileSync(probe, `import assert from "node:assert/strict";\nimport { pathToFileURL } from "node:url";\nimport path from "node:path";\nconst root = ${JSON.stringify(packageRoot)};\nconst { parseSource } = await import(pathToFileURL(path.join(root, "dist/core/graph/parsers/code-parser.js")));\nconst { getLanguageConfig } = await import(pathToFileURL(path.join(root, "dist/core/graph/parsers/languages.js")));\nconst expected = ${JSON.stringify(EXPECTED)};\nconst samples = ${JSON.stringify(SAMPLES)};\nfor (const [file, source] of Object.entries(samples)) { const parsed = parseSource(source, file); assert.ok(parsed, file); assert.equal(parsed.tree.rootNode.hasError, false, file); const config = getLanguageConfig(file); assert.ok(config, file); assert.equal(config.metadata.runtimeName, "tree-sitter", file); assert.equal(config.metadata.runtimeVersion, expected["tree-sitter"], file); assert.equal(config.metadata.grammarVersion, expected[config.metadata.packageName], file); console.log("PASS", file, parsed.tree.rootNode.type, config.metadata.packageName + "@" + config.metadata.grammarVersion); }\nassert.equal(parseSource("plain text", "a.txt"), undefined);\nconsole.log("12/12 parser AST checks passed");\n`);
    result.parser = await run(process.execPath, [probe], consumer, env, path.join(options.evidenceDir, "parser.log"));
    const graphArgs = options.manager === "npm" ? ["ls", "--all", "--json"] : ["list", "--depth", "Infinity", "--json"];
    const graphRun = await run(command, graphArgs, consumer, env, path.join(options.evidenceDir, "dependency-graph.log"), true);
    result.graph = { exitCode: graphRun.exitCode, signal: graphRun.signal, durationMs: graphRun.durationMs };
    if (graphRun.exitCode === 0) {
      try {
        graphJson = JSON.parse(graphRun.stdout);
        fs.writeFileSync(path.join(options.evidenceDir, "dependency-graph.json"), `${JSON.stringify(graphJson, null, 2)}\n`);
      } catch (error) {
        approvedError = `Dependency graph output is not valid JSON: ${error.message}`;
      }
    }
    if (options.manager === "npm") {
      const lockPath = path.join(consumer, "package-lock.json");
      if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, path.join(options.evidenceDir, "package-lock.json"));
    } else {
      const lockPath = path.join(consumer, "pnpm-lock.yaml");
      if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, path.join(options.evidenceDir, "pnpm-lock.yaml"));
    }
  }
  result.compilerInvocations = fs.existsSync(guard.event) ? fs.readFileSync(guard.event, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
  result.compilerGuardPassed = result.compilerInvocations.length === 0;
  result.installWarnings = classifyInstallLog(fs.readFileSync(path.join(options.evidenceDir, "install.log"), "utf8"));
  if (options.mode === "approved" && install.exitCode === 0) {
    try {
      if (approvedError) throw new Error(approvedError);
      assertApprovedEvidence({
        install,
        parser: result.parser,
        graph: result.graph,
        installLog: fs.readFileSync(path.join(options.evidenceDir, "install.log"), "utf8"),
        manifest: installedManifest,
        graphJson,
      });
    } catch (error) {
      approvedError = error.message;
    }
  }
  result.approvedGateError = approvedError;
  fs.writeFileSync(path.join(options.evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.compilerGuardPassed) throw new Error(`Native build tool invoked: ${result.compilerInvocations.join(", ")}`);
  if (options.mode === "approved" && (install.exitCode !== 0 || approvedError)) {
    throw new Error(`Approved consumer gate failed: ${approvedError ?? `install=${install.exitCode}`}`);
  }
  if (options.mode === "approved") assert.ok(result.parser, "approved install did not run parser checks");
  if (options.mode === "default" && (install.exitCode !== 0 || (result.parser && result.parser.exitCode !== 0) || result.graph?.exitCode !== 0)) {
    throw new Error(`Default-policy diagnostic recorded a failure: install=${install.exitCode}, parser=${result.parser?.exitCode ?? "not run"}, graph=${result.graph?.exitCode ?? "not run"}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
