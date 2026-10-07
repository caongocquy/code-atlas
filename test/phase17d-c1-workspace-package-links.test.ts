import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

async function fixture(manifests: Array<Record<string, unknown> | null>, sources?: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-c1-")), repos: string[] = [];
  for (const [i, manifest] of manifests.entries()) {
    const repo = path.join(root, String(i)); repos.push(repo);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src/main.ts"), sources?.[i] ?? "export const value = 1;");
    if (manifest) await writeFile(path.join(repo, "package.json"), JSON.stringify(manifest));
    const indexed = await indexRepository(repo, { skipGit: true, scipIndexer: { discover: async () => ({ status: "unavailable" as const }), index: async () => [] } });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
  }
  const server = createMcpServer(), client = new Client({ name: "c1-proof", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(ct), server.connect(st)]);
  const call = async (args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: "workspace_package_links", arguments: { repositories: repos, ...args } });
    assert.equal(r.isError, undefined, JSON.stringify(r)); return r.structuredContent as any;
  };
  return { root, repos, client, call, close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}
const id = (repo: string) => getRepositoryIdentity(repo).id;
const source = { name: "@acme/app", dependencies: { "@acme/contracts": "^1.2.3" } };
const target = { name: "@acme/contracts", version: "9.0.0", private: true };

test("workspace_package_links dedicated read-only MCP contract", async () => {
  const f = await fixture([]);
  try {
    const tool = (await f.client.listTools()).tools.find(t => t.name === "workspace_package_links");
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.properties?.repoPath, undefined);
  } finally { await f.close(); }
});
test("workspace_package_links real indexed root manifest produces exact qualified candidate", async () => {
  const f = await fixture([source, target]);
  try {
    const before = await Promise.all(f.repos.map(r => readFile(path.join(r, ".codeatlas/atlas.db"))));
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    assert.equal(r.links.length, 1); assert.equal(r.counts.candidateLinks.total, 1);
    const link = r.links[0];
    assert.deepEqual(link.relation, { kind: "declared_dependency_candidate", scope: "workspace_cross_repo", nameMatch: "exact" });
    assert.equal(link.source.dependency.rawSpec, "^1.2.3");
    assert.equal(link.target.package.name, "@acme/contracts"); assert.equal(link.target.package.version, "9.0.0");
    for (const endpoint of [link.source, link.target]) {
      assert.equal(endpoint.generationId, r.generationVector.find((g: any) => g.repositoryId === endpoint.repositoryId).generationId);
      assert.equal(endpoint.package.provenance.repositoryId, endpoint.repositoryId);
      assert.match(endpoint.package.provenance.inputKey, /^package:package.json:[a-f0-9]{64}$/);
    }
    assert.match(r.runtimeLimitation, /do not prove installation/i);
    assert.deepEqual(await Promise.all(f.repos.map(r => readFile(path.join(r, ".codeatlas/atlas.db")))), before);
    assert.deepEqual(await f.call({ repositories: [...f.repos].reverse(), sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) }), r);
  } finally { await f.close(); }
});

