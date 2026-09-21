import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  FrameworkClassification,
  FrameworkConfigFact,
  FrameworkCoverage,
  FrameworkDependency,
  FrameworkDiagnostic,
  FrameworkEntity,
  FrameworkMaterialization,
  FrameworkProvenance,
  FrameworkRelationship,
} from "../src/core/framework/framework.types.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "3",
  factsSchemaVersion: "facts-1",
  factsVersion: "facts-1",
  resolutionVersion: "resolution-1",
  derivedVersion: "derived-1",
  frameworkResolutionVersion: "framework-1",
};

function provenance(overrides: Partial<FrameworkProvenance> = {}): FrameworkProvenance {
  return {
    origin: "framework_inferred",
    framework: "next",
    adapterId: "next-conventions",
    adapterVersion: "1.0.0",
    strategy: "app-router-page",
    confidence: "exact",
    evidenceIds: ["evidence:2", "evidence:1"],
    refs: [
      { relativePath: "app/users/page.tsx", inputKey: "facts:2" },
      { relativePath: "app/users/page.tsx", inputKey: "facts:1" },
    ],
    ...overrides,
  };
}

function entity(): FrameworkEntity {
  return {
    ref: {
      framework: "next",
      kind: "route",
      logicalKey: JSON.stringify(["app", "app-router", "/users", "GET", [], null]),
    },
    displayName: "/users",
    provenance: provenance(),
  };
}

function materialization(overrides: Partial<FrameworkMaterialization> = {}): FrameworkMaterialization {
  return {
    frameworkResolutionVersion: "framework-1",
    entities: [],
    relationships: [],
    classifications: [],
    diagnostics: [],
    coverage: [],
    config: [],
    detections: [],
    dependencies: [],
    complete: true,
    ...overrides,
  };
}

function openFixture(root: string): AtlasStore {
  return new AtlasStore(path.join(root, "atlas.db"));
}

function beginCandidate(store: AtlasStore, root: string, parentGenerationId?: string): { repositoryId: string; generationId: string } {
  const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
  const generation = createCandidateGeneration(repository.id, parentGenerationId, versions, []);
  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);
  return { repositoryId: repository.id, generationId: generation.id };
}

function writeLanguageGraph(store: AtlasStore, generationId: string): void {
  store.writeCandidateGraph(generationId, {
    nodes: [
      { id: "page", type: "file", name: "page.tsx", file: "app/users/page.tsx" },
      { id: "handler", type: "function", name: "handler", file: "app/users/page.tsx" },
    ],
    edges: [],
  }, new Map());
}

