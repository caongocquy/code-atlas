import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { reactNextAdapter } from "../src/core/framework/adapters/react-next.js";
import { analyzeFramework, resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION } from "../src/core/repository/index-version.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { FrameworkAnalysisContext } from "../src/core/framework/framework.types.js";

test("repeated JSX component uses produce one ordered lookup key per name", () => {
  const parsed = extractParsedFacts({
    language: "tsx", filePath: "App.tsx", contentHash: "repeated-jsx",
    factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION,
    source: "function App() { return <><Zed /><Alpha /><Zed /></>; }",
  });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") return;
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [], edges: [] }, facts: [{ relativePath: "App.tsx", facts: parsed.facts }],
  } satisfies FrameworkAnalysisContext;
  const result = reactNextAdapter.analyze(context);
  assert.equal(result.evidence.filter((item) => item.strategy === "jsx-component-usage").length, 3);
  assert.deepEqual(result.dependencies.map((item) => item.lookupKeys), [["jsx:Alpha"], ["jsx:Zed"]]);
});

test("forty distinct JSX components remain forty canonical dependencies", () => {
  const names = Array.from({ length: 40 }, (_, index) => `Component${String(index + 1).padStart(2, "0")}`);
  const parsed = extractParsedFacts({
    language: "tsx", filePath: "App.tsx", contentHash: "many-jsx",
    factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION,
    source: `function App() { return <>${[...names, names[0]].map((name) => `<${name} />`).join("")}</>; }`,
  });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") return;
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 100,
    config: [], graph: { nodes: [], edges: [] }, facts: [{ relativePath: "App.tsx", facts: parsed.facts }],
  } satisfies FrameworkAnalysisContext;
  const result = reactNextAdapter.analyze(context);
  assert.equal(result.evidence.filter((item) => item.strategy === "jsx-component-usage").length, 41);
  assert.equal(result.dependencies.length, 40);
  assert.deepEqual(result.dependencies.flatMap((item) => item.lookupKeys), names.map((name) => `jsx:${name}`));
  assert.ok(result.dependencies.every((item) => item.lookupKeys.length === 1 && item.lookupKeys.length <= 32));
  assert.equal(analyzeFramework(context, [reactNextAdapter]).dependencies.length, 40);
});

