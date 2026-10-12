import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { getRepositoryStatusReadOnly } from "../src/core/repository/repository-status.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("18 lazy JSX route objects and dynamic components publish only proven edges", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-react-contract-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "package.json"), '{"dependencies":{"react":"19"}}');
    await writeFile(path.join(root, "src", "Page.tsx"), 'export default function Page() { return <div />; }');
    const declarations = Array.from({ length: 18 }, (_, i) => `const Page${i} = React.lazy(() => import("./Page"));`);
    const routes = Array.from({ length: 18 }, (_, i) => `{ path: "/${i}", element: <Page${i} /> }`);
    await writeFile(path.join(root, "src", "routes.tsx"), [
      'import React from "react";', ...declarations,
      `export const routes = [${routes.join(",")}];`,
    ].join("\n"));
    await writeFile(path.join(root, "src", "dynamic.tsx"), `
import React from "react";
export function AppShell({ Icon }: any) { return <Icon />; }
export function ProductIcon({ icons, name }: any) { const Icon = icons[name]; return <Icon />; }
export function ToastProvider({ toneIcons, record }: any) { const Icon = toneIcons[record.tone]; return <Icon />; }
export function Badge({ asChild, Slot }: any) { const Comp = asChild ? Slot.Root : "span"; return <Comp />; }
export function Button({ asChild, Slot }: any) { const Comp = asChild ? Slot.Root : "button"; return <Comp />; }
`);
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    if (result.kind !== "published") return;
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repositoryId = getRepositoryIdentity(root).id;
      const framework = store.loadFramework(repositoryId)!;
      assert.equal(framework.coverage.reduce((n, item) => n + item.attempted, 0), 23);
      assert.equal(framework.diagnostics.length, 23);
      assert.equal(framework.relationships.length, 0);
      assert.equal(new Set(framework.diagnostics.flatMap((item) => item.evidenceIds)).size, 23);
      assert.ok(framework.diagnostics.every((item) => item.refs.some((ref) => ref.localId && ref.range)));
      const { repositoryId: _repo, generationId: _gen, ...materialization } = framework;
      const candidate = createCandidateGeneration(repositoryId, result.generationId, CURRENT_INDEX_VERSION_DOMAINS, store.getGenerationManifest(repositoryId)!.files);
      store.beginCandidateGeneration(candidate);
      store.writeCandidateManifest(candidate.manifest);
      store.writeCandidateGraph(candidate.id, store.loadGraph(repositoryId), new Map());
      store.writeCandidateFramework(candidate.id, materialization);
      store.assertCandidateFrameworkComplete(repositoryId, candidate.id, materialization.frameworkResolutionVersion);
      store.writeCandidateFramework(candidate.id, { ...materialization, diagnostics: materialization.diagnostics.slice(1) });
      assert.throws(() => store.publishCandidateGeneration(candidate.id, { frameworkStaged: true }), (error: Error) => {
        const context = JSON.parse(error.message.slice(error.message.indexOf(": ") + 2));
        assert.equal(context.attemptedSites, 23);
        assert.equal(context.representedSites, 22);
        assert.equal(context.resolvedSites, 0);
        assert.equal(context.unresolvedSites, 22);
        assert.equal(context.unresolvedByReason.framework_target_unknown, 18);
        assert.equal(context.unresolvedByReason.coverage_unknown, undefined);
        assert.equal(context.coverageByCategory.coverage_unknown, 18);
        return /materialization is incomplete/.test(error.message);
      });
      assert.equal(store.getActiveGenerationId(repositoryId), result.generationId);
      const unknown = materialization.diagnostics.findIndex((item) => item.outcome === "unknown");
      const forged = materialization.diagnostics.map((item, index) => index === unknown
        ? { ...item, evidenceIds: ["forged-jsx-site"] } : item);
      store.writeCandidateFramework(candidate.id, { ...materialization, diagnostics: forged });
      assert.throws(() => store.assertCandidateFrameworkComplete(repositoryId, candidate.id, materialization.frameworkResolutionVersion), /materialization is incomplete/);
      store.writeCandidateFramework(candidate.id, materialization);
      store.writeCandidateFileFactBindings(candidate.id, []);
      assert.throws(() => store.assertCandidateFrameworkComplete(repositoryId, candidate.id, materialization.frameworkResolutionVersion), /materialization is incomplete/);
    } finally { store.close(); }
    const status = await getRepositoryStatusReadOnly(root);
    assert.equal(status.capabilities.graph.state, "ready");
    assert.equal(status.capabilities.lexical.state, "ready");
    assert.equal(status.framework.mayBeIncomplete, true);
    assert.equal(status.framework.authoritativeNegativeResults, false);
    const sync = await syncRepository(root, { skipGit: true });
    assert.ok(sync.kind === "reused" || sync.kind === "published");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
});