for (const kind of ["dependencies","devDependencies","peerDependencies","optionalDependencies"]) test(`workspace_package_links preserves ${kind}, source without name, private/version-independent duplicate targets`, async () => {
  const f = await fixture([{ [kind]: { "@acme/contracts": "1.2.3" } }, target, { ...target, version: "0.0.1" }]);
  try {
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), dependencyKind: kind });
    assert.equal(r.links.length, 2); assert.equal(r.counts.candidateLinks.total, 2);
    assert.equal(r.dependencyDeclarations[0].cardinality, "many");
    assert.equal(r.links[0].source.package, undefined);
    assert.ok(r.links.every((l: any) => l.source.dependency.kind === kind));
    assert.equal(new Set(r.links.map((l: any) => l.target.repositoryId)).size, 2);
    assert.notEqual(r.links[0].target.package.provenance.inputKey, r.links[1].target.package.provenance.inputKey);
    const bounded = await f.call({ sourceRepositoryId: id(f.repos[0]), dependencyKind: kind, limit: 1 });
    assert.equal(bounded.links.length, 1); assert.equal(bounded.counts.candidateLinks.total, 2); assert.equal(bounded.counts.candidateLinks.omitted, 1);
  } finally { await f.close(); }
});
test("workspace_package_links supports exactly the registry grammar and keeps all other specs unresolved", async () => {
  const positive = ["1.2.3","^1.2.3","~1.2.3","*","latest","next","0.0.0","9007199254740991.0.0"];
  const negative: unknown[] = ["npm:@acme/contracts@^1.0.0","workspace:*","file:../contracts","link:../contracts","portal:../contracts",
    "git+https://example.com/x.git","user/repo","https://example.com/x.tgz","../contracts","1.2.3-beta","1.2.3+build",">=1.0.0 <2.0.0",
    "1","1.2","beta"," 1.2.3","1.2.3 ","01.2.3","^~1.2.3","9007199254740992.0.0",12,null,{},[]];
  const f = await fixture([source, target, { name: "local-contracts" }]);
  try {
    for (const spec of [...positive,...negative]) {
      const manifest = { dependencies: { "@acme/contracts": spec, "local-contracts": "npm:@acme/contracts@^1.0.0" } };
      await writeFile(path.join(f.repos[0], "package.json"), JSON.stringify(manifest));
      assert.equal((await indexRepository(f.repos[0], { skipGit: true })).kind, "published");
      const r = await f.call({ sourceRepositoryId: id(f.repos[0]) });
      assert.equal(r.links.length, positive.includes(spec as string) ? 1 : 0, JSON.stringify(spec));
      assert.equal(r.counts.unresolvedSpecs.total, positive.includes(spec as string) ? 1 : 2);
      assert.ok(r.dependencyDeclarations.filter((d: any) => !d.source.dependency.supported).every((d: any) => d.status === "unresolved" && d.reason));
      assert.equal(r.counts.unmatchedDependencies.total, 0);
    }
  } finally { await f.close(); }
});
test("workspace_package_links exact name validation, independent roles and four separate section declarations", async () => {
  const f = await fixture([source, target]);
  try {
    const kinds = ["dependencies","devDependencies","peerDependencies","optionalDependencies"];
    await writeFile(path.join(f.repos[0], "package.json"), JSON.stringify({ name: "INVALID", ...Object.fromEntries(kinds.map(k => [k,{ "@acme/contracts": "*" }])) }));
    await indexRepository(f.repos[0], { skipGit: true });
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]), packageName: "@acme/contracts" });
    assert.equal(r.links.length, 4); assert.equal(new Set(r.links.map((l: any) => l.source.dependency.kind)).size, 4);
    assert.equal(r.repositories.find((m: any) => m.repositoryId === id(f.repos[0])).packageDeclarationCoverage.status, "not_requested");
    assert.equal((await f.call({ sourceRepositoryId: id(f.repos[0]), packageName: "@acme/app" })).links.length, 0);
    for (const name of ["@Acme/contracts","@acme/contracts "," contracts","node_modules","favicon.ico","@acme/contracts/sub","%40acme/contracts",".foo","a".repeat(215)]) {
      const bad = await f.client.callTool({ name: "workspace_package_links", arguments: { repositories: f.repos, packageName: name } });
      assert.equal(bad.isError, true, name);
    }
    for (const names of ["contracts","@acme/contract","@other/contracts","@acme/contracts-extra"]) {
      await writeFile(path.join(f.repos[1], "package.json"), JSON.stringify({ name: names }));
      await indexRepository(f.repos[1], { skipGit: true });
      assert.equal((await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) })).links.length, 0);
    }
  } finally { await f.close(); }
});
test("workspace_package_links selector validation and workspace v1 exclude unlisted siblings", async () => {
  const f = await fixture([source,target,target]);
  try {
    const config = path.join(f.root, "workspace.json");
    await writeFile(config, JSON.stringify({ version: 1, repositories: [{ path: "0" },{ path: "1" }] }));
    const r = await f.call({ repositories: undefined, workspacePath: config, sourceRepositoryId: id(f.repos[0]) });
    assert.equal(r.repositories.length, 2); assert.equal(r.links.length, 1);
    assert.equal((await f.call({ repositories: [f.repos[0]] })).links.length, 0);
    for (const args of [{ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[0]) },{ sourceRepositoryId: "missing" },{ workspacePath: config },
      { dependencyKind: "bundledDependencies" },{ repositories: [f.repos[0],f.repos[0]] },{ limit: 1001 },{ detail: "x" },{ repoPath: f.repos[0] }]) {
      assert.equal((await f.client.callTool({ name: "workspace_package_links", arguments: { repositories: f.repos,...args } })).isError, true, JSON.stringify(args));
    }
  } finally { await f.close(); }
});
test("workspace_package_links imports, tsconfig aliases, folder/display/remote and nested manifests never create links", async () => {
  const f = await fixture([{ name: "app" },{ name: "wrong-name" }], ['import { Contract } from "@acme/contracts"; export const value = Contract;', "export const Contract = 1;"]);
  try {
    await writeFile(path.join(f.repos[0], "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@acme/contracts/*": ["../1/*"] } } }));
    await mkdir(path.join(f.repos[1], "packages/contracts"), { recursive: true });
    await writeFile(path.join(f.repos[1], "packages/contracts/package.json"), JSON.stringify(target));
    for (const repo of f.repos) {
      await mkdir(path.join(repo, ".git"), { recursive: true });
      await writeFile(path.join(repo, ".git/config"), '[remote "origin"]\n url = https://example.com/acme/contracts.git\n');
      await indexRepository(repo, { skipGit: true });
    }
    assert.equal((await f.call()).links.length, 0);
    await writeFile(path.join(f.repos[0], "package.json"), JSON.stringify(source)); await indexRepository(f.repos[0], { skipGit: true });
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    assert.equal(r.links.length, 0); assert.equal(r.counts.unmatchedDependencies.total, 1);
    assert.ok(r.packageDeclarations.every((p: any) => p.name !== "@acme/contracts"));
  } finally { await f.close(); }
});
function mutateConfig(repo: string, change: (config: any[]) => unknown) {
  const db = new DatabaseSync(path.join(repo, ".codeatlas/atlas.db"));
  try {
    const row = db.prepare("SELECT config_json FROM generation_framework_state").get() as { config_json: string };
    db.prepare("UPDATE generation_framework_state SET config_json = ?").run(JSON.stringify(change(JSON.parse(row.config_json))));
  } finally { db.close(); }
}
for (const corruption of ["missing","duplicate","complete","inputKey","scope","kind","values","section","name","json","database","legacy"]) test(`workspace_package_links isolates ${corruption} target and never converts unknown into unmatched`, async () => {
  const f = await fixture([source,target,target]);
  try {
    if (corruption === "missing") mutateConfig(f.repos[1], () => []);
    else if (corruption === "duplicate") mutateConfig(f.repos[1], c => [...c,...c]);
    else if (corruption === "complete") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,complete: false })));
    else if (corruption === "inputKey") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,inputKey: "package:package.json:wrong" })));
    else if (corruption === "scope") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,scope: "nested" })));
    else if (corruption === "kind") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,kind: "tsconfig" })));
    else if (corruption === "values") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,values: [] })));
    else if (corruption === "section") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,values: { ...v.values,dependencies: [] } })));
    else if (corruption === "name") mutateConfig(f.repos[1], c => c.map(v => ({ ...v,values: { ...v.values,name: "INVALID" } })));
    else if (corruption === "database") await writeFile(path.join(f.repos[1], ".codeatlas/atlas.db"), "corrupt");
    else {
      const db = new DatabaseSync(path.join(f.repos[1], ".codeatlas/atlas.db"));
      try {
        if (corruption === "json") db.exec("UPDATE generation_framework_state SET config_json = 'invalid'");
        else {
          const row = db.prepare("SELECT versions_json FROM index_generations").get() as { versions_json: string };
          const versions = { ...JSON.parse(row.versions_json), frameworkResolutionVersion: "1.6.0" };
          db.prepare("UPDATE index_generations SET versions_json = ?").run(JSON.stringify(versions));
          db.prepare("UPDATE index_manifests SET versions_json = ?").run(JSON.stringify(versions));
          db.exec("UPDATE generation_framework_state SET framework_resolution_version = '1.6.0'");
        }
      } finally { db.close(); }
    }
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]) });
    assert.equal(r.links.length, corruption === "section" ? 2 : 1);
    if (corruption !== "section") {
      assert.equal(r.counts.candidateLinks.total, null); assert.equal(r.scanComplete, false);
      assert.equal(r.dependencyDeclarations[0].cardinality, "unknown");
      const zero = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
      assert.equal(zero.counts.unmatchedDependencies.total, null);
      assert.ok(zero.dependencyDeclarations.every((d: any) => d.status !== "unmatched"));
      assert.equal(zero.counts.packageDeclarations.total, null);
    }
  } finally { await f.close(); }
});
test("workspace_package_links missing root differs from certified root without name; malformed source section fails only source role", async () => {
  const f = await fixture([source,{},null]);
  try {
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]) });
    const empty = r.repositories.find((m: any) => m.repositoryId === id(f.repos[1]));
    const missing = r.repositories.find((m: any) => m.repositoryId === id(f.repos[2]));
    assert.equal(empty.packageDeclarationCoverage.status, "supported"); assert.equal(empty.packageDeclarationCoverage.scanComplete, true);
    assert.equal(missing.packageDeclarationCoverage.scanComplete, false); assert.equal(r.counts.packageDeclarations.total, null);
    mutateConfig(f.repos[0], c => c.map(v => ({ ...v,values: { ...v.values,peerDependencies: "invalid" } })));
    const bad = await f.call(); const member = bad.repositories.find((m: any) => m.repositoryId === id(f.repos[0]));
    assert.equal(member.packageDeclarationCoverage.scanComplete, true); assert.equal(member.dependencyDeclarationCoverage.scanComplete, false);
    assert.equal(bad.counts.dependencyDeclarations.total, null);
  } finally { await f.close(); }
});
for (const role of ["source","target"] as const) test(`workspace_package_links ${role} publication after pin preserves one WAL snapshot`, async () => {
  const f = await fixture([source,target]);
  const repo = f.repos[role === "source" ? 0 : 1], repositoryId = id(repo);
  const writer = new DatabaseSync(path.join(repo, ".codeatlas/atlas.db")), originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const old = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    const generation = old.generationVector.find((g: any) => g.repositoryId === repositoryId).generationId;
    await writeFile(path.join(repo, "package.json"), JSON.stringify(role === "source" ? { dependencies: { different: "next" } } : { name: "different", version: "2.0.0" }));
    const update = await indexRepository(repo, { skipGit: true }); assert.equal(update.kind, "published"); if (update.kind !== "published") return;
    writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?").run(generation,repositoryId);
    let pins = 0;
    DatabaseSync.prototype.prepare = function(sql: string) {
      const statement = originalPrepare.call(this,sql);
      if (sql.includes("FROM repository_index_state WHERE repository_id = ?")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: Parameters<typeof statement.get>) => {
          const value = get(...args);
          if (args.includes(repositoryId)) { pins++; writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?").run(update.generationId,repositoryId); }
          return value;
        };
      }
      return statement;
    };
    const raced = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    assert.equal(pins,1); assert.deepEqual(raced.links,old.links); assert.deepEqual(raced.generationVector,old.generationVector);
    DatabaseSync.prototype.prepare = originalPrepare;
    const next = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    assert.equal(next.links.length,0); assert.equal(next.generationVector.find((g: any) => g.repositoryId === repositoryId).generationId,update.generationId);
  } finally { DatabaseSync.prototype.prepare = originalPrepare; writer.close(); await f.close(); }
});
test("workspace_package_links preflights giant blobs, item counts, sections and fields before JS hydration", async () => {
  const f = await fixture([source,target]); const originalParse = JSON.parse, originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const db = new DatabaseSync(path.join(f.repos[0], ".codeatlas/atlas.db"));
    const original = (db.prepare("SELECT config_json FROM generation_framework_state").get() as { config_json: string }).config_json;
    const root = JSON.parse(original)[0];
    const cases = [
      JSON.stringify([{ ...root,values: { giantSentinel: "x".repeat(8 * 1024 * 1024) } }]),
      JSON.stringify(Array.from({ length: 1001 }, () => root)),
      JSON.stringify([{ ...root,values: { dependencies: Object.fromEntries(Array.from({ length: 1001 },(_,i) => ["p"+i,"*"])) } }]),
      JSON.stringify([{ ...root,values: { dependencies: { "@acme/contracts": "x".repeat(4097) } } }]),
    ];
    for (const value of cases) {
      db.prepare("UPDATE generation_framework_state SET config_json = ?").run(value);
      JSON.parse = ((text: string,...args: unknown[]) => { assert.equal(text.includes("giantSentinel"), false); return originalParse(text,...args as []); }) as typeof JSON.parse;
      let hydratedDependencies = 0;
      DatabaseSync.prototype.prepare = function(sql: string) {
        assert.equal(/SELECT\s+config_json\b/i.test(sql),false,"raw config blob must never be hydrated");
        if (sql.includes("d.key AS name")) hydratedDependencies++;
        return originalPrepare.call(this,sql);
      };
      const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
      assert.equal(r.links.length,0); assert.equal(r.scanComplete,false); assert.equal(hydratedDependencies,0);
      assert.ok(r.work.inspectedRecords <= 10000); assert.ok(r.work.materializedBytes <= 8 * 1024 * 1024);
      DatabaseSync.prototype.prepare = originalPrepare; JSON.parse = originalParse;
    }
    db.close();
  } finally { DatabaseSync.prototype.prepare = originalPrepare; JSON.parse = originalParse; await f.close(); }
});
test("workspace_package_links filtered-out roles do not query config and no package filesystem fallback", async () => {
  const f = await fixture([source,target,target]);
  const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    mutateConfig(f.repos[2], () => []);
    let excludedReads = 0;
    DatabaseSync.prototype.prepare = function(sql: string) {
      const statement = originalPrepare.call(this,sql);
      if (sql.includes("generation_framework_state") || sql.includes("file_fact_bindings")) {
        for (const method of ["get","all"] as const) {
          const run = statement[method].bind(statement);
          statement[method] = ((...args: any[]) => { if (args.includes(id(f.repos[2]))) excludedReads++; return run(...args); }) as any;
        }
      }
      return statement;
    };
    await rm(path.join(f.repos[0], "package.json")); await rm(path.join(f.repos[1], "package.json"));
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    assert.equal(r.links.length,1); assert.equal(excludedReads,0);
    const member = r.repositories.find((m: any) => m.repositoryId === id(f.repos[2]));
    assert.equal(member.packageDeclarationCoverage.status,"not_requested"); assert.equal(member.dependencyDeclarationCoverage.status,"not_requested"); assert.ok(member.generationId);
  } finally { DatabaseSync.prototype.prepare = originalPrepare; await f.close(); }
});