test("indexes repeated TSX JSX tags and persists unique lookup keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-repeated-jsx-"));
  try {
    await writeFile(path.join(root, "App.tsx"), "export function App() { return <><div /><span /><div /></>; }\n");
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      assert.deepEqual(store.loadFramework(repository.id)?.dependencies.filter((item) => item.ownerPath === "App.tsx").flatMap((item) => item.lookupKeys), ["jsx:div", "jsx:span"]);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes more than thirty-two distinct TSX components without losing dependencies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-many-jsx-"));
  const names = Array.from({ length: 40 }, (_, index) => `Component${String(index + 1).padStart(2, "0")}`);
  try {
    await writeFile(path.join(root, "App.tsx"), `${names.map((name) => `function ${name}() { return null; }`).join("\n")}\nexport function App() { return <>\n${[...names, names[0]].map((name) => `<${name} />`).join("\n")}\n</>; }\n`);
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      const framework = store.loadFramework(repository.id);
      const dependencies = framework?.dependencies.filter((item) => item.ownerPath === "App.tsx") ?? [];
      assert.equal(dependencies.length, 40);
      assert.deepEqual(dependencies.flatMap((item) => item.lookupKeys), names.map((name) => `jsx:${name}`));
      assert.equal(framework?.relationships.filter((item) => item.relationKind === "component_usage").flatMap((item) => item.provenance.evidenceIds).length, 41);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexes a TSX component through a persisted tsconfig path alias", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-path-alias-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
    await writeFile(path.join(root, "src", "Button.tsx"), "export function Button() { return null; }\n");
    await writeFile(path.join(root, "src", "App.tsx"), "import { Button } from '@/Button';\nexport function App() { return <Button />; }\n");
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      const framework = store.loadFramework(repository.id);
      assert.equal(framework?.relationships.filter((item) => item.relationKind === "component_usage").length, 1);
      assert.equal(framework?.config.find((item) => item.kind === "tsconfig")?.relativePath, "tsconfig.json");
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nested JSX imports use referenced tsconfig.app paths without baseUrl", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-referenced-alias-"));
  try {
    for (const directory of ["src/app/guards", "src/shared/components/ui", "src/features/auth/components", "src/shared/components/common/SearchField"]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }));
    await writeFile(path.join(root, "tsconfig.app.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } }, include: ["src"] }));
    await writeFile(path.join(root, "tsconfig.node.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./tooling/*"] } }, include: ["vite.config.ts"] }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "react-router-dom": "7.0.0" } }));
    await writeFile(path.join(root, "src/shared/components/ui/icon-button.tsx"), "export function IconButton() { return null; }\n");
    await writeFile(path.join(root, "src/features/auth/components/AuthSessionStatus.tsx"), "export function AuthSessionStatus() { return null; }\n");
    await writeFile(path.join(root, "src/shared/components/common/SearchField/index.tsx"), "export function SearchField() { return null; }\n");
    await writeFile(path.join(root, "src/app/guards/WorkspaceRouteGuard.tsx"), [
      "import { IconButton } from '@/shared/components/ui/icon-button';",
      "import { AuthSessionStatus } from '@/features/auth/components/AuthSessionStatus';",
      "import { SearchField } from '@/shared/components/common/SearchField';",
      "import { BrowserRouter } from 'react-router-dom';",
      "export function WorkspaceRouteGuard() { return <><IconButton /><AuthSessionStatus /><SearchField /><BrowserRouter /></>; }",
      "",
    ].join("\n"));
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      const framework = store.loadFramework(repository.id);
      assert.ok(framework?.config.some((item) => item.relativePath === "tsconfig.app.json"));
      assert.ok(framework?.config.some((item) => item.relativePath === "tsconfig.node.json"));
      assert.equal(framework?.relationships.filter((item) => item.relationKind === "component_usage").length, 3);
      assert.deepEqual(framework?.dependencies.filter((item) => item.ownerPath === "src/app/guards/WorkspaceRouteGuard.tsx").flatMap((item) => item.lookupKeys),
        ["jsx:AuthSessionStatus", "jsx:BrowserRouter", "jsx:IconButton", "jsx:SearchField"]);
    } finally { store.close(); }
    await writeFile(path.join(root, "tsconfig.app.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./missing/*"] } }, include: ["src"] }));
    const changed = await syncRepository(root, { skipGit: true });
    assert.equal(changed.kind, "failed");
    if (changed.kind === "failed") assert.match(changed.failure.message, /framework_target_unknown/);
    const after = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = after.ensureRepository(getRepositoryIdentity(root));
      assert.equal(after.getActiveGenerationId(repository.id), result.kind === "published" ? result.generationId : undefined);
    } finally { after.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("indexes JSX from a declared external package without a repository target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-external-jsx-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "react-router-dom": "7.0.0" } }));
    await writeFile(path.join(root, "App.tsx"), "import { BrowserRouter } from 'react-router-dom';\nexport function App() { return <BrowserRouter />; }\n");
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      assert.equal(store.loadFramework(repository.id)?.relationships.filter((item) => item.relationKind === "component_usage").length, 0);
      assert.deepEqual(store.loadFramework(repository.id)?.dependencies.filter((item) => item.ownerPath === "App.tsx").map((item) => item.lookupKeys), [["jsx:BrowserRouter"]]);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovers explicit local JSX component usage", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [
      { id: "app", type: "function", name: "App", file: "App.tsx", startLine: 1, endLine: 1 },
      { id: "child", type: "function", name: "Child", file: "App.tsx", startLine: 2, endLine: 2 },
    ], edges: [] },
    facts: [{ relativePath: "App.tsx", facts: { frameworkSyntax: { complete: true, nodes: [{ id: "jsx:1", kind: "jsx", name: "Child", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }] } } as never }],
  } satisfies FrameworkAnalysisContext;
  const result = reactNextAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.outputKind, "relationship");
  assert.equal(materialized.relationships.length, 1);
  assert.equal(materialized.relationships[0]?.relationKind, "component_usage");
});

