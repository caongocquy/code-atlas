import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await writeFile(path.join(repoPath, "a.ts"), "export function shared() {}\n");
    await writeFile(path.join(repoPath, "b.ts"), "export function shared() {}\n");
    await writeFile(path.join(repoPath, "main.ts"), [
      'import { shared } from "./a.js";',
      'import { shared } from "./b.js";',
      "export function caller() { shared(); }",
      "export class Parent {}",
      "export class Child extends Parent {}",
      "export class Receiver { helper() {} run() { this.helper(); } }",
    ].join("\n"));

    const built = await buildCodeGraphWithResolution(repoPath);
    const main = built.resolutionByFile.get("main.ts");
    assert.ok(main);
    assert.equal(main.coverage.ambiguousCalls, 1);
    assert.equal(main.coverage.resolvedCalls, 1);
    assert.equal(main.coverage.resolvedExtends, 1);
    assert.equal(main.diagnostics.some((item) => item.kind === "ambiguous"), true);

    const callEdges = built.graph.edges.filter((edge) => edge.type === "calls");
    assert.equal(callEdges.length, 1);
    assert.equal(callEdges[0]?.resolutionMethod, "this_receiver");
    assert.equal(callEdges[0]?.evidenceKind, "INFERRED");
    assert.equal(callEdges[0]?.confidence, 1);
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