test("workspace_package_links bounded fan-out charges derived work without materializing all pairs", async () => {
  const declarations = Object.fromEntries(["dependencies","devDependencies","peerDependencies","optionalDependencies"].map(kind =>
    [kind,Object.fromEntries([["@acme/contracts","*"],...Array.from({ length: 239 },(_,i) => ["z"+i,"*"])])]));
  const f = await fixture([declarations,...Array.from({ length: 15 },() => target)]);
  try {
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), limit: 1 });
    assert.equal(r.links.length,1); assert.equal(r.work.joinComplete,false);
    assert.equal(r.counts.candidateLinks.total,null); assert.ok(r.counts.candidateLinks.knownInspected.total > 0);
    assert.ok(r.work.inspectedRecords <= 10000);
    assert.ok(r.repositories.every((m: any) => m.queryCoverage.inspectedRecords <= 1000));
    assert.equal(new Set(r.generationVector.map((g: any) => g.repositoryId)).size,16);
    assert.deepEqual(await f.call({ sourceRepositoryId: id(f.repos[0]), limit: 1 }),r);
  } finally { await f.close(); }
});
test("workspace_package_links global payload budget preserves all member/vector slots", async () => {
  const f = await fixture([source,...Array.from({ length: 15 },() => target)]);
  try {
    for (const repo of f.repos) mutateConfig(repo,c => [...c,...Array.from({ length: 3 },(_,i) =>
      ({ ...c[0],relativePath: "packages/"+i+"/package.json",scope: "packages/"+i,values: { unused: "x".repeat(200000) } }))]);
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]) });
    assert.equal(r.repositories.length,16); assert.equal(r.generationVector.length,16); assert.equal(r.scanComplete,false);
    assert.ok(r.work.materializedBytes <= 8 * 1024 * 1024);
    assert.ok(r.repositories.some((m: any) => m.packageDeclarationCoverage.reasons.includes("payload_budget_exceeded")));
  } finally { await f.close(); }
});
test("workspace_package_links deadline returns bounded health instead of authoritative zero", async () => {
  const f = await fixture([source,target]);
  try {
    const { queryWorkspacePackageLinks } = await import("../src/core/workspace/workspace-package-links.service.js");
    let ticks = 0;
    const r = await queryWorkspacePackageLinks({ repositories: f.repos }, { now: () => ticks++ === 0 ? 0 : 30001 });
    assert.equal(r.repositories.length,2); assert.equal(r.counts.candidateLinks.total,null);
    assert.ok(r.repositories.every(m => m.health.diagnostics.includes("deadline_exceeded")));
  } finally { await f.close(); }
});
test("workspace_package_links identical config evidence refs remain repository qualified and compact/full inspection is identical", async () => {
  const f = await fixture([source,target,target]);
  try {
    const compact = await f.call({ sourceRepositoryId: id(f.repos[0]) }), full = await f.call({ sourceRepositoryId: id(f.repos[0]), detail: "full" });
    assert.equal(compact.links.length,2); assert.equal(compact.links[0].target.package.provenance.inputKey,compact.links[1].target.package.provenance.inputKey);
    assert.notEqual(compact.links[0].target.package.provenance.repositoryId,compact.links[1].target.package.provenance.repositoryId);
    assert.deepEqual(full.counts,compact.counts); assert.deepEqual(full.links,compact.links); assert.deepEqual(full.generationVector,compact.generationVector);
    assert.equal(JSON.stringify(compact).includes('"private":'),false);
    const db = new DatabaseSync(path.join(f.repos[1],".codeatlas/atlas.db"));
    db.exec("DELETE FROM file_fact_bindings"); db.close();
    const excluded = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) });
    assert.equal(excluded.links.length,0);
    assert.ok(excluded.repositories.find((m: any) => m.repositoryId === id(f.repos[1])).packageDeclarationCoverage.reasons.includes("js_ts_evidence_missing"));
  } finally { await f.close(); }
});
test("workspace_package_links Java and manifest-only targets are unsupported, mixed Java/TS target remains eligible", async () => {
  const f = await fixture([source,target,target,target]);
  try {
    for (const n of [1,2,3]) await rm(path.join(f.repos[n],"src/main.ts"));
    for (const n of [1,3]) await writeFile(path.join(f.repos[n],"src/main.java"),"class Contract {}");
    await writeFile(path.join(f.repos[3],"src/extra.tsx"),"export const value = 1;");
    for (const n of [1,2,3]) assert.equal((await indexRepository(f.repos[n],{ skipGit: true })).kind,"published");
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]) });
    assert.equal(r.links.length,1); assert.equal(r.links[0].target.repositoryId,id(f.repos[3]));
    for (const n of [1,2]) assert.equal(r.repositories.find((m: any) => m.repositoryId === id(f.repos[n])).packageDeclarationCoverage.status,"unsupported");
    assert.equal(r.counts.candidateLinks.total,null);
  } finally { await f.close(); }
});