test("reused JSX and symbol local IDs stay within each source file, including .tmp-init.js", () => {
  const files = [".tmp-init.js", "src/app/router/routes.tsx", "src/features/PlansSection.tsx"];
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [],
    analyzePaths: new Set(files), maxObservations: 10, config: [],
    graph: { nodes: files.flatMap((file, index) => [
      { id: `file:${index}`, type: "file" as const, name: file, file },
      { id: `owner:${index}`, type: "function" as const, name: "App", file, startLine: 1, endLine: 3 },
      ...(index === 0 ? [] : [{ id: `child:${index}`, type: "function" as const, name: "Child", file, startLine: 4, endLine: 4 }]),
    ]), edges: [] },
    facts: files.map((relativePath) => ({ relativePath, facts: {
      language: relativePath.endsWith(".tsx") ? "tsx" : "javascript",
      imports: [],
      frameworkSyntax: { complete: true, nodes: [{
        id: "jsx:1", kind: "jsx", name: "Child", ownerSymbolId: "symbol:1", ownerScopeId: "scope:1",
        range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [],
      }] },
    } as never })),
  } satisfies FrameworkAnalysisContext;
  const analyzed = reactNextAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, analyzed.evidence);
  for (const [index, file] of files.entries()) {
    const site = analyzed.evidence.find((item) => item.relativePath === file);
    assert.ok(site && site.outputKind === "relationship");
    assert.equal(site.evidenceId, `react-jsx:${file}:jsx:1`);
    assert.deepEqual(site.sourceCandidates, [{ kind: "language", nodeId: `owner:${index}` }]);
    assert.deepEqual(site.targetCandidates, index === 0 ? [] : [{ kind: "language", nodeId: `child:${index}` }]);
    assert.deepEqual(site.refs.map((ref) => ref.relativePath), [file]);
    assert.equal(analyzed.dependencies.find((item) => item.ownerPath === file)?.ownerPath, file);
  }
  assert.equal(materialized.relationships.length, 2);
  assert.deepEqual(materialized.diagnostics.map((item) => item.relativePath), [".tmp-init.js"]);
});

test("JSX uses its exact declaration owner before enclosing arrow functions", () => {
  const files = ["src/App.tsx", "test/App.test.tsx"];
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [],
    analyzePaths: new Set(files), maxObservations: 10, config: [],
    graph: { nodes: files.flatMap((file, index) => [
      { id: `outer:${index}`, type: "function" as const, name: "arrow_function@1", qualifiedName: "arrow_function@1", file, startLine: 1, endLine: 8 },
      { id: `inner:${index}`, type: "function" as const, name: "arrow_function@2", qualifiedName: "arrow_function@2", file, startLine: 3, endLine: 5 },
      { id: `child:${index}`, type: "function" as const, name: "Child", qualifiedName: "Child", file, startLine: 10, endLine: 10 },
    ]), edges: [] },
    facts: files.map((relativePath) => ({ relativePath, facts: {
      symbols: [
        { localId: "symbol:outer", name: "arrow_function@1", declaredQualifiedName: "arrow_function@1", kind: "function", range: { startLine: 1, endLine: 8 } },
        { localId: "symbol:inner", name: "arrow_function@2", declaredQualifiedName: "arrow_function@2", kind: "function", range: { startLine: 3, endLine: 5 } },
      ], imports: [], frameworkSyntax: { complete: true, nodes: [{
        id: "syntax:141", kind: "jsx", name: "Child", ownerSymbolId: "symbol:inner",
        range: { startLine: 4, endLine: 4 }, children: [], arguments: [], typeArguments: [],
      }] },
    } as never })),
  } satisfies FrameworkAnalysisContext;
  const analyzed = reactNextAdapter.analyze(context);
  for (const [index, file] of files.entries()) {
    const site = analyzed.evidence.find((item) => item.relativePath === file);
    assert.ok(site && site.outputKind === "relationship");
    assert.deepEqual(site.sourceCandidates, [{ kind: "language", nodeId: `inner:${index}` }]);
    assert.deepEqual(site.targetCandidates, [{ kind: "language", nodeId: `child:${index}` }]);
  }
  const materialized = resolveFrameworkEvidence(context, analyzed.evidence);
  assert.equal(materialized.relationships.length, 2);
  assert.equal(materialized.diagnostics.length, 0);
});

test("JSX containment fallback keeps unique-or-drop when exact owner is absent", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [],
    analyzePaths: new Set(["App.tsx"]), maxObservations: 10, config: [],
    graph: { nodes: [
      { id: "outer", type: "function" as const, name: "Outer", file: "App.tsx", startLine: 1, endLine: 8 },
      { id: "child", type: "function" as const, name: "Child", file: "App.tsx", startLine: 10, endLine: 10 },
    ], edges: [] },
    facts: [{ relativePath: "App.tsx", facts: { symbols: [], imports: [], frameworkSyntax: { complete: true, nodes: [{
      id: "jsx:1", kind: "jsx", name: "Child", ownerSymbolId: "symbol:missing",
      range: { startLine: 4, endLine: 4 }, children: [], arguments: [], typeArguments: [],
    }] } } as never }],
  } satisfies FrameworkAnalysisContext;
  const unique = resolveFrameworkEvidence(context, reactNextAdapter.analyze(context).evidence);
  assert.equal(unique.relationships.length, 1);
  const ambiguousContext = { ...context, graph: { ...context.graph, nodes: [
    ...context.graph.nodes, { id: "inner", type: "function" as const, name: "Inner", file: "App.tsx", startLine: 3, endLine: 5 },
  ] } } satisfies FrameworkAnalysisContext;
  const ambiguous = resolveFrameworkEvidence(ambiguousContext, reactNextAdapter.analyze(ambiguousContext).evidence);
  assert.equal(ambiguous.relationships.length, 0);
  assert.equal(ambiguous.diagnostics[0]?.code, "framework_target_ambiguous");
});

