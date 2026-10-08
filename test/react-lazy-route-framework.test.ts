import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const helperSource = `
import { lazy } from "react";
export async function importWithChunkRetry<T>(importer: () => Promise<T>): Promise<T> {
  return importer();
}
export function lazyRouteNamed<T extends Record<string, unknown>>(importer: () => Promise<T>, exportName: keyof T & string) {
  return lazy(() => importWithChunkRetry(importer).then((module) => ({ default: module[exportName] })));
}
`;

async function write(root: string, file: string, source: string): Promise<void> {
  const full = path.join(root, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, source);
}

async function fixture(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-react-lazy-"));
  try {
    await write(root, "package.json", JSON.stringify({ dependencies: { react: "19.0.0" } }));
    await write(root, "tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }));
    await write(root, "tsconfig.app.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx", paths: { "@/*": ["./src/*"] } }, include: ["src/**/*"] }));
    await write(root, "src/app/router/lazy-route.ts", helperSource);
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function state(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(root));
  return { store, repositoryId: repository.id };
}

test("export const bindings are represented as named export facts", () => {
  const parsed = extractParsedFacts({
    language: "typescript", filePath: "src/lazy-pages.ts",
    source: 'export const Page = lazyRouteNamed(() => import("./Page"), "Page"), Other = 1;\n',
    contentHash: "react-lazy-export-const", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") return;
  assert.deepEqual(parsed.facts.exports.map((item) => [item.exportedName, item.localName]), [["Page", "Page"], ["Other", "Other"]]);
});

test("18 named lazy routes resolve to their exact declared page functions through their barrel", async () => {
  await fixture(async (root) => {
    const count = 18;
    const declarations: string[] = [];
    const usages: string[] = [];
    for (let i = 0; i < count; i++) {
      const name = `Page${i}`;
      declarations.push(`export const ${name} = lazyRouteNamed(() => import("@/features/${name}"), "${name}");`);
      usages.push(`<${name} />`);
      await write(root, `src/features/${name}.tsx`, `export function ${name}() { return <div />; }\n`);
    }
    await write(root, "src/app/router/lazy-pages.ts", [
      'import { lazyRouteNamed } from "./lazy-route";', ...declarations, "",
    ].join("\n"));
    await write(root, "src/app/router/routes.tsx", [
      'import { ' + Array.from({ length: count }, (_, i) => `Page${i}`).join(", ") + ' } from "./lazy-pages";',
      `export function Routes() { return <>${usages.join("")}</>; }`, "",
    ].join("\n"));

    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published", first.kind === "failed" ? first.failure.message : undefined);
    if (first.kind !== "published") return;

    const { store, repositoryId } = state(root);
    try {
      const framework = store.loadFramework(repositoryId);
      const graph = store.loadGraph(repositoryId);
      assert.ok(framework);
      assert.equal(framework.diagnostics.length, 0, JSON.stringify(framework.diagnostics));
      const lazyRelations = framework.relationships.filter((item) => item.relationKind === "component_usage"
        && item.target.kind === "language" && graph.nodes.some((node) => node.id === item.target.nodeId && /^Page\d+$/.test(node.name)));
      assert.equal(lazyRelations.length, count);
      for (let i = 0; i < count; i++) {
        const name = `Page${i}`;
        const target = graph.nodes.find((node) => node.name === name && node.file === `src/features/${name}.tsx`);
        assert.ok(target, name);
        assert.ok(lazyRelations.some((item) => item.target.kind === "language" && item.target.nodeId === target.id), name);
      }
    } finally { store.close(); }

    const noOp = await syncRepository(root, { skipGit: true, diagnosticTimings: true });
    assert.equal(noOp.kind, "reused", noOp.kind === "failed" ? noOp.failure.message : undefined);

    // Editing one exported target invalidates the old framework proof.
    await write(root, "src/features/Page0.tsx", "export function RenamedPage() { return <div />; }\n");
    const invalid = await syncRepository(root, { skipGit: true });
    assert.equal(invalid.kind, "failed");
    if (invalid.kind !== "failed") return;
    assert.match(invalid.failure.message, /Candidate framework materialization is incomplete/);
    assert.match(invalid.failure.message, /framework_target_unknown/);
    const current = state(root);
    try { assert.equal(current.store.getActiveGenerationId(current.repositoryId), first.generationId); }
    finally { current.store.close(); }
  });
});

test("computed export names and dynamic import paths remain unknown, never guessed", async () => {
  for (const variant of [
    'lazyRouteNamed(() => import("@/features/Page"), dynamicName)',
    'lazyRouteNamed(() => import(dynamicPath), "Page")',
    'lazyRouteNamed(() => import("@/features/Page"), "Missing")',
  ]) {
    await fixture(async (root) => {
      await write(root, "src/features/Page.tsx", "export function Page() { return <div />; }\n");
      await write(root, "src/app/router/lazy-pages.ts", `import { lazyRouteNamed } from "./lazy-route";\nexport const Page = ${variant};\n`);
      await write(root, "src/app/router/routes.tsx", 'import { Page } from "./lazy-pages";\nexport function Routes() { return <Page />; }\n');
      const indexed = await indexRepository(root, { skipGit: true });
      assert.equal(indexed.kind, "failed", variant);
      if (indexed.kind === "failed") assert.match(indexed.failure.message, /framework_target_unknown/, variant);
    });
  }
});

test("unverified same-name wrappers cannot manufacture framework edges", async () => {
  await fixture(async (root) => {
    await write(root, "src/features/Page.tsx", "export function Page() { return <div />; }\n");
    await write(root, "src/app/router/lazy-route.ts", 'export function lazyRouteNamed(importer: unknown, name: string) { return name; }\n');
    await write(root, "src/app/router/lazy-pages.ts", 'import { lazyRouteNamed } from "./lazy-route";\nexport const Page = lazyRouteNamed(() => import("@/features/Page"), "Page");\n');
    await write(root, "src/app/router/routes.tsx", 'import { Page } from "./lazy-pages";\nexport function Routes() { return <Page />; }\n');
    const indexed = await indexRepository(root, { skipGit: true });
    assert.equal(indexed.kind, "failed");
    if (indexed.kind === "failed") assert.match(indexed.failure.message, /framework_target_unknown/);
  });
});