test("workspace_package_links packageName preflight excludes unrelated over-budget dependency declarations", async () => {
  const f = await fixture([{ dependencies: { "@acme/contracts": "*", ...Object.fromEntries(Array.from({ length: 1001 },(_,i) => ["z"+i,"*"])) } },target]);
  try {
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]), packageName: "@acme/contracts" });
    assert.equal(r.links.length,1); assert.equal(r.counts.dependencyDeclarations.total,1); assert.equal(r.scanComplete,true);
  } finally { await f.close(); }
});
test("workspace_package_links reserves projected work before detail construction at deadline", async () => {
  const f = await fixture([source,target]); const originalExec = DatabaseSync.prototype.exec, originalStringify = JSON.stringify;
  try {
    const { queryWorkspacePackageLinks } = await import("../src/core/workspace/workspace-package-links.service.js");
    let commits = 0, projectionChecks = 0, constructedLinks = 0;
    DatabaseSync.prototype.exec = function(sql: string) {
      const result = originalExec.call(this,sql);
      if (sql === "COMMIT;") commits++;
      return result;
    };
    JSON.stringify = ((value: any,...args: any[]) => {
      if (value?.relation?.kind === "declared_dependency_candidate") constructedLinks++;
      return originalStringify(value,...args);
    }) as typeof JSON.stringify;
    const r = await queryWorkspacePackageLinks({ repositories: f.repos, sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(f.repos[1]) },
      { now: () => commits < 2 ? 0 : ++projectionChecks >= 3 ? 30001 : 0 });
    assert.equal(r.links.length,0); assert.equal(r.work.outputBudgetComplete,false);
    assert.equal(constructedLinks,0,"expired projection budget must precede link construction/serialization");
  } finally { DatabaseSync.prototype.exec = originalExec; JSON.stringify = originalStringify; await f.close(); }
});