test("ignores intrinsic DOM tags", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [{ id: "app", type: "function", name: "App", file: "App.tsx", startLine: 1, endLine: 1 }], edges: [] },
    facts: [{ relativePath: "App.tsx", facts: { frameworkSyntax: { complete: true, nodes: ["div", "span", "button", "section", "article", "img", "output"].map((name, index) => ({ id: `jsx:${index}`, kind: "jsx", name, range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] })) } } as never }],
  } satisfies FrameworkAnalysisContext;
  const result = reactNextAdapter.analyze(context);
  assert.equal(result.evidence.length, 0);
  assert.equal(resolveFrameworkEvidence(context, result.evidence).coverage.reduce((total, item) => total + item.attempted, 0), 0);
});

test("resolves an imported JSX component only when its graph target is unique", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [
      { id: "app-file", type: "file", name: "App.tsx", file: "App.tsx" },
      { id: "app", type: "function", name: "App", file: "App.tsx", startLine: 1, endLine: 3 },
      { id: "button-file", type: "file", name: "components/Button.tsx", file: "components/Button.tsx" },
      { id: "button", type: "function", name: "Button", qualifiedName: "./components/Button.Button", file: "components/Button.tsx", startLine: 1, endLine: 2 },
    ], edges: [{ from: "app-file", to: "button-file", type: "imports" }, { from: "button-file", to: "button", type: "contains" }] },
    facts: [{ relativePath: "App.tsx", facts: { imports: [{ moduleSpecifier: "./components/Button", localName: "UI", importedName: "Button" }], frameworkSyntax: { complete: true, nodes: [{ id: "jsx:1", kind: "jsx", name: "UI", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [] }] } } } as never],
  } satisfies FrameworkAnalysisContext;
  const result = resolveFrameworkEvidence(context, reactNextAdapter.analyze(context).evidence);
  assert.equal(result.relationships[0]?.target.kind, "language");
  assert.equal(result.relationships[0]?.target.kind === "language" && result.relationships[0].target.nodeId, "button");
});

test("declared external JSX packages do not require repository graph targets", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [],
    analyzePaths: new Set(["src/App.tsx"]), maxObservations: 10,
    config: [{ relativePath: "package.json", scope: "", inputKey: "package:root", kind: "package" as const, values: { dependencies: { "react-router-dom": "7.0.0", next: "15.0.0" } }, complete: true }],
    graph: { nodes: [{ id: "app", type: "function" as const, name: "App", file: "src/App.tsx", startLine: 1, endLine: 4 }], edges: [] },
    facts: [{ relativePath: "src/App.tsx", facts: { symbols: [], imports: [
      { localName: "BrowserRouter", importedName: "BrowserRouter", moduleSpecifier: "react-router-dom" },
      { localName: "Link", importedName: "default", moduleSpecifier: "next/link" },
    ], frameworkSyntax: { complete: true, nodes: [
      { id: "jsx:1", kind: "jsx", name: "BrowserRouter", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [] },
      { id: "jsx:2", kind: "jsx", name: "Link", range: { startLine: 3, endLine: 3 }, children: [], arguments: [], typeArguments: [] },
    ] } } as never }],
  } satisfies FrameworkAnalysisContext;
  const analyzed = reactNextAdapter.analyze(context);
  assert.equal(analyzed.evidence.length, 0);
  assert.deepEqual(analyzed.dependencies.map((item) => item.lookupKeys), [["jsx:BrowserRouter"], ["jsx:Link"]]);
  assert.ok(analyzed.dependencies.every((item) => item.inputKeys.includes("package:root")));
});

