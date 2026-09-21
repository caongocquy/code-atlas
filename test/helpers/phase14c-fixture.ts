import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { indexRepository, syncRepository } from "../../src/core/indexing/index-pipeline.service.js";
import type { IndexWorkCounters } from "../../src/core/indexing/index-work-counters.js";
import { AtlasStore } from "../../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../../src/core/repository/index-version.js";
import type { FrameworkSemanticAdapter, FrameworkSnapshot } from "../../src/core/framework/framework.types.js";
import type { CodeGraph } from "../../src/core/graph/types.js";

export interface FixtureState {
  framework: FrameworkSnapshot;
  counters: Readonly<IndexWorkCounters>;
  language: CodeGraph;
}

export interface FrameworkFixture {
  run(changes?: Readonly<Record<string, string | null>>): Promise<FixtureState>;
  clean(): Promise<FixtureState>;
  bumpFrameworkVersion(version: string): Promise<FixtureState>;
  close(): Promise<void>;
}

export function normalizeFramework(snapshot: FrameworkSnapshot, language?: CodeGraph): unknown {
  const { repositoryId: _repositoryId, generationId: _generationId, ...stable } = snapshot;
  if (!language) return stable;
  const nodes = new Map(language.nodes.map((node) => [node.id, { type: node.type, name: node.name, qualifiedName: node.qualifiedName, file: node.file, startLine: node.startLine, endLine: node.endLine }]));
  const subject = (value: { kind: "language"; nodeId: string } | { kind: "framework"; entity: unknown }): unknown => value.kind === "language" ? { kind: "language", node: nodes.get(value.nodeId) ?? value.nodeId } : value;
  return {
    ...stable,
    relationships: snapshot.relationships.map((item) => ({ ...item, source: subject(item.source), target: subject(item.target) })),
    classifications: snapshot.classifications.map((item) => ({ ...item, subject: subject(item.subject) })),
  };
}

export async function createFrameworkFixture(
  files: Readonly<Record<string, string>>,
  _adapters: readonly FrameworkSemanticAdapter[] = [],
): Promise<FrameworkFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14c-fixture-"));
  const initialFiles = { ...files };
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, source);
  }
  let indexed = false;
  const originalFrameworkVersion = CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion;

  async function state(): Promise<FixtureState> {
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repositoryId = getRepositoryIdentity(root).id;
      const framework = store.loadFramework(repositoryId);
      if (!framework) throw new Error("Fixture framework snapshot is missing");
      return { framework, counters: lastCounters, language: store.loadGraph(repositoryId) };
    } finally {
      store.close();
    }
  }

  let lastCounters: Readonly<IndexWorkCounters> = Object.freeze({
    filesScanned: 0, filesHashed: 0, factCacheHits: 0, factCacheMisses: 0, filesParsed: 0,
    filesResolved: 0, importersInvalidated: 0, fullResolutionFallbacks: 0,
    frameworkFilesResolved: 0, frameworkFilesReused: 0,
  });

  async function run(changes: Readonly<Record<string, string | null>> = {}): Promise<FixtureState> {
    for (const [relativePath, source] of Object.entries(changes)) {
      const filePath = path.join(root, relativePath);
      if (source === null) await rm(filePath, { force: true });
      else {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, source);
      }
    }
    const result = indexed ? await syncRepository(root, { skipGit: true }) : await indexRepository(root, { skipGit: true });
    if (result.kind !== "published") throw new Error(result.failure.message);
    indexed = true;
    lastCounters = result.counters;
    return state();
  }

  return {
    run,
    clean: async () => {
      const cleanRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14c-clean-"));
      try {
        for (const [relativePath, source] of Object.entries(initialFiles)) {
          const filePath = path.join(cleanRoot, relativePath);
          await mkdir(path.dirname(filePath), { recursive: true });
          await writeFile(filePath, source);
        }
        const result = await indexRepository(cleanRoot, { skipGit: true });
        if (result.kind !== "published") throw new Error(result.failure.message);
        const store = new AtlasStore(path.join(cleanRoot, ".codeatlas", "atlas.db"));
        try {
          const repositoryId = getRepositoryIdentity(cleanRoot).id;
          const framework = store.loadFramework(repositoryId);
          if (!framework) throw new Error("Clean fixture framework snapshot is missing");
          return { framework, counters: result.counters, language: store.loadGraph(repositoryId) };
        } finally { store.close(); }
      } finally { await rm(cleanRoot, { recursive: true, force: true }); }
    },
    bumpFrameworkVersion: async (version: string) => {
      CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion = version;
      return run();
    },
    close: async () => {
      CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion = originalFrameworkVersion;
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface FrameworkScenario {
  name: string;
  files: Readonly<Record<string, string>>;
  changes: Readonly<Record<string, string | null>>;
  verify(state: FixtureState): void;
}

export async function assertFrameworkScenario(
  scenario: FrameworkScenario,
  adapters: readonly FrameworkSemanticAdapter[] = [],
): Promise<void> {
  const fixture = await createFrameworkFixture(scenario.files, adapters);
  try { scenario.verify(await fixture.run(scenario.changes)); }
  finally { await fixture.close(); }
}