async function withFixture(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14c-storage-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshotDbFiles(databasePath: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${databasePath}${suffix}`;
    try {
      const metadata = await stat(filePath);
      const entry = await lstat(filePath);
      snapshot[suffix || "db"] = `${metadata.mtimeMs}:${entry.size}:${(await readFile(filePath)).toString("base64")}`;
    } catch {
      snapshot[suffix || "db"] = "missing";
    }
  }
  return snapshot;
}

test("writes and reloads a complete empty framework materialization", async () => withFixture((root) => {
  const store = openFixture(root);
  const { repositoryId, generationId } = beginCandidate(store, root);

  store.writeCandidateFramework(generationId, materialization());
  assert.deepEqual(store.loadFramework(repositoryId, generationId), {
    ...materialization(),
    repositoryId,
    generationId,
  });
  store.close();

  const reopened = openFixture(root);
  assert.deepEqual(reopened.loadFramework(repositoryId, generationId), {
    ...materialization(),
    repositoryId,
    generationId,
  });
  reopened.close();
}));

test("persists entities, relationships, classifications and query inputs", async () => withFixture((root) => {
  const store = openFixture(root);
  const { repositoryId, generationId } = beginCandidate(store, root);
  writeLanguageGraph(store, generationId);
  const route = entity();
  const relationship: FrameworkRelationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: "handler" },
    target: { kind: "framework", entity: route.ref },
    relationKind: "route_binding",
    provenance: provenance(),
  };
  const classification: FrameworkClassification = {
    outputKind: "classification",
    subject: { kind: "language", nodeId: "page" },
    classificationKind: "execution_boundary",
    classificationValue: "client",
    provenance: provenance(),
  };
  const config: FrameworkConfigFact = {
    relativePath: "package.json",
    scope: "app",
    inputKey: "package:app",
    kind: "package",
    values: { next: "1.0.0" },
    complete: true,
  };
  const detection = { framework: "next" as const, scope: "app", configured: true, observed: true, capabilities: ["app-router"], refs: provenance().refs, complete: true };
  const dependency: FrameworkDependency = { framework: "next", scope: "app", ownerPath: "package.json", inputKeys: ["package:app"], lookupKeys: ["next"], complete: true };
  const diagnostic: FrameworkDiagnostic = {
    code: "framework_target_unknown",
    outcome: "unknown",
    framework: "next",
    capability: "route-binding",
    relativePath: "app/users/page.tsx",
    strategy: "app-router-page",
    evidenceIds: ["evidence:1"],
    refs: provenance().refs,
    reason: "target is not available",
  };
  const coverage: FrameworkCoverage = {
    framework: "next",
    capability: "route-binding",
    relativePath: "app/users/page.tsx",
    strategy: "app-router-page",
    outputKind: "relationship",
    kind: "route_binding",
    applicable: 1,
    supported: 1,
    attempted: 1,
    resolved: 1,
    ambiguous: 0,
    unknown: 0,
    unsupported: 0,
    budgetExhausted: 0,
    weakDropped: 0,
  };

  store.writeCandidateFramework(generationId, materialization({
    entities: [route],
    relationships: [relationship],
    classifications: [classification],
    diagnostics: [diagnostic],
    coverage: [coverage],
    config: [config],
    detections: [detection],
    dependencies: [dependency],
  }));
  store.publishCandidateGeneration(generationId, { frameworkStaged: true });

  const inputs = store.loadFrameworkQueryInputs(repositoryId);
  assert.equal(inputs.graph.nodes.length, 2);
  assert.equal(inputs.graph.edges.length, 0);
  assert.equal(inputs.framework?.relationships.length, 1);
  assert.equal(inputs.framework?.classifications.length, 1);
  assert.equal(inputs.framework?.config.length, 1);
  assert.equal(inputs.framework?.detections.length, 1);
  assert.equal(inputs.framework?.dependencies.length, 1);
  store.close();
}));

test("sorts bounded provenance refs and rejects oversize refs", async () => withFixture((root) => {
  const store = openFixture(root);
  const { repositoryId, generationId } = beginCandidate(store, root);
  const route = entity();
  store.writeCandidateFramework(generationId, materialization({ entities: [route] }));
  const loaded = store.loadFramework(repositoryId, generationId);
  assert.deepEqual(loaded?.entities[0]?.provenance.evidenceIds, ["evidence:1", "evidence:2"]);
  assert.deepEqual(loaded?.entities[0]?.provenance.refs.map((ref) => ref.inputKey), ["facts:1", "facts:2"]);

  const tooManyRefs = Array.from({ length: 33 }, (_, index) => ({ relativePath: `src/${index}.ts`, inputKey: `facts:${index}` }));
  assert.throws(() => store.writeCandidateFramework(generationId, materialization({ entities: [{ ...route, provenance: provenance({ refs: tooManyRefs }) }] })), /invalid framework materialization|oversize|provenance/i);
  assert.equal(store.loadFramework(repositoryId, generationId)?.entities.length, 1);
  store.close();
}));

test("rejects dangling endpoints, weak provenance and conflicting duplicates atomically", async () => withFixture((root) => {
  const store = openFixture(root);
  const { repositoryId, generationId } = beginCandidate(store, root);
  writeLanguageGraph(store, generationId);
  const route = entity();
  const valid = materialization({
    entities: [route],
    relationships: [{
      outputKind: "relationship",
      source: { kind: "language", nodeId: "missing" },
      target: { kind: "framework", entity: route.ref },
      relationKind: "route_binding",
      provenance: provenance(),
    }],
  });
  assert.throws(() => store.writeCandidateFramework(generationId, valid), /dangling|language node|invalid framework materialization/i);

  const weak = materialization({ entities: [{ ...route, provenance: provenance({ confidence: "weak" as "exact" }) }] });
  assert.throws(() => store.writeCandidateFramework(generationId, weak), /invalid framework materialization|provenance/i);

  const invalidClassification = materialization({
    entities: [route],
    classifications: [{
      outputKind: "classification",
      subject: { kind: "framework", entity: route.ref },
      classificationKind: "execution_boundary",
      classificationValue: "unknown" as "client",
      provenance: provenance(),
    }],
  });
  assert.throws(() => store.writeCandidateFramework(generationId, invalidClassification), /invalid framework materialization|accepted output|classification/i);

  const conflict = materialization({ entities: [route, { ...route, displayName: "/other" }] });
  assert.throws(() => store.writeCandidateFramework(generationId, conflict), /duplicate|conflict|invalid framework materialization/i);
  const database = new DatabaseSync(path.join(root, "atlas.db"), { readOnly: true });
  assert.equal((database.prepare("SELECT count(*) AS count FROM generation_framework_state WHERE generation_id = ?").get(generationId) as { count: number }).count, 0);
  assert.equal(store.loadFramework(repositoryId, generationId), undefined);
  database.close();
  store.close();
}));

test("rejects missing, committed and read-only candidate framework writes", async () => withFixture((root) => {
  const store = openFixture(root);
  const { repositoryId, generationId } = beginCandidate(store, root);
  assert.throws(() => store.writeCandidateFramework("missing", materialization()), /candidate generation/i);
  store.writeCandidateFramework(generationId, materialization());
  store.publishCandidateGeneration(generationId, { frameworkStaged: true });
  assert.throws(() => store.writeCandidateFramework(generationId, materialization()), /candidate generation/i);
  store.close();

  const reopened = openFixture(root);
  const second = beginCandidate(reopened, root, generationId);
  reopened.close();
  const readOnly = new AtlasStore(path.join(root, "atlas.db"), { readOnly: true });
  assert.throws(() => readOnly.writeCandidateFramework(second.generationId, materialization()), /read-only|readonly/i);
  assert.equal(readOnly.loadFramework(repositoryId, second.generationId), undefined);
  readOnly.close();
}));

test("read-only framework query inputs preserve database and sidecar bytes", async () => withFixture(async (root) => {
  const databasePath = path.join(root, "atlas.db");
  const store = new AtlasStore(databasePath);
  const { repositoryId, generationId } = beginCandidate(store, root);
  store.writeCandidateFramework(generationId, materialization());
  store.publishCandidateGeneration(generationId, { frameworkStaged: true });
  store.close();

  const before = await snapshotDbFiles(databasePath);
  const readOnly = new AtlasStore(databasePath, { readOnly: true });
  const inputs = readOnly.loadFrameworkQueryInputs(repositoryId);
  assert.equal(inputs.framework?.complete, true);
  readOnly.close();
  assert.deepEqual(await snapshotDbFiles(databasePath), before);
}));

test("persists distinct diagnostics sharing a coarse source tuple", async () => withFixture((root) => {
  const store = openFixture(root);
  const { repositoryId, generationId } = beginCandidate(store, root);
  const base: FrameworkDiagnostic = {
    code: "framework_target_unknown",
    outcome: "unknown",
    framework: "next",
    capability: "next.routes",
    relativePath: "app/users/page.tsx",
    strategy: "route",
    evidenceIds: ["evidence:1"],
    refs: [{ relativePath: "app/users/page.tsx", inputKey: "facts:1" }],
    reason: "source target missing",
  };
  store.writeCandidateFramework(generationId, materialization({ diagnostics: [base, { ...base, evidenceIds: ["evidence:2"], reason: "target ambiguous" }] }));
  store.publishCandidateGeneration(generationId, { frameworkStaged: true });
  assert.equal(store.loadFramework(repositoryId, generationId)?.diagnostics.length, 2);
  store.close();
}));

test("rejects internally inconsistent framework coverage counters", async () => withFixture((root) => {
  const store = openFixture(root);
  const { generationId } = beginCandidate(store, root);
  const invalid: FrameworkCoverage = {
    framework: "next", capability: "next.routes", relativePath: "app/page.tsx", strategy: "route", outputKind: "relationship", kind: "route_binding", applicable: 1, supported: 2, attempted: 0, resolved: 1, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0,
  };
  assert.throws(() => store.writeCandidateFramework(generationId, materialization({ coverage: [invalid] })), /coverage/i);
  store.close();
}));

test("legacy graph-only reads return an undefined framework snapshot", async () => withFixture((root) => {
  const store = openFixture(root);
  const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
  store.replaceGraph(repository.id, {
    nodes: [{ id: "legacy", type: "file", name: "legacy.ts", file: "legacy.ts" }],
    edges: [],
  }, new Map([["legacy.ts", "hash"]]));
  const inputs = store.loadFrameworkQueryInputs(repository.id);
  assert.equal(inputs.graph.nodes[0]?.id, "legacy");
  assert.equal(inputs.framework, undefined);
  assert.equal(store.loadFramework(repository.id), undefined);
  store.close();
}));