test("path aliases and workspace packages resolve only to explicit project graph files", () => {
  const makeContext = (specifier: string, config: FrameworkAnalysisContext["config"]) => ({
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [],
    analyzePaths: new Set(["src/App.tsx"]), maxObservations: 10, config,
    graph: { nodes: [
      { id: "app-file", type: "file" as const, name: "src/App.tsx", file: "src/App.tsx" },
      { id: "app", type: "function" as const, name: "App", file: "src/App.tsx", startLine: 1, endLine: 3 },
      { id: "button-file", type: "file" as const, name: "src/components/Button.tsx", file: "src/components/Button.tsx" },
      { id: "button", type: "function" as const, name: "Button", qualifiedName: "Button", file: "src/components/Button.tsx", startLine: 1, endLine: 2 },
    ], edges: [{ from: "button-file", to: "button", type: "contains" as const }] },
    facts: [{ relativePath: "src/App.tsx", facts: { symbols: [], imports: [{ localName: "Button", importedName: "Button", moduleSpecifier: specifier }], frameworkSyntax: { complete: true, nodes: [{
      id: "jsx:1", kind: "jsx", name: "Button", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [],
    }] } } as never }],
  }) satisfies FrameworkAnalysisContext;
  const aliasConfig: FrameworkAnalysisContext["config"] = [{ relativePath: "tsconfig.json", scope: "", inputKey: "tsconfig:root", kind: "tsconfig", values: { compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }, complete: true }];
  const alias = makeContext("@/components/Button", aliasConfig);
  assert.equal(resolveFrameworkEvidence(alias, reactNextAdapter.analyze(alias).evidence).relationships.length, 1);
  const noBaseUrl = makeContext("@/components/Button", [{ relativePath: "jsconfig.json", scope: "", inputKey: "jsconfig:root", kind: "jsconfig", values: { compilerOptions: { paths: { "@/*": ["./src/*"] } } }, complete: true }]);
  assert.equal(resolveFrameworkEvidence(noBaseUrl, reactNextAdapter.analyze(noBaseUrl).evidence).relationships.length, 1);
  const windowsPaths = makeContext("@/components/Button", [{ relativePath: "tsconfig.app.json", scope: "", inputKey: "tsconfig:app", kind: "tsconfig", values: { compilerOptions: { paths: { "@/*": [".\\src\\*"] } }, include: ["src"] }, complete: true }]);
  assert.equal(resolveFrameworkEvidence(windowsPaths, reactNextAdapter.analyze(windowsPaths).evidence).relationships.length, 1);
  const baseUrl = makeContext("components/Button", [{ relativePath: "tsconfig.json", scope: "", inputKey: "tsconfig:base", kind: "tsconfig", values: { compilerOptions: { baseUrl: "src" } }, complete: true }]);
  assert.equal(resolveFrameworkEvidence(baseUrl, reactNextAdapter.analyze(baseUrl).evidence).relationships.length, 1);
  const missingAlias = makeContext("@/missing/Button", aliasConfig);
  assert.equal(resolveFrameworkEvidence(missingAlias, reactNextAdapter.analyze(missingAlias).evidence).diagnostics[0]?.code, "framework_target_unknown");
  const workspace = makeContext("@workspace/ui", [{ relativePath: "src/components/package.json", scope: "src/components", inputKey: "package:ui", kind: "package", values: { name: "@workspace/ui", main: "Button.tsx" }, complete: true }]);
  assert.equal(resolveFrameworkEvidence(workspace, reactNextAdapter.analyze(workspace).evidence).relationships.length, 1);
  const workspaceSubpath = makeContext("@workspace/ui/Button", [{ relativePath: "src/components/package.json", scope: "src/components", inputKey: "package:ui", kind: "package", values: { name: "@workspace/ui" }, complete: true }]);
  assert.equal(resolveFrameworkEvidence(workspaceSubpath, reactNextAdapter.analyze(workspaceSubpath).evidence).relationships.length, 1);
  const conflicting = makeContext("@/components/Button", [
    { relativePath: "tsconfig.json", scope: "", inputKey: "tsconfig:root", kind: "tsconfig", values: { files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.other.json" }] }, complete: true },
    { relativePath: "tsconfig.app.json", scope: "", inputKey: "tsconfig:app", kind: "tsconfig", values: { compilerOptions: { paths: { "@/*": ["./src/*"] } }, include: ["src"] }, complete: true },
    { relativePath: "tsconfig.other.json", scope: "", inputKey: "tsconfig:other", kind: "tsconfig", values: { compilerOptions: { paths: { "@/*": ["./other/*"] } }, include: ["src"] }, complete: true },
  ]);
  const conflictResult = resolveFrameworkEvidence(conflicting, reactNextAdapter.analyze(conflicting).evidence);
  assert.equal(conflictResult.relationships.length, 0);
  assert.equal(conflictResult.diagnostics[0]?.code, "framework_target_unknown");
});

test("resolves a renamed JSX import through a named barrel re-export", () => {
  const extract = (filePath: string, source: string) => {
    const language = filePath.endsWith(".tsx") ? "tsx" : "typescript";
    const parsed = extractParsedFacts({ language, filePath, contentHash: filePath, factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source });
    assert.equal(parsed.kind, "facts");
    if (parsed.kind !== "facts") throw parsed.error;
    return parsed.facts;
  };
  const appPath = "src/App.tsx";
  const barrelPath = "src/shared/components/common/index.ts";
  const componentPath = "src/shared/components/common/PageHeader.tsx";
  const appFacts = extract(appPath, "import { Header } from '@/shared/components/common';\nexport function App() { return <Header />; }\n");
  const barrelFacts = extract(barrelPath, "export { PageHeader as Header } from './PageHeader';\n");
  const componentFacts = extract(componentPath, "export function PageHeader() { return null; }\n");
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [],
    analyzePaths: new Set([appPath, barrelPath, componentPath]), maxObservations: 20,
    config: [{ relativePath: "tsconfig.app.json", scope: "", inputKey: "tsconfig:app", kind: "tsconfig" as const, values: { compilerOptions: { paths: { "@/*": [".\\src\\*"] } }, include: ["src"] }, complete: true }],
    graph: { nodes: [
      { id: "app-file", type: "file" as const, name: appPath, file: appPath },
      { id: "app", type: "function" as const, name: "App", qualifiedName: "App", file: appPath, startLine: 2, endLine: 2 },
      { id: "barrel-file", type: "file" as const, name: barrelPath, file: barrelPath },
      { id: "component-file", type: "file" as const, name: componentPath, file: componentPath },
      { id: "component", type: "function" as const, name: "PageHeader", qualifiedName: "PageHeader", file: componentPath, startLine: 1, endLine: 1 },
    ], edges: [{ from: "component-file", to: "component", type: "contains" as const }] },
    facts: [
      { relativePath: appPath, facts: appFacts },
      { relativePath: barrelPath, facts: barrelFacts },
      { relativePath: componentPath, facts: componentFacts },
    ],
  } satisfies FrameworkAnalysisContext;
  const materialized = resolveFrameworkEvidence(context, reactNextAdapter.analyze(context).evidence);
  assert.deepEqual(materialized.relationships.map((item) => item.target), [{ kind: "language", nodeId: "component" }]);
  assert.equal(materialized.diagnostics.length, 0);
});

test("records a named default export for default-as-named barrel traversal", () => {
  const parsed = extractParsedFacts({ language: "tsx", filePath: "src/PageHeader.tsx", contentHash: "default-export", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source: "export default function PageHeader() { return null; }\n" });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") return;
  assert.ok(parsed.facts.exports.some((item) => item.exportedName === "default" && item.localName === "PageHeader"));
  const assigned = extractParsedFacts({ language: "tsx", filePath: "src/App.tsx", contentHash: "default-assignment", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source: "function App() { return null; }\nexport default App;\n" });
  assert.equal(assigned.kind, "facts");
  if (assigned.kind === "facts") assert.ok(assigned.facts.exports.some((item) => item.exportedName === "default" && item.localName === "App"));
});

test("resolves chained default barrel exports and drops cycles, missing, and ambiguous exports", () => {
  const extract = (filePath: string, source: string) => {
    const parsed = extractParsedFacts({ language: filePath.endsWith(".tsx") ? "tsx" : "typescript", filePath, contentHash: filePath, factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source });
    assert.equal(parsed.kind, "facts");
    if (parsed.kind !== "facts") throw parsed.error;
    return parsed.facts;
  };
  const appPath = "src/App.tsx", indexPath = "src/shared/components/common/index.ts";
  const middlePath = "src/shared/components/common/middle.ts", pagePath = "src/shared/components/common/PageHeader.tsx";
  const cycleA = "src/cycle/a.ts", cycleB = "src/cycle/b.ts", cycleC = "src/cycle/c.tsx";
  const makeContext = (barrelSources: Array<[string, string]>, componentSources: Array<[string, string]>) => {
    const files = [appPath, ...barrelSources.map(([file]) => file), ...componentSources.map(([file]) => file)];
    const allFacts = new Map(files.map((file) => [file, extract(file, file === appPath
      ? "import { Header } from '@/shared/components/common';\nexport function App() { return <Header />; }\n"
      : [...barrelSources, ...componentSources].find(([path]) => path === file)![1])]));
    const graphNodes = files.flatMap((file, fileIndex) => {
      const facts = allFacts.get(file)!;
      return [
        { id: `file:${fileIndex}`, type: "file" as const, name: file, file },
        ...facts.symbols.map((symbol, symbolIndex) => ({ id: `${file}:${symbolIndex}`, type: symbol.kind, name: symbol.name, qualifiedName: symbol.declaredQualifiedName, file, startLine: symbol.range.startLine, endLine: symbol.range.endLine })),
      ];
    });
    const graphEdges = graphNodes.filter((node) => node.type !== "file").map((node) => ({ from: `file:${files.indexOf(node.file)}`, to: node.id, type: "contains" as const }));
    return {
      repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [], analyzePaths: new Set(files), maxObservations: 30,
      config: [{ relativePath: "tsconfig.app.json", scope: "", inputKey: "tsconfig:app", kind: "tsconfig" as const, values: { compilerOptions: { paths: { "@/*": [".\\src\\*"] } }, include: ["src"] }, complete: true }],
      graph: { nodes: graphNodes, edges: graphEdges }, facts: files.map((relativePath) => ({ relativePath, facts: allFacts.get(relativePath)! })),
    } satisfies FrameworkAnalysisContext;
  };

  const chained = makeContext([
    [indexPath, "export { default as Header } from './middle';\n"],
    [middlePath, "export { default } from './PageHeader';\n"],
  ], [[pagePath, "export default function PageHeader() { return null; }\n"]]);
  const chainedResult = resolveFrameworkEvidence(chained, reactNextAdapter.analyze(chained).evidence);
  assert.deepEqual(chainedResult.relationships.map((item) => item.target.nodeId), [`${pagePath}:0`]);
  assert.equal(chainedResult.diagnostics.length, 0);

  const cyclic = makeContext([[cycleA, "export { Widget } from './b';\nexport { Widget } from './c';\n"], [cycleB, "export { Widget } from './a';\n"]], [[cycleC, "export function Widget() { return null; }\n"]]);
  const cycleApp = { ...cyclic, facts: cyclic.facts.map((item) => item.relativePath === appPath ? { ...item, facts: extract(appPath, "import { Widget } from './cycle/a';\nexport function App() { return <Widget />; }\n") } : item) } satisfies FrameworkAnalysisContext;
  const cycleResult = resolveFrameworkEvidence(cycleApp, reactNextAdapter.analyze(cycleApp).evidence);
  assert.equal(cycleResult.relationships.length, 1);
  assert.equal(cycleResult.diagnostics.length, 0);

  const missing = makeContext([[indexPath, "export { Missing } from './missing';\n"]], []);
  const missingResult = resolveFrameworkEvidence(missing, reactNextAdapter.analyze(missing).evidence);
  assert.equal(missingResult.relationships.length, 0);
  assert.equal(missingResult.diagnostics[0]?.code, "framework_target_unknown");

  const ambiguous = makeContext([[indexPath, "export { Widget } from './a';\nexport { Widget } from './b';\n"]], [
    ["src/shared/components/common/a.tsx", "export function Widget() { return null; }\n"],
    ["src/shared/components/common/b.tsx", "export function Widget() { return null; }\n"],
  ]);
  const ambiguousApp = { ...ambiguous, facts: ambiguous.facts.map((item) => item.relativePath === appPath ? { ...item, facts: extract(appPath, "import { Widget } from '@/shared/components/common';\nexport function App() { return <Widget />; }\n") } : item) } satisfies FrameworkAnalysisContext;
  const ambiguousResult = resolveFrameworkEvidence(ambiguousApp, reactNextAdapter.analyze(ambiguousApp).evidence);
  assert.equal(ambiguousResult.relationships.length, 0);
  assert.equal(ambiguousResult.diagnostics[0]?.code, "framework_target_ambiguous");
});

test("treats use-client directives as file-boundary classifications, not JSX dependencies", () => {
  const parsed = extractParsedFacts({ language: "tsx", filePath: "src/Widget.tsx", contentHash: "use-client", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source: "\"use client\";\nexport function Widget() { return null; }\n" });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") return;
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [{ framework: "next", scope: "root", configured: true, observed: false, capabilities: ["next.execution_boundary"], refs: [], complete: true }],
    analyzePaths: new Set(["src/Widget.tsx"]), maxObservations: 10, config: [],
    graph: { nodes: [
      { id: "file", type: "file" as const, name: "src/Widget.tsx", file: "src/Widget.tsx" },
      { id: "widget", type: "function" as const, name: "Widget", qualifiedName: "Widget", file: "src/Widget.tsx", startLine: 2, endLine: 2 },
    ], edges: [] },
    facts: [{ relativePath: "src/Widget.tsx", facts: parsed.facts }],
  } satisfies FrameworkAnalysisContext;
  const analyzed = reactNextAdapter.analyze(context);
  assert.equal(analyzed.dependencies.flatMap((item) => item.lookupKeys).length, 0);
  const boundary = analyzed.evidence.find((item) => item.strategy === "next-execution-directive");
  assert.ok(boundary?.outputKind === "classification");
  assert.deepEqual(boundary.subjectCandidates, [{ kind: "language", nodeId: "file" }]);
  const materialized = resolveFrameworkEvidence(context, analyzed.evidence);
  assert.equal(materialized.classifications[0]?.classificationValue, "client");
  assert.equal(materialized.diagnostics.length, 0);
  const reactOnly = reactNextAdapter.analyze({ ...context, detections: [] });
  assert.equal(reactOnly.evidence.some((item) => item.strategy === "next-execution-directive"), false);
});

