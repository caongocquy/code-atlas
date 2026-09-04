import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { GRAPH_INDEX_VERSION } from "../src/config/constants.js";
import { buildCodeGraphWithResolution } from "../src/core/graph/build-graph.js";
import { resolveCallResults } from "../src/core/graph/call-resolution.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";
import { buildFileGraphs } from "../src/core/graph/build-file-updates.js";
import { fileURLToPath } from "node:url";

const phase0Fixture = fileURLToPath(new URL("./fixtures/phase-0-graph", import.meta.url));

async function withRepo(callback: (repoPath: string) => Promise<void>): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-7-"));
  try {
    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

test("graph resolution records evidence and drops ambiguous calls", async () => {
  await withRepo(async (repoPath) => {
    await mkdir(repoPath, { recursive: true });
    await writeFile(path.join(repoPath, "a.ts"), "export function shared() {}\nexport class Parent {}\n");
    await writeFile(path.join(repoPath, "b.ts"), "export function shared() {}\nexport class Parent {}\n");
    await writeFile(path.join(repoPath, "main.ts"), [
      'import { shared } from "./a.js";',
      'import { shared } from "./b.js";',
      'import { Parent as Base } from "./a.js";',
      'import { Parent as Base } from "./b.js";',
      "export function caller() { shared(); }",
      "export class LocalParent {}",
      "export class LocalChild extends LocalParent {}",
      "export class Child extends Base {}",
      "export class Receiver { helper() {} run() { this.helper(); } }",
    ].join("\n"));

    const built = await buildCodeGraphWithResolution(repoPath);
    const main = built.resolutionByFile.get("main.ts");
    assert.ok(main);
    assert.equal(main.coverage.ambiguousCalls, 1);
    assert.equal(main.coverage.ambiguousExtends, 1);
    assert.equal(main.coverage.resolvedCalls, 1);
    assert.equal(main.coverage.resolvedExtends, 1);
    assert.equal(main.coverage.mayBeIncomplete, true);
    assert.equal(main.diagnostics.some((item) => item.kind === "ambiguous"), true);

    const callEdges = built.graph.edges.filter((edge) => edge.type === "calls");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolutionMethod, "this_receiver");
    assert.equal(callEdges[0]?.evidenceKind, "INFERRED");
    assert.equal(callEdges[0]?.confidence, 1);
  });
});

test("supported resolution methods are recorded on graph edges", async () => {
  await withRepo(async (repoPath) => {
    await cp(phase0Fixture, repoPath, { recursive: true });
    const built = await buildCodeGraphWithResolution(repoPath);
    const graph = built.graph;
    const find = (file: string, type: "function" | "method" | "class", qualifiedName: string) => {
      const node = graph.nodes.find((candidate) => candidate.file === file && candidate.type === type && candidate.qualifiedName === qualifiedName);
      assert.ok(node, `Missing ${file} ${type}:${qualifiedName}`);
      return node;
    };
    const methodFor = (from: typeof graph.nodes[number], to: typeof graph.nodes[number]) => {
      const edge = graph.edges.find((candidate) => candidate.type === "calls" || candidate.type === "extends"
        ? candidate.from === from.id && candidate.to === to.id
        : false);
      assert.ok(edge, `Missing edge ${from.id} -> ${to.id}`);
      return edge.resolutionMethod;
    };

    const methods = new Set([
      methodFor(find("graph.ts", "function", "localCaller"), find("graph.ts", "function", "localTarget")),
      methodFor(find("graph.ts", "function", "localCaller"), find("target.ts", "function", "importedTarget")),
      methodFor(find("graph.ts", "method", "Receiver.callThis"), find("graph.ts", "method", "Receiver.helper")),
      methodFor(find("graph.ts", "function", "typedCaller"), find("target.ts", "method", "Service.method")),
      methodFor(find("graph.ts", "method", "Receiver.callField"), find("target.ts", "method", "Service.method")),
      methodFor(find("graph.ts", "function", "newCaller"), find("target.ts", "method", "Service.method")),
      methodFor(find("graph.ts", "class", "ImportedChild"), find("target.ts", "class", "Parent")),
    ]);
    assert.deepEqual([...methods].sort(), [
      "constructor_type",
      "field_type",
      "import_binding",
      "parameter_type",
      "same_file",
      "this_receiver",
      "inheritance",
    ].sort());
  });
});

