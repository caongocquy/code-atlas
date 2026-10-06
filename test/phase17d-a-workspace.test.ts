import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, cp, rename } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readWorkspaceMetadata } from "../src/storage/atlas/workspace-metadata.reader.js";
import { WORKSPACE_BOUNDS, type WorkspaceReadBudget } from "../src/core/workspace/workspace.types.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { execFileSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import test from "node:test";
import * as workspace from "../src/core/workspace/workspace-map.service.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";

async function fixture() {
  const root = getRepositoryIdentity(await mkdtemp(path.join(tmpdir(), "code-atlas-phase17d-a-"))).rootPath;
  const repos = [path.join(root, "a", "same"), path.join(root, "b", "same")];
  const generations: string[] = [];
  for (const repo of repos) {
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "same.ts"), "export function same() { return 1; }\n");
    const result = await indexRepository(repo, { skipGit: true });
    assert.equal(result.kind, "published");
    if (result.kind === "published") generations.push(result.generationId);
  }
  return { root, repos, generations };
}

test("workspace_map federates real indexes with distinct namespaces, exact vector and unknown source freshness", async () => {
  const f = await fixture();
  try {
    const before = await Promise.all(f.repos.map(repo => readFile(path.join(repo, ".codeatlas", "atlas.db"))));
    const result = await workspace.queryWorkspaceMap({ repositories: f.repos, detail: "full" });
    assert.equal(result.state, "available");
    assert.equal(result.repositories.length, 2);
    assert.equal(new Set(result.repositories.map(r => r.repositoryId)).size, 2);
    assert.deepEqual(new Set(result.generationVector.map(r => r.generationId)), new Set(f.generations));
    for (const member of result.repositories) {
      assert.equal(member.evidenceState.freshness, "unknown");
      assert.equal(member.health.availability, "available");
      assert.ok(member.evidenceState.reasons.includes("graph_freshness_unknown"));
      assert.equal(member.displayName, "same");
    }
    assert.equal(result.evidence.anyUnknown, true);
    assert.equal("links" in result, false);
    assert.deepEqual(result, await workspace.queryWorkspaceMap({ repositories: [...f.repos].reverse(), detail: "full" }));
    assert.deepEqual(await Promise.all(f.repos.map(repo => readFile(path.join(repo, ".codeatlas", "atlas.db")))), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("workspace_map fails closed on selectors/config/duplicates but isolates unavailable members", async () => {
  const f = await fixture();
  try {
    for (const input of [{}, { repositories: [] }, { repositories: f.repos, workspacePath: "x" }, { repositories: [f.repos[0], f.repos[0]] }, { repositories: Array.from({ length: 17 }, (_, i) => String(i)) }]) {
      await assert.rejects(workspace.queryWorkspaceMap(input as never), { code: "invalid_arguments" });
    }
    const alias = path.join(f.root, "alias"); await symlink(f.repos[0], alias);
    await assert.rejects(workspace.queryWorkspaceMap({ repositories: [f.repos[0], alias] }), { code: "invalid_arguments" });
    const config = path.join(f.root, "chosen.json");
    await writeFile(config, JSON.stringify({ version: 1, name: "orders", repositories: [{ path: "a/same" }, { path: "b/same" }] }));
    const named = await workspace.queryWorkspaceMap({ workspacePath: config });
    assert.equal(named.workspace.name, "orders"); assert.equal(named.repositories.length, 2);
    for (const value of ["{", JSON.stringify({ version: 2, repositories: [{ path: "a" }] }), JSON.stringify({ version: 1, repositories: [{ path: "" }] }), JSON.stringify({ version: 1, repositories: [{ path: "a", extra: true }] })]) {
      await writeFile(config, value); await assert.rejects(workspace.queryWorkspaceMap({ workspacePath: config }), { code: "invalid_arguments" });
    }
    const missing = path.join(f.root, "missing");
    const partial = await workspace.queryWorkspaceMap({ repositories: [f.repos[0], missing] });
    assert.equal(partial.state, "partial"); assert.equal(partial.repositories.length, 2);
    assert.equal(partial.generationVector.filter(r => r.generationId === null).length, 1);
    assert.equal(partial.counts.available.total, 1); assert.equal(partial.counts.unavailable.total, 1);
    const unavailable = await workspace.queryWorkspaceMap({ repositories: [missing] });
    assert.equal(unavailable.state, "unavailable"); assert.equal(unavailable.generationVector[0].generationId, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

function budget(): WorkspaceReadBudget {
  return { remainingRecords: 10000, remainingBytes: 8 * 1024 * 1024, deadline: Infinity, now: () => 0, inspectedRecords: 0, materializedBytes: 0 };
}
function database(repo: string) { return new DatabaseSync(path.join(repo, ".codeatlas", "atlas.db")); }

test("workspace live read-only snapshot remains on one committed generation across WAL publication after pin", async () => {
  const f = await fixture(); const repo = f.repos[0];
  const writer = database(repo); const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    await writeFile(path.join(repo, "same.ts"), "export function same() { return 2; }\n");
    await writeFile(path.join(repo, "new-generation-only.ts"), "export function newGenerationOnly() { return 2; }\n");
    const second = await indexRepository(repo, { skipGit: true }); assert.equal(second.kind, "published");
    if (second.kind !== "published") return;
    const id = getRepositoryIdentity(repo).id;
    writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?").run(f.generations[0], id);
    const old = writer.prepare("SELECT created_at FROM index_generations WHERE id = ?").get(f.generations[0]) as { created_at: string };
    let pins = 0;
    DatabaseSync.prototype.prepare = function(sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.includes("FROM repository_index_state WHERE repository_id = ?")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: Parameters<typeof statement.get>) => {
          const row = get(...args); pins++;
          writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?").run(second.generationId, id);
          return row;
        };
      }
      return statement;
    };
    const loaded = readWorkspaceMetadata(path.join(repo, ".codeatlas", "atlas.db"), getRepositoryIdentity(repo), budget());
    assert.equal(pins, 1); assert.equal(loaded.generationId, f.generations[0]); assert.equal(loaded.updatedAt, old.created_at);
    assert.ok(loaded.evidence.every(item => item.generationId === f.generations[0]));
    assert.ok(loaded.evidence.some(item => item.ref.path === "same.ts"));
    assert.equal(loaded.evidence.some(item => item.ref.path === "new-generation-only.ts"), false);
    DatabaseSync.prototype.prepare = originalPrepare;
    const latest = await workspace.queryWorkspaceMap({ repositories: [repo], detail: "full" });
    assert.equal(latest.generationVector[0].generationId, second.generationId);
    assert.ok(latest.details.some(item => item.ref.path === "new-generation-only.ts"));
  } finally { DatabaseSync.prototype.prepare = originalPrepare; writer.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workspace update changes only its vector entry; default reads neither sources nor unlisted sibling indexes", async () => {
  const f = await fixture(); const originalReaddir = fsPromises.readdir;
  try {
    const first = await workspace.queryWorkspaceMap({ repositories: f.repos });
    await writeFile(path.join(f.repos[0], "same.ts"), "export function same() { return 3; }\n");
    const update = await indexRepository(f.repos[0], { skipGit: true }); assert.equal(update.kind, "published");
    const sibling = path.join(f.root, "unlisted"); await mkdir(sibling); await writeFile(path.join(sibling, "secret.ts"), "export function secret() {}\n");
    assert.equal((await indexRepository(sibling, { skipGit: true })).kind, "published");
    fsPromises.readdir = (() => { throw new Error("Source/discovery scans are forbidden"); }) as typeof fsPromises.readdir;
    const next = await workspace.queryWorkspaceMap({ repositories: f.repos, detail: "full" });
    assert.equal(next.generationVector.find(entry => entry.repositoryId === getRepositoryIdentity(f.repos[1]).id)?.generationId, first.generationVector.find(entry => entry.repositoryId === getRepositoryIdentity(f.repos[1]).id)?.generationId);
    assert.notEqual(next.generationVector.find(entry => entry.repositoryId === getRepositoryIdentity(f.repos[0]).id)?.generationId, f.generations[0]);
    assert.equal(next.repositories.length, 2);
    assert.ok(next.details.every(item => item.ref.path === "same.ts" && next.repositories.some(repo => repo.repositoryId === item.repositoryId)));
    assert.equal(new Set(next.details.map(item => item.repositoryId)).size, 2);
    assert.ok(next.repositories.every(repo => repo.evidenceState.freshness === "unknown"));
  } finally { fsPromises.readdir = originalReaddir; await rm(f.root, { recursive: true, force: true }); }
});

test("workspace rejects oversized metadata before JSON.parse and oversized coverage before hydrating rows", async () => {
  const f = await fixture(); const originalParse = JSON.parse; const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const pointerDb = database(f.repos[0]);
    pointerDb.prepare("UPDATE repository_index_state SET active_generation_id = ?").run("x".repeat(WORKSPACE_BOUNDS.maxPayloadBytes + 1));
    pointerDb.close();
    let guardedPointer = false;
    DatabaseSync.prototype.prepare = function(sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.includes("FROM repository_index_state WHERE repository_id = ?")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: Parameters<typeof statement.get>) => {
          const row = get(...args) as { active_generation_id: string | null; bytes: number };
          assert.equal(row.active_generation_id, null, "SQL must suppress an oversized pointer before materialization");
          assert.ok(row.bytes > WORKSPACE_BOUNDS.maxPayloadBytes); guardedPointer = true; return row;
        };
      }
      return statement;
    };
    const pointerResult = await workspace.queryWorkspaceMap({ repositories: [f.repos[0]] });
    assert.equal(guardedPointer, true); assert.equal(pointerResult.generationVector[0].generationId, null);
    assert.ok(pointerResult.repositories[0].health.diagnostics.includes("payload_budget_exceeded"));
    DatabaseSync.prototype.prepare = originalPrepare;
    const restored = database(f.repos[0]); restored.prepare("UPDATE repository_index_state SET active_generation_id = ?").run(f.generations[0]); restored.close();
    const db = database(f.repos[0]);
    const huge = JSON.stringify({ oversizedSentinel: "x".repeat(WORKSPACE_BOUNDS.maxPayloadBytes + 1) });
    db.prepare("UPDATE index_generations SET versions_json = ?").run(huge); db.close();
    JSON.parse = ((value: string, ...args: unknown[]) => { assert.equal(value.includes("oversizedSentinel"), false, "oversized metadata must never be decoded"); return originalParse(value, ...args as []); }) as typeof JSON.parse;
    const result = await workspace.queryWorkspaceMap({ repositories: f.repos });
    assert.equal(result.repositories.find(r => r.path === f.repos[0])?.health.availability, "partial");
    assert.ok(result.repositories.find(r => r.path === f.repos[0])?.health.diagnostics.includes("payload_budget_exceeded"));
    JSON.parse = originalParse;
    const db2 = database(f.repos[1]);
    const id = getRepositoryIdentity(f.repos[1]).id;
    const insert = db2.prepare("INSERT INTO generation_graph_resolution_files (repository_id, generation_id, file_path, updated_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 1001; i++) insert.run(id, f.generations[1], `file-${i}.ts`, "2026-10-03");
    db2.close();
    DatabaseSync.prototype.prepare = function(sql: string) {
      assert.equal(sql.startsWith("SELECT file_path, may_be_incomplete"), false, "oversized coverage must be rejected before hydration");
      return originalPrepare.call(this, sql);
    };
    const bounded = await workspace.queryWorkspaceMap({ repositories: [f.repos[1]], detail: "full" });
    assert.equal(bounded.repositories[0].health.availability, "partial"); assert.ok(bounded.repositories[0].health.diagnostics.includes("record_budget_exceeded"));
    assert.equal(bounded.counts.details.total, null);
  } finally { JSON.parse = originalParse; DatabaseSync.prototype.prepare = originalPrepare; await rm(f.root, { recursive: true, force: true }); }
});

test("workspace isolates corrupt, legacy and invalid generation indexes without migration and rejects persisted namespace collisions", async () => {
  const f = await fixture();
  try {
    for (const [sql, expected] of [
      ["UPDATE atlas_schema SET version = '2'", "query_schema_unsupported"],
      ["UPDATE repository_index_state SET active_generation_id = NULL", "generation_unavailable"],
      ["UPDATE repository_index_state SET active_generation_id = 'dangling'", "generation_invalid"],
      ["UPDATE index_generations SET status = 'candidate'", "generation_invalid"],
      ["UPDATE index_generations SET versions_json = '{}'", "generation_manifest_invalid"],
    ]) {
      const dbPath = path.join(f.repos[0], ".codeatlas", "atlas.db"); const saved = await readFile(dbPath);
      const db = database(f.repos[0]); db.exec(sql); db.close();
      const mutated = await readFile(dbPath); const result = await workspace.queryWorkspaceMap({ repositories: f.repos });
      assert.equal(result.repositories.find(r => r.path === f.repos[0])?.health.diagnostics[0], expected);
      assert.equal(result.repositories.find(r => r.path === f.repos[1])?.health.availability, "available");
      assert.deepEqual(await readFile(dbPath), mutated, "query must not migrate or repair"); await writeFile(dbPath, saved);
    }
    const db = database(f.repos[0]); db.exec("PRAGMA foreign_keys = OFF"); db.prepare("UPDATE repositories SET id = ?").run(getRepositoryIdentity(f.repos[1]).id); db.close();
    await assert.rejects(workspace.queryWorkspaceMap({ repositories: f.repos }), { code: "namespace_integrity" });
    await writeFile(path.join(f.repos[0], ".codeatlas", "atlas.db"), "not a database");
    const corrupt = await workspace.queryWorkspaceMap({ repositories: f.repos }); assert.equal(corrupt.state, "partial"); assert.equal(corrupt.counts.unavailable.total, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("workspace bounds projection and deadline while retaining all member envelopes and same-remote clones", async () => {
  const f = await fixture();
  try {
    for (const repo of f.repos) { execFileSync("git", ["init", "--quiet", repo]); execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.invalid/same.git"]); }
    const result = await workspace.queryWorkspaceMap({ repositories: f.repos, detail: "full", limit: 1 });
    assert.equal(result.repositories.length, 2); assert.equal(result.details.length, 1); assert.equal(result.counts.details.total, 2); assert.equal(result.counts.details.omitted, 1);
    assert.notEqual(result.repositories[0].repositoryId, result.repositories[1].repositoryId);
    let ticks = 0;
    const expired = await workspace.queryWorkspaceMap({ repositories: f.repos }, { now: () => ticks++ === 0 ? 0 : 30001 });
    assert.equal(expired.state, "unavailable"); assert.ok(expired.repositories.every(repo => repo.health.diagnostics.includes("deadline_exceeded")));
    assert.equal(expired.generationVector.length, 2);
    for (const limit of [0, 1001, 1.1]) await assert.rejects(workspace.queryWorkspaceMap({ repositories: f.repos, limit }), { code: "invalid_arguments" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function bytes(repo: string) {
  const result: Record<string, string | null> = {};
  for (const file of ["same.ts", "codeatlas.config.json", ".codeatlas/atlas.db", ".codeatlas/atlas.db-wal", ".codeatlas/atlas.db-shm"]) {
    result[file] = await readFile(path.join(repo, file)).then(value => createHash("sha256").update(value).digest("hex")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  }
  return result;
}

test("workspace read-only queries preserve database/config/source and committed WAL bytes", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repos[0], "codeatlas.config.json"), JSON.stringify({ version: 1 }));
    const closed = await bytes(f.repos[0]);
    await workspace.queryWorkspaceMap({ repositories: [f.repos[0]] });
    const after = await bytes(f.repos[0]);
    for (const file of ["same.ts", "codeatlas.config.json", ".codeatlas/atlas.db"]) assert.equal(after[file], closed[file]);
    // SQLite mode=ro may create empty operational WAL/SHM sidecars for a closed WAL-mode DB.
    assert.equal((await readFile(path.join(f.repos[0], ".codeatlas", "atlas.db-wal"))).length, 0);
    const writer = database(f.repos[1]);
    try {
      writer.exec("PRAGMA journal_mode = WAL"); writer.prepare("UPDATE repositories SET updated_at = updated_at").run();
      const wal = await bytes(f.repos[1]); assert.ok(wal[".codeatlas/atlas.db-wal"]); assert.ok(wal[".codeatlas/atlas.db-shm"]);
      const result = await workspace.queryWorkspaceMap({ repositories: [f.repos[1]] }); assert.equal(result.state, "available");
      const live = await bytes(f.repos[1]);
      for (const file of ["same.ts", "codeatlas.config.json", ".codeatlas/atlas.db", ".codeatlas/atlas.db-wal"]) assert.equal(live[file], wal[file]);
    } finally { writer.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("workspace rejects moved/copied identity and unsupported semantic versions without package version coupling", async () => {
  const f = await fixture();
  try {
    const copied = path.join(f.root, "copy"); await cp(f.repos[0], copied, { recursive: true });
    const mismatch = await workspace.queryWorkspaceMap({ repositories: [copied, f.repos[1]] });
    assert.ok(mismatch.repositories.find(repo => repo.path === copied)?.health.diagnostics.includes("repository_identity_mismatch"));
    const moved = path.join(f.root, "moved"); await rename(copied, moved);
    assert.equal((await workspace.queryWorkspaceMap({ repositories: [moved] })).state, "unavailable");
    const db = database(f.repos[0]);
    const row = db.prepare("SELECT versions_json FROM index_generations WHERE id = ?").get(f.generations[0]) as { versions_json: string };
    const versions = JSON.parse(row.versions_json); const differentPackage = JSON.stringify({ ...versions, packageVersion: "99.0.0" });
    db.prepare("UPDATE index_generations SET versions_json = ? WHERE id = ?").run(differentPackage, f.generations[0]);
    db.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?").run(differentPackage, f.generations[0]);
    db.close(); assert.equal((await workspace.queryWorkspaceMap({ repositories: [f.repos[0]] })).state, "available");
    const bad = database(f.repos[0]); const incompatible = JSON.stringify({ ...versions, factsSchemaVersion: "99.0.0" });
    bad.prepare("UPDATE index_generations SET versions_json = ? WHERE id = ?").run(incompatible, f.generations[0]);
    bad.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?").run(incompatible, f.generations[0]); bad.close();
    const result = await workspace.queryWorkspaceMap({ repositories: f.repos }); assert.equal(result.counts.incompatible.total, 1);
    assert.ok(result.repositories.find(repo => repo.path === f.repos[0])?.health.diagnostics.includes("semantic_domain_unsupported"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("workspace metadata reader uses one handle and global record/byte budgets before fetching evidence", async () => {
  const f = await fixture(); const originalExec = DatabaseSync.prototype.exec; const originalClose = DatabaseSync.prototype.close;
  const open = new Set<DatabaseSync>(); let peak = 0;
  try {
    DatabaseSync.prototype.exec = function(sql: string) { if (sql === "BEGIN;") { open.add(this); peak = Math.max(peak, open.size); } return originalExec.call(this, sql); };
    DatabaseSync.prototype.close = function() { open.delete(this); return originalClose.call(this); };
    await workspace.queryWorkspaceMap({ repositories: f.repos }); assert.equal(peak, 1); assert.equal(open.size, 0);
    const small = budget(); small.remainingRecords = 1;
    assert.throws(() => readWorkspaceMetadata(path.join(f.repos[0], ".codeatlas", "atlas.db"), getRepositoryIdentity(f.repos[0]), small), { code: "record_budget_exceeded" });
    const limited = budget(); limited.remainingBytes = 1;
    assert.throws(() => readWorkspaceMetadata(path.join(f.repos[0], ".codeatlas", "atlas.db"), getRepositoryIdentity(f.repos[0]), limited), { code: "payload_budget_exceeded" });
    assert.equal(open.size, 0);
  } finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalClose; await rm(f.root, { recursive: true, force: true }); }
});

 test("workspace compact omission is not truncation and post-pin deadline retains validated generation", async () => {
  const f = await fixture(); const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const compact = await workspace.queryWorkspaceMap({ repositories: f.repos });
    assert.equal(compact.truncated, false);
    assert.equal(compact.evidence.mayBeIncomplete, (await workspace.queryWorkspaceMap({ repositories: f.repos, detail: "full" })).evidence.mayBeIncomplete);
    let expired = false;
    DatabaseSync.prototype.prepare = function(sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.startsWith("SELECT count(*) AS count")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: Parameters<typeof statement.get>) => { const result = get(...args); expired = true; return result; };
      }
      return statement;
    };
    const partial = await workspace.queryWorkspaceMap({ repositories: [f.repos[0]] }, { now: () => expired ? 30001 : 0 });
    assert.equal(partial.repositories[0].generationId, f.generations[0]);
    assert.equal(partial.repositories[0].health.availability, "partial");
    assert.ok(partial.repositories[0].health.diagnostics.includes("deadline_exceeded"));
  } finally { DatabaseSync.prototype.prepare = originalPrepare; await rm(f.root, { recursive: true, force: true }); }
});

 test("workspace global evidence budget bounds sixteen real indexes and isolates inaccessible members", async () => {
  const f = await fixture(); const originalStat = fsPromises.stat;
  try {
    const empty = path.join(f.root, "empty"); await mkdir(empty);
    assert.equal((await workspace.queryWorkspaceMap({ repositories: [empty] })).repositories[0].health.diagnostics[0], "index_missing");
    fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
      if (String(args[0]).startsWith(f.repos[0])) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return originalStat(...args);
    }) as typeof fsPromises.stat;
    syncBuiltinESMExports();
    const denied = await workspace.queryWorkspaceMap({ repositories: f.repos });
    assert.equal(denied.state, "partial"); assert.ok(denied.repositories.some(repo => repo.health.diagnostics.includes("index_inaccessible")));
    fsPromises.stat = originalStat; syncBuiltinESMExports();
    const repos = [...f.repos];
    for (let i = 2; i < 16; i++) {
      const repo = path.join(f.root, `member-${i}`); await mkdir(repo); await writeFile(path.join(repo, "same.ts"), "export function same() { return 1; }\n");
      assert.equal((await indexRepository(repo, { skipGit: true })).kind, "published"); repos.push(repo);
    }
    for (const repo of repos) {
      const db = database(repo); const id = getRepositoryIdentity(repo).id;
      const gen = db.prepare("SELECT active_generation_id FROM repository_index_state WHERE repository_id = ?").get(id) as { active_generation_id: string };
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO generation_graph_resolution_files (repository_id, generation_id, file_path, updated_at) VALUES (?, ?, ?, ?)");
      for (let i = 0; i < 800; i++) insert.run(id, gen.active_generation_id, `evidence-${i}.ts`, "2026-10-03");
      db.exec("COMMIT"); db.close();
    }
    const result = await workspace.queryWorkspaceMap({ repositories: repos, detail: "full", limit: 1000 });
    assert.equal(result.repositories.length, 16); assert.equal(result.generationVector.length, 16);
    assert.ok(result.work.inspectedRecords <= 10000); assert.ok(result.work.materializedBytes <= 8 * 1024 * 1024);
    assert.ok(result.repositories.every(repo => repo.queryCoverage.inspectedRecords <= 1000));
    assert.ok(result.repositories.some(repo => repo.health.diagnostics.includes("record_budget_exceeded")));
    assert.ok(result.details.length + result.diagnostics.length <= 1000); assert.equal(result.counts.details.total, null);
  } finally { fsPromises.stat = originalStat; syncBuiltinESMExports(); await rm(f.root, { recursive: true, force: true }); }
});

 test("workspace namespaces matching framework keys, relative paths and display names without hydrating entities", async () => {
  const f = await fixture(); const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const keys: string[][] = [];
    for (const repo of f.repos) {
      await writeFile(path.join(repo, "package.json"), JSON.stringify({ dependencies: { next: "14.0.0" } }));
      await mkdir(path.join(repo, "app"));
      await writeFile(path.join(repo, "app", "page.tsx"), 'export default function SamePage() { return <div>same</div>; }\n');
      const indexed = await indexRepository(repo, { skipGit: true });
      assert.equal(indexed.kind, "published", indexed.kind === "failed" ? indexed.failure.message : "");
      const db = database(repo);
      const rows = db.prepare("SELECT entity_key FROM generation_framework_entities WHERE generation_id = (SELECT active_generation_id FROM repository_index_state) ORDER BY entity_key").all() as { entity_key: string }[];
      keys.push(rows.map(row => row.entity_key)); db.close();
    }
    assert.ok(keys[0].length > 0); assert.deepEqual(keys[0], keys[1]);
    DatabaseSync.prototype.prepare = function(sql: string) {
      assert.equal(/FROM generation_(framework_entities|nodes|edges|facts)/i.test(sql), false, "workspace must not hydrate graph/framework entities");
      return originalPrepare.call(this, sql);
    };
    const result = await workspace.queryWorkspaceMap({ repositories: f.repos, detail: "full" });
    assert.ok(result.repositories.every(repo => repo.displayName === "same"));
    const files = result.details.filter(item => item.ref.path === "same.ts");
    assert.equal(files.length, 2); assert.equal(new Set(files.map(item => item.repositoryId)).size, 2);
    assert.equal("areas" in result, false); assert.equal("links" in result, false);
  } finally { DatabaseSync.prototype.prepare = originalPrepare; await rm(f.root, { recursive: true, force: true }); }
});