test("workspace_package_links global record budget counts declarations and preserves partial member coverage", async () => {
  const dependencies = Object.fromEntries(Array.from({ length: 900 },(_,i) => ["p"+i,"*"]));
  const f = await fixture(Array.from({ length: 16 },() => ({ name: "@acme/contracts", dependencies })));
  try {
    const r = await f.call({ limit: 1 });
    assert.equal(r.repositories.length,16); assert.equal(r.scanComplete,false); assert.equal(r.counts.dependencyDeclarations.total,null);
    assert.ok(r.work.inspectedRecords <= 10000);
    assert.ok(r.repositories.every((m: any) => m.queryCoverage.inspectedRecords <= 1000));
    assert.ok(r.repositories.some((m: any) => m.dependencyDeclarationCoverage.reasons.includes("record_budget_exceeded")));
  } finally { await f.close(); }
});
test("workspace_package_links missing index isolates healthy target and source-only invalid name still declares dependencies", async () => {
  const f = await fixture([{ ...source,name: "INVALID" },target,target]);
  try {
    await rm(path.join(f.repos[1],".codeatlas"),{ recursive: true });
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]) });
    assert.equal(r.links.length,1); assert.equal(r.links[0].source.package,undefined); assert.equal(r.links[0].target.repositoryId,id(f.repos[2]));
    const missing = r.repositories.find((m: any) => m.repositoryId === id(f.repos[1]));
    assert.equal(missing.generationId,null); assert.equal(missing.health.availability,"unavailable");
    assert.equal(r.counts.candidateLinks.total,null); assert.equal(r.counts.unmatchedDependencies.total,null);
  } finally { await f.close(); }
});
test("workspace_package_links folder/display equality and same remote never supply package identity", async () => {
  const f = await fixture([{ dependencies: { contracts: "*" } },{ name: "wrong" }]);
  try {
    const renamed = path.join(f.root,"contracts");
    await rm(path.join(f.repos[1],".codeatlas"),{ recursive: true });
    const { rename } = await import("node:fs/promises"); await rename(f.repos[1],renamed); f.repos[1] = renamed;
    for (const repo of f.repos) {
      await mkdir(path.join(repo,".git"),{ recursive: true });
      await writeFile(path.join(repo,".git/config"),'[remote "origin"]\n url = https://example.com/contracts.git\n');
      await indexRepository(repo,{ skipGit: true });
    }
    assert.equal(getRepositoryIdentity(renamed).displayName,"contracts");
    const r = await f.call({ sourceRepositoryId: id(f.repos[0]), targetRepositoryId: id(renamed) });
    assert.equal(r.links.length,0); assert.equal(r.counts.unmatchedDependencies.total,1);
  } finally { await f.close(); }
});

test("workspace_package_links stops projection sizing once the shared detail limit is exhausted", async () => {
  const f = await fixture([source,target,target]); const original = JSON.stringify;
  try {
    const { queryWorkspacePackageLinks } = await import("../src/core/workspace/workspace-package-links.service.js");
    let extraSized = 0;
    JSON.stringify = ((value: any,...args: any[]) => {
      if (value?.status && value?.source?.dependency) extraSized++;
      return original(value,...args);
    }) as typeof JSON.stringify;
    const r = await queryWorkspacePackageLinks({ repositories: f.repos,sourceRepositoryId: id(f.repos[0]),limit: 1 });
    assert.equal(r.links.length,1); assert.equal(r.counts.candidateLinks.total,2);
    assert.equal(extraSized,0,"detail limit must stop nonreturned dependency projection work");
  } finally { JSON.stringify = original; await f.close(); }
});
