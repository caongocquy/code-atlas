import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS as versions } from "../src/core/repository/index-version.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";

for (const language of ["typescript", "tsx"] as const) {
  test(`current ${language} facts survive encode/persist/reopen and path reuse`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-facts-roundtrip-"));
    try {
      const source = 'import { helper } from "./dep"; export { helper } from "./dep"; export default function run() { const fn = (x: number) => helper(x); return fn(1); }' + (language === "tsx" ? ' const view = () => <Widget onClick={() => helper(2)} />;' : "");
      const input = { source, language, contentHash: "snapshot", factsVersion: versions.factsVersion, factsSchemaVersion: versions.factsSchemaVersion };
      const outcome = extractParsedFacts({ ...input, filePath: `original.${language === "tsx" ? "tsx" : "ts"}` });
      assert.equal(outcome.kind, "facts"); if (outcome.kind !== "facts") return;
      const facts = outcome.facts, key = factBlobKey(facts), expected = { key, ...input, parserIdentity: facts.parserIdentity };
      const encoded = encodeFacts(facts);
      assert.equal(decodeFacts(encoded, expected).kind, "hit");
      const database = path.join(root, "atlas.db");
      const first = new AtlasStore(database); try { first.putFactBlob(key, facts); } finally { first.close(); }
      const second = new AtlasStore(database); try { assert.equal(second.getFactBlob(key), encoded); assert.equal(decodeFacts(second.getFactBlob(key), expected).kind, "hit"); } finally { second.close(); }
      const renamed = extractParsedFacts({ ...input, filePath: `other/renamed.${language === "tsx" ? "tsx" : "ts"}` });
      assert.equal(renamed.kind, "facts"); if (renamed.kind === "facts") assert.equal(encodeFacts(renamed.facts), encoded);
      const owners = new Set(facts.symbols.map(s => s.localId));
      assert.ok(facts.parameters.every(p => owners.has(p.ownerSymbolId)));
      assert.ok(facts.frameworkSyntax?.nodes.length);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("delta sync reuses anonymous/default-export TSX facts without reparsing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-facts-reuse-"));
  try {
    await writeFile(path.join(root, "view.tsx"), "export default function View() { const render = () => <div />; return render(); }");
    await writeFile(path.join(root, "a.ts"), "export function a() { return 1; }");
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    await writeFile(path.join(root, "a.ts"), "export function a() { return 2; }");
    const result = await syncRepository(root, { skipGit: true });
    assert.equal(result.kind, "published"); if (result.kind !== "published") return;
    assert.equal(result.counters.filesParsed, 1);
    assert.equal(result.counters.factCacheHits, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dotted source imports retain bounded ownership; missing dependencies stay conservative", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-import-ownership-"));
  try {
    await writeFile(path.join(root, "a.service.ts"), "export function a() { return 1; }");
    await writeFile(path.join(root, "consumer.ts"), 'import { a } from "./a.service"; export function run() { return a(); }');
    await writeFile(path.join(root, "view.css"), "body { color: red; }");
    await writeFile(path.join(root, "unrelated.ts"), "export function unrelated() { return 1; }");
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    await writeFile(path.join(root, "a.service.ts"), "export function a() { return 2; }");
    const delta = await syncRepository(root, { skipGit: true });
    assert.equal(delta.kind, "published"); if (delta.kind !== "published") return;
    assert.deepEqual(delta.plan.resolvePaths, ["a.service.ts", "consumer.ts"]);
    assert.equal(delta.plan.fullGraphResolution, false);
    assert.equal(delta.counters.frameworkFilesReused, 2);
    await writeFile(path.join(root, "consumer.ts"), 'import { a } from "./a.service"; import "./missing.css"; export function run() { return a(); }');
    const missing = await syncRepository(root, { skipGit: true });
    assert.equal(missing.kind, "published"); if (missing.kind !== "published") return;
    assert.ok(missing.plan.reasons.includes("unresolved_import_ownership"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