test("resolution candidates are sorted independently of graph node order", async () => {
  const graph = {
    nodes: [
      { id: "caller", type: "function" as const, name: "caller", qualifiedName: "caller", file: "main.ts" },
      { id: "z", type: "function" as const, name: "duplicate", qualifiedName: "duplicate.z", file: "main.ts" },
      { id: "a", type: "function" as const, name: "duplicate", qualifiedName: "duplicate.a", file: "main.ts" },
    ],
    edges: [],
  };
  const calls = [{ calleeName: "duplicate", callerName: "caller", callerQualifiedName: "caller", callerType: "function" as const, line: 1 }];
  const first = resolveCallResults(graph, "main.ts", calls, []);
  const second = resolveCallResults({ ...graph, nodes: [...graph.nodes].reverse() }, "main.ts", calls, []);
  assert.deepEqual(first.edges, []);
  assert.deepEqual(second.edges, []);
  assert.deepEqual(first.results, second.results);
  assert.equal(first.results[0]?.kind, "ambiguous");
});

test("resolved results record unique candidate counts", () => {
  const graph = {
    nodes: [
      { id: "caller", type: "function" as const, name: "caller", qualifiedName: "caller", file: "main.ts" },
      { id: "target", type: "function" as const, name: "target", qualifiedName: "target", file: "main.ts" },
    ],
    edges: [],
  };
  const result = resolveCallResults(graph, "main.ts", [{ calleeName: "target", callerName: "caller", callerQualifiedName: "caller", callerType: "function", line: 1 }], []);
  assert.equal(result.results[0]?.kind, "resolved");
  if (result.results[0]?.kind === "resolved") assert.equal(result.results[0].candidateCount, 1);
});

test("resolution evidence and coverage survive AtlasStore reopen", async () => {
  await withRepo(async (repoPath) => {
    await writeFile(path.join(repoPath, "main.ts"), "export function helper() {}\nexport function run() { helper(); }\n");
    const built = await buildCodeGraphWithResolution(repoPath);
    const identity = getRepositoryIdentity(repoPath);
    const dbPath = path.join(repoPath, ".codeatlas", "atlas.db");
    const store = new AtlasStore(dbPath);
    try {
      store.ensureRepository(identity);
      const hash = createFileHash(await readFile(path.join(repoPath, "main.ts"), "utf8"));
      store.replaceGraph(identity.id, built.graph, new Map([["main.ts", hash]]), GRAPH_INDEX_VERSION, built.resolutionByFile);
      const before = store.getGraphResolutionCoverage(identity.id);
      assert.equal(before.calls, 1);
      assert.equal(before.resolvedCalls, 1);
      assert.equal(store.loadGraph(identity.id).edges.find((edge) => edge.type === "calls")?.resolutionSource?.file, "main.ts");
      assert.equal(store.loadGraph(identity.id).nodes.length > 0, true);
    } finally {
      store.close();
    }
    const reopened = new AtlasStore(dbPath);
    try {
      assert.deepEqual(reopened.getGraphResolutionCoverage(identity.id), {
        calls: 1,
        resolvedCalls: 1,
        unresolvedCalls: 0,
        ambiguousCalls: 0,
        extends: 0,
        resolvedExtends: 0,
        unresolvedExtends: 0,
        ambiguousExtends: 0,
        parserErrors: 0,
        unsupportedDynamic: 0,
        mayBeIncomplete: false,
      });
    } finally {
      reopened.close();
    }
    const status = await getRepositoryStatus(repoPath);
      assert.equal(status.graph.resolutionCoverage.calls, 1);
  });
});