test("classifies bound dynamic JSX component values without inventing targets", () => {
  const cases = [
    ["src/Navigation.tsx", "export function App({ icon: Icon }: { icon: (props: { size: number }) => null }) { return <Icon size={16} />; }\n", "Icon"],
    ["src/Lookup.tsx", "export function App({ icons, name }: { icons: Record<string, () => null>; name: string }) { const Icon = icons[name]; return <Icon />; }\n", "Icon"],
    ["src/Polymorphic.tsx", "export function App({ asChild, Slot }: { asChild: boolean; Slot: { Root: () => null } }) { const Comp = asChild ? Slot.Root : \"button\"; return <Comp />; }\n", "Comp"],
  ] as const;
  for (const [filePath, source, target] of cases) {
    const parsed = extractParsedFacts({ language: "tsx", filePath, contentHash: filePath, factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source });
    assert.equal(parsed.kind, "facts");
    if (parsed.kind !== "facts") continue;
    assert.ok(parsed.facts.frameworkSyntax?.nodes.some((item) => item.kind === "jsx" && item.name === target));
    const symbols = parsed.facts.symbols.map((item, index) => ({ id: `symbol:${index}`, type: item.kind, name: item.name, qualifiedName: item.declaredQualifiedName, file: filePath, startLine: item.range.startLine, endLine: item.range.endLine }));
    const context = {
      repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", detections: [], analyzePaths: new Set([filePath]), maxObservations: 10,
      config: [], graph: { nodes: [{ id: `file:${filePath}`, type: "file" as const, name: filePath, file: filePath }, ...symbols], edges: [] },
      facts: [{ relativePath: filePath, facts: parsed.facts }],
    } satisfies FrameworkAnalysisContext;
    const analyzed = reactNextAdapter.analyze(context);
    const evidence = analyzed.evidence.find((item) => item.outputKind === "relationship" && item.relativePath === filePath);
    assert.ok(evidence?.outputKind === "relationship");
    assert.equal(evidence.targetCandidates.length, 0);
    assert.equal(evidence.state, "unsupported");
    assert.equal(evidence.supported, false);
    assert.equal(evidence.refs[0]?.localId, parsed.facts.frameworkSyntax?.nodes.find((item) => item.kind === "jsx" && item.name === target)?.id);
    assert.ok(evidence.refs[0]?.range);
    const resolved = resolveFrameworkEvidence(context, analyzed.evidence);
    assert.equal(resolved.relationships.length, 0);
    assert.equal(resolved.diagnostics[0]?.code, "framework_construct_unsupported");
  }
});

