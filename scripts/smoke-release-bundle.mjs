import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
const { fetch } = globalThis;
import { createServer } from "node:net";
import test from "node:test";
import process from "node:process";
import console from "node:console";

const bundle = path.resolve(process.argv[2] ?? ".release/bundle");
const runtime = path.join(bundle, "runtime", process.platform === "win32" ? "node.exe" : "node");
if (process.argv[3] !== "--bundled") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-release-home-"));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, NODE_PATH: "", CI: "true", NO_COLOR: "1" };
    const result = spawnSync(runtime, [process.argv[1], bundle, "--bundled"], { env, stdio: "inherit", timeout: 300_000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
} else {
  const pkg = path.join(bundle, "node_modules/@showdar2112/code-atlas");
  const cli = path.join(pkg, "dist/cli.js");
  const require = createRequire(cli);
  const load = (relative) => import(pathToFileURL(path.join(pkg, "dist", relative)).href);
  const dependency = (name) => import(pathToFileURL(require.resolve(name)).href);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-release-fixture-"));
  const run = (...args) => {
    const result = spawnSync(runtime, [cli, ...args], { cwd: fixture, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr} ${result.stdout}`);
    return result.stdout;
  };
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "release-fixture", type: "module" }));
  fs.writeFileSync(path.join(fixture, "auth.ts"), "export function AuthService() { return true; }\n");
  fs.writeFileSync(path.join(fixture, "caller.ts"), "import { AuthService } from './auth.js'; export function run() { return AuthService(); }\n");
  try {
    await test("native parsers load every supported language from the artifact", async () => {
      const runtime = await load("core/graph/parsers/native-runtime.js");
      assert.ok(runtime.ParserRuntime && runtime.JavaScript && runtime.TypeScript && runtime.C && runtime.Cpp);
      assert.ok(runtime.Go && runtime.Java && runtime.Kotlin && runtime.Python && runtime.Rust && runtime.Swift && runtime.Dart);
      const { parseSource } = await load("core/graph/parsers/code-parser.js");
      const sources = {
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
      for (const [file, source] of Object.entries(sources)) {
        const parsed = parseSource(source, file);
        assert.ok(parsed, file);
        assert.equal(parsed.tree.rootNode.hasError, false, file);
      }
      assert.equal(parseSource("plain text", "a.txt"), undefined);
    });
    await test("CLI version, init, sync and representative input failure", () => {
      const expected = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;
      assert.equal(run("--version").trim(), expected);
      const launcher = process.platform === "win32"
        ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", path.join(bundle, "bin/code-atlas.cmd"), "--version"], { encoding: "utf8", timeout: 10_000 })
        : spawnSync(path.join(bundle, "bin/code-atlas"), ["--version"], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" }, timeout: 10_000 });
      assert.equal(launcher.status, 0, launcher.stderr);
      assert.equal(launcher.stdout.trim(), expected);
      assert.match(run("--help"), /Usage: code-atlas/);
      run("init", "--no-guidance", "--json");
      fs.appendFileSync(path.join(fixture, "auth.ts"), "export const revision = 2;\n");
      run("sync", "--json");
      const failed = spawnSync(runtime, [cli, "semantic", "setup", "--provider", "invalid", "--json"], { cwd: fixture, encoding: "utf8", timeout: 10_000 });
      assert.equal(failed.status, 1);
      assert.match(failed.stdout, /provider/);
      // v1.6.0 has no doctor command; verify its existing failure rather than add product behavior.
      const doctor = spawnSync(runtime, [cli, "doctor", "--json"], { cwd: fixture, encoding: "utf8", timeout: 10_000 });
      assert.equal(doctor.status, 1);
      assert.match(doctor.stdout, /Unknown command/);
    });
    await test("MCP stdio startup, tools/list, lexical, graph, hybrid and missing-index failure", async () => {
      const { Client } = await dependency("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await dependency("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({ command: runtime, args: [cli, "mcp"], stderr: "pipe" });
      const client = new Client({ name: "portable-release-smoke", version: "1" });
      try {
        await client.connect(transport);
        assert.ok((await client.listTools()).tools.some((tool) => tool.name === "search_code"));
        for (const mode of ["lexical", "hybrid"]) {
          const result = await client.callTool({ name: "search_code", arguments: { repoPath: fixture, query: "AuthService", mode } });
          assert.ok(!result.isError, JSON.stringify(result));
          assert.match(JSON.stringify(result), /auth.ts/);
        }
        const symbol = await client.callTool({ name: "get_symbol", arguments: { repoPath: fixture, query: "AuthService" } });
        assert.ok(!symbol.isError, JSON.stringify(symbol));
        assert.match(JSON.stringify(symbol), /AuthService/);
        const absent = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-release-missing-"));
        try {
          const result = await client.callTool({ name: "get_symbol", arguments: { repoPath: absent, query: "Missing" } });
          assert.equal(result.isError, true);
        } finally { fs.rmSync(absent, { recursive: true, force: true }); }
      } finally { await client.close(); await transport.close(); }
    });
    await test("Web UI and API start from the artifact", async () => {
      const socket = createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const port = socket.address().port;
      await new Promise((resolve) => socket.close(resolve));
      const child = spawn(runtime, [cli, "serve", fixture], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
      const exited = once(child, "exit");
      try {
        const url = `http://127.0.0.1:${port}`;
        let response;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { response = await fetch(`${url}/health`); if (response.ok) break; } catch { /* Wait for startup. */ }
          if (child.exitCode !== null) throw new Error(`UI exited: ${child.exitCode}`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(response?.ok, "HTTP startup timed out");
        assert.equal((await response.json()).api, "ok");
        assert.match(await (await fetch(url)).text(), /<html/);
        const html = await (await fetch(url)).text();
        const asset = html.match(/src="([^"]+\.js)"/);
        assert.ok(asset, "UI JS asset missing");
        assert.equal((await fetch(new URL(asset[1], url))).status, 200);
        assert.equal((await fetch(`${url}/api/graph/search`)).status, 400);
      } finally { child.kill(); await exited; }
    });
    await test("SCIP adapter loads protobuf dependencies and reports missing external compiler", async () => {
      const { LocalScipIndexer } = await load("infrastructure/scip/local-scip-indexer.js");
      assert.equal((await new LocalScipIndexer({ env: { PATH: "" } }).discover(fixture)).status, "unavailable");
    });
    await test("real external SCIP compiler enriches packed parser facts", { skip: process.env.CODE_ATLAS_SCIP_SMOKE !== "1" }, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-release-scip-"));
      try {
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "release-scip", private: true }));
        fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }));
        const { extractParsedFacts } = await load("core/facts/facts-extractor.js");
        const { LocalScipIndexer } = await load("infrastructure/scip/local-scip-indexer.js");
        const units = Object.entries({ "dep.ts": "export function target() { return true; }\n", "index.ts": "import { target as local } from './dep.js';\nlocal();\n" }).map(([relativePath, source]) => {
          fs.writeFileSync(path.join(root, relativePath), source);
          const result = extractParsedFacts({ source, language: "typescript", filePath: relativePath, repositoryId: "repo-id", contentHash: "fixture-hash" });
          assert.equal(result.kind, "facts");
          return { relativePath, source, facts: result.facts };
        });
        const indexer = new LocalScipIndexer();
        const discovery = await indexer.discover(root);
        assert.equal(discovery.status, "ready", JSON.stringify(discovery));
        const call = units[1].facts.callSites.find((site) => site.calleeText === "local");
        assert.ok(call);
        const evidence = await indexer.index({ projectRoot: root, repositoryId: "repo-id", tool: discovery.tool, units });
        assert.ok(evidence.some((item) => item.sourceUnit.relativePath === "index.ts" && item.siteLocalId === call.localId && item.target.relativePath === "dep.ts"));
        assert.equal(fs.existsSync(path.join(root, "index.scip")), false);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    await test("React/Vite lazyRouteNamed proof survives artifact index and sync", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-atlas-release-lazy-"));
      try {
        const write = (name, source) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source); };
        write("package.json", JSON.stringify({ dependencies: { react: "19.0.0" } }));
        write("tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx", paths: { "@/*": ["./src/*"] } }, include: ["src/**/*"] }));
        write("src/lazy-route.ts", `import { lazy } from "react";
export async function importWithChunkRetry<T>(importer: () => Promise<T>): Promise<T> { return importer(); }
export function lazyRouteNamed<T extends Record<string, unknown>>(importer: () => Promise<T>, exportName: keyof T & string) {
  return lazy(() => importWithChunkRetry(importer).then((module) => ({ default: module[exportName] })));
}`);
        write("src/lazy-pages.ts", 'import { lazyRouteNamed } from "./lazy-route"; export const Page = lazyRouteNamed(() => import("@/Page"), "Page");');
        write("src/Page.tsx", 'export function Page() { return <div />; }');
        write("src/routes.tsx", 'import { Page } from "./lazy-pages"; export function Routes() { return <Page />; }');
        const { indexRepository, syncRepository } = await load("core/indexing/index-pipeline.service.js");
        const { AtlasStore } = await load("storage/atlas/atlas.store.js");
        const { getRepositoryIdentity } = await load("core/repository/repository-identity.js");
        const indexed = await indexRepository(root, { skipGit: true });
        assert.equal(indexed.kind, "published", JSON.stringify(indexed));
        const store = new AtlasStore(path.join(root, ".codeatlas/atlas.db"));
        try {
          const id = store.findRepository(getRepositoryIdentity(root)).id;
          const graph = store.loadGraph(id);
          const target = graph.nodes.find((node) => node.name === "Page" && node.file === "src/Page.tsx");
          assert.ok(target);
          assert.ok(store.loadFramework(id).relationships.some((item) => item.relationKind === "component_usage" && item.target.nodeId === target.id));
        } finally { store.close(); }
        assert.ok(["published", "reused"].includes((await syncRepository(root, { skipGit: true })).kind));
        write("src/Page.tsx", 'export function RenamedPage() { return <div />; }');
        const invalid = await syncRepository(root, { skipGit: true });
        assert.equal(invalid.kind, "failed");
        assert.match(invalid.failure.message, /framework_target_unknown/);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    await test("ONNX and Transformers load from the packaged runtime", async () => {
      const ort = await dependency("onnxruntime-node");
      assert.ok(ort.InferenceSession);
      const transformers = await import(pathToFileURL(path.join(path.dirname(require.resolve("@huggingface/transformers")), "transformers.node.mjs")).href);
      assert.equal(typeof transformers.pipeline, "function");
    });
    await test("real local semantic setup, embedding, search and disable lifecycle", async () => {
      const lifecycle = await load("infrastructure/semantic/semantic-lifecycle.service.js");
      const configured = await lifecycle.setupSemanticProvider(fixture, { type: "builtin-local" });
      assert.equal(configured.status, "configured");
      assert.ok(configured.probe.dimensions > 0);
      const tested = await lifecycle.testSemanticProvider(fixture);
      assert.ok(tested);
      run("sync", "--json");
      const { createConfiguredProviders, closeConfiguredProviders } = await load("infrastructure/semantic/repository-providers.js");
      const { inspectHybridSearch } = await load("core/retrieval/hybrid-search.service.js");
      const providers = await createConfiguredProviders(fixture, { readOnly: true });
      try {
        const result = await inspectHybridSearch("AuthService", 5, fixture, providers);
        assert.ok(result.vectorResults.length > 0, JSON.stringify(result));
      } finally { closeConfiguredProviders(providers); }
      const { Client } = await dependency("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await dependency("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({ command: runtime, args: [cli, "mcp"], stderr: "pipe" });
      const client = new Client({ name: "semantic-release-smoke", version: "1" });
      try {
        await client.connect(transport);
        const response = await client.callTool({ name: "search_code", arguments: { repoPath: fixture, query: "AuthService", mode: "hybrid" } });
        assert.ok(!response.isError, JSON.stringify(response));
        const result = JSON.parse(response.content.find((item) => item.type === "text").text);
        assert.equal(result.semanticState, "ready");
        assert.ok(result.vectorResults.length > 0);
      } finally { await client.close(); await transport.close(); }
      await lifecycle.disableSemanticProvider(fixture);
      assert.equal((await lifecycle.getSemanticStatus(fixture)).enabled, false);
    });
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  console.log(`Artifact smoke complete: ${bundle}`);
}