test("ambiguous diagnostics persist and unresolved dynamic calls mark incomplete", async () => {
  await withRepo(async (repoPath) => {
    await writeFile(path.join(repoPath, "a.ts"), "export function shared() {}\n");
    await writeFile(path.join(repoPath, "b.ts"), "export function shared() {}\n");
    const source = [
      'import { shared } from "./a.js";',
      'import { shared } from "./b.js";',
      "export function run(obj: unknown, method: string) { shared(); missing(); obj[method](); }",
    ].join("\n");
    await writeFile(path.join(repoPath, "main.ts"), source);
    const built = await buildCodeGraphWithResolution(repoPath);
    const resolution = built.resolutionByFile.get("main.ts");
    assert.ok(resolution);
    assert.equal(resolution.coverage.ambiguousCalls, 1);
    assert.equal(resolution.coverage.unresolvedCalls, 2);
    assert.equal(resolution.coverage.unsupportedDynamic, 1);
    assert.equal(resolution.coverage.mayBeIncomplete, true);

    const identity = getRepositoryIdentity(repoPath);
    const dbPath = path.join(repoPath, "atlas.db");
    const store = new AtlasStore(dbPath);
    try {
      store.ensureRepository(identity);
      store.replaceGraph(identity.id, built.graph, new Map([
        ["a.ts", createFileHash("export function shared() {}\n")],
        ["b.ts", createFileHash("export function shared() {}\n")],
        ["main.ts", createFileHash(source)],
      ]), GRAPH_INDEX_VERSION, built.resolutionByFile);
    } finally {
      store.close();
    }

    const reopened = new AtlasStore(dbPath);
    try {
      const diagnostics = reopened.getGraphResolutionDiagnostics(identity.id);
      assert.equal(diagnostics.some((item) => item.kind === "ambiguous" && item.candidates.length === 2), true);
      assert.equal(reopened.getGraphResolutionCoverage(identity.id).mayBeIncomplete, true);
    } finally {
      reopened.close();
    }
  });
});

test("incremental resolution coverage replaces and deletes file state", async () => {
  await withRepo(async (repoPath) => {
    const initialSource = "export function helper() {}\nexport function run() { helper(); }\n";
    await writeFile(path.join(repoPath, "main.ts"), initialSource);
    const identity = getRepositoryIdentity(repoPath);
    const store = new AtlasStore(path.join(repoPath, "atlas.db"));
    try {
      const initial = await buildCodeGraphWithResolution(repoPath);
      store.ensureRepository(identity);
      store.replaceGraph(identity.id, initial.graph, new Map([["main.ts", createFileHash(initialSource)]]), GRAPH_INDEX_VERSION, initial.resolutionByFile);
      assert.equal(store.getGraphResolutionCoverage(identity.id).resolvedCalls, 1);

      const changedSource = "export function run() { missing(); }\n";
      await writeFile(path.join(repoPath, "main.ts"), changedSource);
      const updates = await buildFileGraphs(repoPath, identity.id, ["main.ts"], new Set(["main.ts"]), store.loadGraph(identity.id));
      store.applyFileUpdates(identity.id, updates.map((update) => ({ ...update, fileHash: createFileHash(changedSource) })), [], GRAPH_INDEX_VERSION);
      const changedCoverage = store.getGraphResolutionCoverage(identity.id);
      assert.equal(changedCoverage.resolvedCalls, 0);
      assert.equal(changedCoverage.unresolvedCalls, 1);
      assert.equal(changedCoverage.mayBeIncomplete, true);

      await rm(path.join(repoPath, "main.ts"));
      store.applyFileUpdates(identity.id, [], ["main.ts"], GRAPH_INDEX_VERSION);
      const deletedCoverage = store.getGraphResolutionCoverage(identity.id);
      assert.equal(deletedCoverage.calls, 0);
      assert.equal(deletedCoverage.unresolvedCalls, 0);
      assert.deepEqual(store.getGraphResolutionDiagnostics(identity.id), []);
    } finally {
      store.close();
    }
  });
});

test("parser errors are reported as incomplete graph resolution", async () => {
  await withRepo(async (repoPath) => {
    await writeFile(path.join(repoPath, "broken.ts"), "export function broken( {\n");
    const built = await buildCodeGraphWithResolution(repoPath);
    const resolution = built.resolutionByFile.get("broken.ts");
    assert.ok(resolution);
    assert.equal(resolution.coverage.parserErrors, 1);
    assert.equal(resolution.coverage.mayBeIncomplete, true);
  });
});

test("graph version mismatch is isolated to graph state", async () => {
  await withRepo(async (repoPath) => {
    const source = "export function run() {}\n";
    await writeFile(path.join(repoPath, "main.ts"), source);
    const built = await buildCodeGraphWithResolution(repoPath);
    const identity = getRepositoryIdentity(repoPath);
    const store = new AtlasStore(path.join(repoPath, "atlas.db"));
    try {
      store.ensureRepository(identity);
      store.replaceGraph(identity.id, built.graph, new Map([["main.ts", createFileHash(source)]]), "1.0.3", built.resolutionByFile);
      store.setVersion(identity.id, "semantic", "semantic-unchanged");
      assert.equal(store.getVersion(identity.id, "graph"), "1.0.3");
      assert.equal(store.getVersion(identity.id, "semantic"), "semantic-unchanged");
    } finally {
      store.close();
    }
  });
});