test("keeps type-query grammar gaps partial while preserving complete framework syntax", () => {
  const source = [
    "vi.mock('react-router-dom', async (importOriginal) => {",
    "  const actual = await importOriginal<typeof import('react-router-dom')>();",
    "  return actual;",
    "});",
    "vi.mock('@/shared/config/env', async () => {",
    "  const actual = await vi.importActual<typeof import('@/shared/config/env')>(",
    "    '@/shared/config/env',",
    "  );",
    "  return actual;",
    "});",
    "export function App() { return <main />; }",
  ].join("\n");
  const parsed = extractParsedFacts({ language: "tsx", filePath: "src/App.test.tsx", contentHash: "type-query-import", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") return;
  assert.equal(parsed.facts.parseStatus, "deterministic_partial");
  assert.ok(parsed.facts.parserDiagnostics.length > 0);
  assert.equal(parsed.facts.frameworkSyntax?.complete, true);
  assert.ok(parsed.facts.frameworkSyntax?.nodes.some((item) => item.kind === "jsx" && item.name === "main"));

  const malformed = extractParsedFacts({ language: "tsx", filePath: "src/Malformed.test.tsx", contentHash: "malformed", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION, source: "export function App( { return <main />; }\n" });
  assert.equal(malformed.kind, "facts");
  if (malformed.kind === "facts") {
    assert.equal(malformed.facts.parseStatus, "deterministic_partial");
    assert.equal(malformed.facts.frameworkSyntax?.complete, false);
  }
});
