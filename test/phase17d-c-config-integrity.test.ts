import { DatabaseSync } from "node:sqlite";
import { acquireFrameworkConfig, readConfigBytes, MAX_CONFIG_BYTES } from "../src/core/indexing/framework-config-acquisition.js";
import { queryWorkspaceMap } from "../src/core/workspace/workspace-map.service.js";
import { queryWorkspaceMessageLinks } from "../src/core/workspace/workspace-message-links.service.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

const valid = '{ "name": "@acme/contracts", "version": "1.2.0", "dependencies": {"foo": "^1.0.0"} }\n';
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "code-atlas-config-integrity-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "package.json"), valid);
  return getRepositoryIdentity(root).rootPath;
}
function snapshot(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  try { return store.loadFramework(getRepositoryIdentity(root).id); } finally { store.close(); }
}
for (const [label, source] of [
  ["comment", '{/*comment*/"name":"foo"}'],
  ["trailing comma", '{"name":"foo",}'],
  ["top duplicate", '{"name":"first","name":"second"}'],
  ["nested duplicate", '{"dependencies":{"foo":"^1","foo":"^2"}}'],
  ["escaped duplicate", '{"dependencies":{"foo":"^1","\\u0066oo":"^2"}}'],
  ["array nested duplicate", '{"exports":[{"x":1,"x":2}]}'],
  ["malformed", '{"name":"foo",broken}'],
] as const) {
  test("rejects " + label + " without replacing or mutating the committed generation", async () => {
    const root = await fixture();
    try {
      assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
      const before = snapshot(root);
      await fs.writeFile(path.join(root, "package.json"), source);
      const result = await indexRepository(root, { skipGit: true });
      assert.equal(result.kind, "failed");
      assert.deepEqual(snapshot(root), before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}
test("publishes exact-byte package hash and JSONC configs under framework 1.7.0", async () => {
  const root = await fixture();
  try {
    const jsonc = '{/*keep*/"compilerOptions":{"strict":true,},}';
    await fs.writeFile(path.join(root, "tsconfig.json"), jsonc);
    await fs.writeFile(path.join(root, "jsconfig.json"), jsonc);
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    const output = snapshot(root)!;
    assert.equal(output.frameworkResolutionVersion, "1.7.0");
    const db = new DatabaseSync(path.join(root, ".codeatlas", "atlas.db"));
    try {
      for (const [table, key] of [["index_generations", "id"], ["index_manifests", "generation_id"]] as const) {
        const row = db.prepare("SELECT versions_json FROM " + table + " WHERE " + key + " = ?").get(output.generationId) as { versions_json: string };
        const versions = JSON.parse(row.versions_json);
        assert.deepEqual({ schema: versions.schemaVersion, facts: versions.factsVersion, factsSchema: versions.factsSchemaVersion, resolution: versions.resolutionVersion, framework: versions.frameworkResolutionVersion, reliability: versions.reliabilityVersion },
          { schema: "2.0.0", facts: "3.1.0", factsSchema: "3.0.0", resolution: "1.2.0", framework: "1.7.0", reliability: "1.0.0" });
      }
      assert.equal((db.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as { version: string }).version, "3");
    } finally { db.close(); }

    const config = output.config.find(item => item.kind === "package")!;
    assert.equal(config.complete, true);
    assert.equal(config.inputKey, "package:package.json:" + createHash("sha256").update(Buffer.from(valid)).digest("hex"));
    assert.deepEqual(config.values, JSON.parse(valid));
    assert.ok(output.config.filter(item => item.kind === "tsconfig" || item.kind === "jsconfig").every(item => item.complete && (item.values.compilerOptions as { strict: boolean }).strict));
    await fs.rm(path.join(root, "package.json"));
    assert.deepEqual(snapshot(root), output);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("scan A followed by acquisition B fails closed without substituting B hash", async () => {
  const root = await fixture();
  const original = fs.readFile;
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    const before = snapshot(root);
    let changed = false;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      const result = await original(...args);
      if (!changed && String(args[0]) === path.join(root, "package.json")) {
        changed = true;
        await fs.writeFile(path.join(root, "package.json"), '{"name":"changed"}');
      }
      return result;
    }) as typeof fs.readFile;
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(changed, true, "race hook must observe the detector read");
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.failure.message, /config_changed/);
    assert.deepEqual(snapshot(root), before);
  } finally { fs.readFile = original; await fs.rm(root, { recursive: true, force: true }); }
});

test("unstable bytes after parsing fail closed for every materialized JSON profile", async () => {
  for (const kind of ["package", "tsconfig", "jsconfig"] as const) {
    const a = Buffer.from('{"name":"old"}'), b = Buffer.from('{"name":"new"}');
    let read = 0;
    await assert.rejects(acquireFrameworkConfig("", kind + ".json", kind, createHash("sha256").update(a).digest("hex"),
      async () => ++read === 1 ? a : b), { code: "config_changed" });
  }
});
test("bounded parser rejects invalid structure and strict syntax without normalizing it", async () => {
  for (const [source, code] of [
    ["[]", "config_invalid_structure"], ["null", "config_invalid_structure"],
    ['{"x":1e999}', "config_invalid_structure"], ["\ufeff{}", "config_invalid_json"],
    ['{"x":' + "[".repeat(17) + "0" + "]".repeat(17) + "}", "config_invalid_structure"],
    ['{"__proto__":1,"__proto__":2}', "config_duplicate_key"],
  ] as const) {
    const bytes = Buffer.from(source);
    await assert.rejects(acquireFrameworkConfig("", "package.json", "package", createHash("sha256").update(bytes).digest("hex"),
      async () => bytes), { code });
  }
  const invalidUtf8 = Buffer.from([123,34,120,34,58,34,255,34,125]);
  await assert.rejects(acquireFrameworkConfig("", "package.json", "package", createHash("sha256").update(invalidUtf8).digest("hex"),
    async () => invalidUtf8), { code: "config_invalid_json" });
});
test("oversize file is rejected before a byte read or parser allocation", async () => {
  const root = await fixture(); const original = fs.open;
  let bytesRead = 0;
  try {
    await fs.writeFile(path.join(root, "package.json"), " ".repeat(MAX_CONFIG_BYTES + 1));
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...args: any[]) => { bytesRead++; return (read as any)(...args); }) as typeof handle.read;
      return handle;
    }) as typeof fs.open;
    await assert.rejects(readConfigBytes(path.join(root, "package.json")), { code: "config_too_large" });
    assert.equal(bytesRead, 0);
  } finally { fs.open = original; await fs.rm(root, { recursive: true, force: true }); }
});
test("mutation of an open config during bounded read is rejected", async () => {
  const root = await fixture(); const original = fs.open;
  let mutated = false;
  try {
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === path.join(root, "package.json") && args[1] === "r") {
        const read = handle.read.bind(handle);
        handle.read = (async (...args: any[]) => {
          const result = await (read as any)(...args);
          if (!mutated) { mutated = true; await fs.writeFile(path.join(root, "package.json"), '{"name":"moving"}'); }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.open;
    await assert.rejects(readConfigBytes(path.join(root, "package.json")), { code: "config_changed" });
    assert.equal(mutated, true);
  } finally { fs.open = original; await fs.rm(root, { recursive: true, force: true }); }
});
test("legacy 1.6.0 stays observable and is rejected by strict map and messaging consumer profiles", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, "app.ts"), 'import { Controller } from "@nestjs/common"; import { MessagePattern } from "@nestjs/microservices"; @Controller() class Worker { @MessagePattern("orders") work() {} }');
    const result = await indexRepository(root, { skipGit: true }); assert.equal(result.kind, "published");
    const current = snapshot(root)!; const generation = current.generationId;
    const db = new DatabaseSync(path.join(root, ".codeatlas", "atlas.db"));
    try {
      for (const [table, key] of [["index_generations", "id"], ["index_manifests", "generation_id"]] as const) {
        const row = db.prepare("SELECT versions_json FROM " + table + " WHERE " + key + " = ?").get(generation) as { versions_json: string };
        const versions = JSON.parse(row.versions_json); versions.frameworkResolutionVersion = "1.6.0";
        db.prepare("UPDATE " + table + " SET versions_json = ? WHERE " + key + " = ?").run(JSON.stringify(versions), generation);
      }
      db.prepare("UPDATE generation_framework_state SET framework_resolution_version = '1.6.0' WHERE generation_id = ?").run(generation);
      assert.equal((db.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as {version: string}).version, "3");
    } finally { db.close(); }
    const old = snapshot(root)!; assert.equal(old.frameworkResolutionVersion, "1.6.0");
    const map = await queryWorkspaceMap({ repositories: [root] });
    assert.equal(map.repositories[0]!.health.compatibility, "incompatible");
    const messaging = await queryWorkspaceMessageLinks({ repositories: [root], targetRepositoryId: getRepositoryIdentity(root).id });
    assert.equal(messaging.repositories[0]!.consumerCoverage.status, "unsupported");
    assert.deepEqual(snapshot(root), old);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("unsupported config kinds preserve incomplete empty evidence without a JSON acquisition policy", async () => {
  for (const kind of ["next", "maven", "gradle", "pubspec"] as const) {
    const input = await acquireFrameworkConfig("", "config", kind, "scan-hash", async () => Buffer.alloc(MAX_CONFIG_BYTES + 1));
    assert.deepEqual(input, { relativePath: "config", kind, contentHash: "scan-hash", objectiveValues: {}, complete: false });
  }
});