test("built CLI init and index publish graph and lexical together with unresolved JSX", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-react-cli-"));
  try {
    await writeFile(path.join(root, "App.tsx"), 'import React from "react";\nconst Page = React.lazy(() => import(dynamicPath));\nexport function App() { return <Page />; }');
    const cli = path.resolve("dist/cli.js");
    const run = (args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000 }));
    const initialized = run(["init", root, "--no-guidance", "--json"]);
    assert.equal(initialized.indexed, true);
    const status = await getRepositoryStatusReadOnly(root);
    assert.equal(status.capabilities.graph.state, "ready");
    assert.equal(status.capabilities.lexical.state, "ready");
    const indexed = run(["index", root, "--skip-git", "--json"]);
    assert.ok(indexed.kind === "reused" || indexed.kind === "published");
    const synced = run(["sync", root, "--skip-git", "--json"]);
    assert.ok(synced.kind === "reused" || synced.kind === "published");
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
    try {
      const snapshot = store.loadFramework(getRepositoryIdentity(root).id)!;
      assert.equal(snapshot.relationships.length, 0);
      assert.deepEqual(snapshot.diagnostics.map((item) => item.code), ["framework_target_unknown"]);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
});

test("missing resolved JSX output and stale candidate cannot replace active graph or lexical", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-react-missing-"));
  try {
    await writeFile(path.join(root, "App.tsx"), 'function Icon() { return null; }\nexport function App() { return <><Icon /><Icon /></>; }\nasync function load(importOriginal: any) { const actual = await importOriginal<typeof import("./other")>(); return actual; }');
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    if (result.kind !== "published") return;
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const id = getRepositoryIdentity(root).id;
      const binding = store.getGenerationManifest(id)!.files.find((item) => item.relativePath === "App.tsx")!;
      const facts = JSON.parse(store.getFactBlob(binding.factBlobKey)!);
      assert.equal(facts.parseStatus, "deterministic_partial");
      assert.equal(facts.frameworkSyntax.complete, true);
      const { repositoryId: _repo, generationId: _gen, ...framework } = store.loadFramework(id)!;
      assert.equal(framework.coverage[0]?.attempted, 2);
      assert.equal(framework.coverage[0]?.resolved, 1);
      const graph = store.loadGraph(id);
      const versions = CURRENT_INDEX_VERSION_DOMAINS;
      const candidate = createCandidateGeneration(id, result.generationId, versions, store.getGenerationManifest(id)!.files);
      store.beginCandidateGeneration(candidate);
      store.writeCandidateManifest(candidate.manifest);
      store.writeCandidateGraph(candidate.id, graph, new Map());
      const forged = framework.relationships.map((item) => ({ ...item,
        provenance: { ...item.provenance, evidenceIds: item.provenance.evidenceIds.map((id) => `${id}-forged`) },
      }));
      store.writeCandidateFramework(candidate.id, { ...framework, relationships: forged });
      assert.throws(() => store.publishCandidateGeneration(candidate.id, { frameworkStaged: true }), /materialization is incomplete/);
      const legacy = framework.relationships.map((item) => ({ ...item,
        provenance: { ...item.provenance, refs: [{ relativePath: "App.tsx", inputKey: "facts:App.tsx" }] },
      }));
      store.writeCandidateFramework(candidate.id, { ...framework, relationships: legacy });
      store.assertCandidateFrameworkComplete(id, candidate.id, framework.frameworkResolutionVersion);
      store.writeCandidateFramework(candidate.id, { ...framework, relationships: [] });
      assert.throws(() => store.publishCandidateGeneration(candidate.id, { frameworkStaged: true }), /materialization is incomplete/);
      store.writeCandidateFramework(candidate.id, { ...framework, coverage: [] });
      assert.throws(() => store.publishCandidateGeneration(candidate.id, { frameworkStaged: true }), /materialization is incomplete/);
      assert.equal(store.getActiveGenerationId(id), result.generationId);
      assert.deepEqual(store.loadGraph(id), graph);
      const stale = createCandidateGeneration(id, undefined, versions, []);
      store.beginCandidateGeneration(stale);
      store.writeCandidateManifest(stale.manifest);
      assert.throws(() => store.publishCandidateGeneration(stale.id), /parent generation is no longer active/);
      assert.equal(store.getActiveGenerationId(id), result.generationId);
      const contenders = [0, 1].map(() => createCandidateGeneration(id, result.generationId, versions, store.getGenerationManifest(id)!.files));
      for (const contender of contenders) {
        store.beginCandidateGeneration(contender);
        store.writeCandidateManifest(contender.manifest);
        store.writeCandidateGraph(contender.id, graph, new Map());
        store.copyActiveLexicalToCandidate(contender.id, ["App.tsx"]);
        store.writeCandidateFramework(contender.id, framework);
        store.assertCandidateFrameworkComplete(id, contender.id, framework.frameworkResolutionVersion);
      }
      store.publishCandidateGeneration(contenders[0]!.id, { requireGraph: true, requireLexical: true, frameworkStaged: true });
      assert.throws(() => store.publishCandidateGeneration(contenders[1]!.id, { requireGraph: true, requireLexical: true, frameworkStaged: true }), /parent generation is no longer active/);
      assert.equal(store.getActiveGenerationId(id), contenders[0]!.id);
      assert.deepEqual(store.loadGraph(id), graph);
    } finally { store.close(); }
    const status = await getRepositoryStatusReadOnly(root);
    assert.equal(status.capabilities.graph.state, "ready");
    assert.equal(status.capabilities.lexical.state, "ready");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
});
