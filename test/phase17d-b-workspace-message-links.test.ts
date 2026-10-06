import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { queryWorkspaceMessageLinks } from "../src/core/workspace/workspace-message-links.service.js";
import { queryWorkspaceMap } from "../src/core/workspace/workspace-map.service.js";
import { frameworkSubjectKey } from "../src/core/framework/framework-identity.js";
import { WORKSPACE_BOUNDS } from "../src/core/workspace/workspace.types.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

const nestProducer = (kind = "send", destination = "orders.get") => `
import { Controller } from "@nestjs/common";
import { ClientProxy, MessagePattern, EventPattern } from "@nestjs/microservices";
@Controller() class Producer {
 produce(client: ClientProxy, payload: string) { client.${kind}("${destination}", payload); }
 @${kind === "send" ? "MessagePattern" : "EventPattern"}("${destination}") local(p: string) {}
}`;
const nestConsumer = (kind = "MessagePattern", destination = "orders.get") => `
import { Controller } from "@nestjs/common";
import { MessagePattern, EventPattern } from "@nestjs/microservices";
class Work { work() {} }
const service: Work = new Work();
@Controller() class Consumer {
 @${kind}("${destination}") consume(p: string) { service.work(); }
}`;
const kafkaProducer = `
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.annotation.KafkaListener;
class Producer {
 private KafkaTemplate<String,String> template;
 void produce(String payload) { template.send("events", payload); }
 @KafkaListener(topics="events") void local(String p) {}
}`;
const kafkaConsumers = `
import org.springframework.kafka.annotation.KafkaListener;
class Consumer {
 @KafkaListener(topics="events", groupId="one") void consume(String p) {}
 @KafkaListener(topics="events", groupId="two") void second(String p) {}
}`;

async function fixture(sources: Array<{ text: string; language?: string }>) {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-d-b-"));
  const repos: string[] = [];
  for (const [i, source] of sources.entries()) {
    const repo = path.join(root, String(i)); repos.push(repo);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", source.language === "java" ? "main.java" : "main.ts"), source.text);
    const indexed = await indexRepository(repo, { skipGit: true, scipIndexer: { discover: async () => ({ status: "unavailable" as const }), index: async () => [] } });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
  }
  const server = createMcpServer(), client = new Client({ name: "d-b-proof", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(ct), server.connect(st)]);
  const call = async (args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name: "workspace_message_links", arguments: { repositories: repos, detail: "full", ...args } });
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return response.structuredContent as any;
  };
  return { root, repos, client, server, call, close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

// Public MCP contract is the RED gate, before any production changes.
test("workspace_message_links tools/list exposes one dedicated read-only surface", async () => {
  const f = await fixture([]);
  try {
    const tool = (await f.client.listTools()).tools.find(t => t.name === "workspace_message_links");
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.properties?.repoPath, undefined);
    assert.equal(tool.inputSchema.properties?.includeSameRepository, undefined);
    const local = (await f.client.listTools()).tools.find(t => t.name === "message_links")!;
    assert.equal(local.inputSchema.properties?.repositories, undefined);
  } finally { await f.close(); }
});

for (const kind of ["send", "emit"] as const) test(`workspace_message_links real Nest ${kind}, qualified target and independent execution_flow`, async () => {
  const targetKind = kind === "send" ? "MessagePattern" : "EventPattern";
  const f = await fixture([{ text: nestProducer(kind) }, { text: nestConsumer(targetKind) }, { text: nestConsumer(kind === "send" ? "EventPattern" : "MessagePattern") }]);
  try {
    const before = await Promise.all(f.repos.map(r => readFile(path.join(r, ".codeatlas/atlas.db"))));
    const result = await f.call(); assert.equal(result.links.length, 1); assert.equal(result.counts.compatibleLinks.total, 1);
    const link = result.links[0];
    assert.equal(link.source.repositoryId, getRepositoryIdentity(f.repos[0]).id);
    assert.equal(link.target.repositoryId, getRepositoryIdentity(f.repos[1]).id);
    assert.equal(link.compatibility.scope, "workspace_cross_repo");
    assert.equal(link.compatibility.status, "compatible");
    assert.ok(link.provenance.sourceProducerEvidence); assert.ok(link.provenance.targetConsumerEvidence);
    for (const endpoint of [link.source, link.target]) assert.equal(endpoint.generationId, result.generationVector.find((r: any) => r.repositoryId === endpoint.repositoryId).generationId);
    const entries = await f.client.callTool({ name: "list_entries", arguments: { repoPath: f.repos[1], kind: "message_consumer", detail: "full" } });
    assert.ok((entries.structuredContent as any).entries.some((e: any) => e.id === link.target.consumerId));
    const flow = await f.client.callTool({ name: "execution_flow", arguments: { repoPath: f.repos[1], entry: { kind: "message_consumer", id: link.target.consumerId }, detail: "full" } });
    const payload = flow.structuredContent as any;
    assert.equal(payload.status, "resolved"); assert.equal(payload.evidenceState.generationId, link.target.generationId);
    assert.ok(payload.edges.some((e: any) => e.relation === "message_handler"));
    assert.ok(payload.nodes.some((n: any) => n.subject.node?.name === "work"));
    assert.deepEqual(await Promise.all(f.repos.map(r => readFile(path.join(r, ".codeatlas/atlas.db")))), before);
    assert.deepEqual(await f.call({ repositories: [...f.repos].reverse() }), result);
  } finally { await f.close(); }
});

test("workspace_message_links real Kafka retains groups and colliding consumer keys across target repos", async () => {
  const f = await fixture([{ text: kafkaProducer, language: "java" }, { text: kafkaConsumers, language: "java" }, { text: kafkaConsumers, language: "java" }, { text: nestConsumer("EventPattern", "different") }]);
  try {
    const r = await f.call(); assert.equal(r.links.length, 4); assert.equal(r.producerCalls[0].cardinality, "many");
    assert.equal(new Set(r.links.map((l: any) => l.target.repositoryId)).size, 2);
    assert.equal(new Set(r.links.map((l: any) => l.target.consumerId)).size, 2);
    const bounded = await f.call({ limit: 3 });
    assert.ok(bounded.producerCalls.length + bounded.links.length + bounded.unlinkedProducerCalls.length + bounded.diagnostics.length <= 3);
    assert.equal(bounded.counts.compatibleLinks.total, 4);
    assert.deepEqual(await f.call({ limit: 3 }), bounded);
  } finally { await f.close(); }
});

test("workspace_message_links selectors fail closed and one member never returns local composition", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const sourceRepositoryId = getRepositoryIdentity(f.repos[0]).id, targetRepositoryId = getRepositoryIdentity(f.repos[1]).id;
    const one = await f.call({ repositories: [f.repos[0]] }); assert.equal(one.links.length, 0);
    const result = await f.call({ sourceRepositoryId, targetRepositoryId, producerSymbol: "produce" });
    assert.equal(result.links.length, 1);
    assert.equal((await f.call({ sourceRepositoryId, targetRepositoryId, producerSymbol: "produce", consumerId: result.links[0].target.consumerId })).links.length, 1);
    for (const args of [{ producerSymbol: "produce" }, { consumerId: "x" }, { sourceRepositoryId: "non-member" }, { sourceRepositoryId, targetRepositoryId: sourceRepositoryId }]) {
      const response = await f.client.callTool({ name: "workspace_message_links", arguments: { repositories: f.repos, ...args } });
      assert.equal(response.isError, true, JSON.stringify(args)); assert.match(JSON.stringify(response), /invalid_arguments/);
    }
  } finally { await f.close(); }
});

test("workspace_message_links missing target preserves producer unknown cardinality", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    await rm(path.join(f.repos[1], ".codeatlas"), { recursive: true });
    const r = await f.call(); assert.equal(r.links.length, 0); assert.equal(r.producerCalls.length, 1);
    assert.equal(r.producerCalls[0].cardinality, "unknown"); assert.equal(r.unlinkedProducerCalls.length, 0);
    assert.equal(r.counts.compatibleLinks.total, null); assert.equal(r.mayBeIncomplete, true);
    assert.ok(r.repositories.some((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[1]).id && m.health.availability === "unavailable"));
  } finally { await f.close(); }
});


for (const role of ["source", "target"] as const) test(`workspace_message_links ${role} WAL publication after pin keeps all endpoint evidence on old generation`, async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  const repo = f.repos[role === "source" ? 0 : 1], id = getRepositoryIdentity(repo).id;
  const writer = new DatabaseSync(path.join(repo, ".codeatlas/atlas.db"));
  const originalPrepare = DatabaseSync.prototype.prepare;
  try {
    const old = await f.call(), generation = old.generationVector.find((r: any) => r.repositoryId === id).generationId;
    await writeFile(path.join(repo, "src/main.ts"), role === "source" ? nestProducer("send", "changed") : nestConsumer("MessagePattern", "changed"));
    const update = await indexRepository(repo, { skipGit: true }); assert.equal(update.kind, "published", JSON.stringify(update));
    if (update.kind !== "published") return;
    writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?").run(generation, id);
    let pins = 0;
    DatabaseSync.prototype.prepare = function(sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql.includes("FROM repository_index_state WHERE repository_id = ?")) {
        const get = statement.get.bind(statement);
        statement.get = (...args: Parameters<typeof statement.get>) => {
          const value = get(...args);
          if (args.includes(id)) { pins++; writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?").run(update.generationId, id); }
          return value;
        };
      }
      return statement;
    };
    const raced = await f.call(); assert.equal(pins, 1);
    assert.deepEqual(raced.generationVector, old.generationVector);
    assert.deepEqual(raced.links, old.links); assert.deepEqual(raced.producerCalls, old.producerCalls);
    DatabaseSync.prototype.prepare = originalPrepare;
    const next = await f.call(); assert.equal(next.links.length, 0);
    assert.equal(next.generationVector.find((r: any) => r.repositoryId === id).generationId, update.generationId);
    const untouched = f.repos[role === "source" ? 1 : 0];
    assert.equal(next.generationVector.find((r: any) => r.repositoryId === getRepositoryIdentity(untouched).id).generationId, old.generationVector.find((r: any) => r.repositoryId === getRepositoryIdentity(untouched).id).generationId);
  } finally { DatabaseSync.prototype.prepare = originalPrepare; writer.close(); await f.close(); }
});

test("workspace_message_links excludes unlisted matching sibling and reuses workspace config/symlink rejection", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }, { text: nestConsumer() }]);
  const originalStat = fsPromises.stat;
  try {
    fsPromises.stat = (async (...args: Parameters<typeof fsPromises.stat>) => {
      assert.equal(String(args[0]).startsWith(f.repos[2]), false, "unlisted index must never be opened");
      return originalStat(...args);
    }) as typeof fsPromises.stat; syncBuiltinESMExports();
    const r = await f.call({ repositories: f.repos.slice(0, 2) }); assert.equal(r.repositories.length, 2); assert.equal(r.links.length, 1);
    const config = path.join(f.root, "workspace.json");
    await writeFile(config, JSON.stringify({ version: 1, name: "selected", repositories: [{ path: "0" }, { path: "1" }] }));
    const configured = await queryWorkspaceMessageLinks({ workspacePath: config }); assert.equal(configured.links.length, 1);
    await fsPromises.symlink(f.repos[0], path.join(f.root, "alias"));
    await assert.rejects(queryWorkspaceMessageLinks({ repositories: [f.repos[0], path.join(f.root, "alias")] }), { code: "invalid_arguments" });
  } finally { fsPromises.stat = originalStat; syncBuiltinESMExports(); await f.close(); }
});

test("workspace_message_links Kafka topic cannot match Rabbit queue or Nest pattern with same literal", async () => {
  const rabbit = `import org.springframework.amqp.rabbit.annotation.RabbitListener;
class Consumer {
 @RabbitListener(queues="events") void consume(String p) {}
}`;
  const f = await fixture([{ text: kafkaProducer, language: "java" }, { text: rabbit, language: "java" }, { text: nestConsumer("EventPattern", "events") }]);
  try { const r = await f.call(); assert.equal(r.links.length, 0); assert.equal(r.producerCalls[0].cardinality, "none"); }
  finally { await f.close(); }
});

for (const corruption of ["missing_handler", "wrong_direction", "duplicate_handler", "invalid_callable", "bad_capability", "mismatched_identity"] as const) test(`workspace_message_links corrupt consumer ${corruption} fails closed and isolates healthy target`, async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }, { text: nestConsumer() }]);
  try {
    const db = new DatabaseSync(path.join(f.repos[1], ".codeatlas/atlas.db"));
    try {
      const entity = db.prepare("SELECT entity_key, payload_json FROM generation_framework_entities WHERE kind = 'message_consumer'").get() as { entity_key: string; payload_json: string };
      const row = db.prepare("SELECT output_key, payload_json FROM generation_framework_relationships").get() as { output_key: string; payload_json: string };
      const relationship = JSON.parse(row.payload_json);
      if (corruption === "missing_handler") db.prepare("DELETE FROM generation_framework_relationships").run();
      else if (corruption === "mismatched_identity" || corruption === "bad_capability") {
        const value = JSON.parse(entity.payload_json);
        if (corruption === "bad_capability") value.provenance.capability = "nestjs.event_pattern";
        else { const identity = JSON.parse(value.ref.logicalKey); identity[1][2] = "nonexistent"; value.ref.logicalKey = JSON.stringify(identity); }
        db.prepare("UPDATE generation_framework_entities SET payload_json = ? WHERE entity_key = ?").run(JSON.stringify(value), entity.entity_key);
      } else {
        if (corruption === "wrong_direction") [relationship.source, relationship.target] = [relationship.target, relationship.source];
        if (corruption === "invalid_callable") relationship.source.nodeId = "missing";
        if (corruption === "duplicate_handler") {
          const extra = db.prepare("SELECT id FROM generation_symbols WHERE name = 'work'").get() as { id: string };
          relationship.source.nodeId = extra.id;
        }
        const subject = frameworkSubjectKey;
        const key = JSON.stringify([subject(relationship.source), subject(relationship.target), relationship.relationKind]);
        if (corruption === "duplicate_handler") {
          const generation = db.prepare("SELECT repository_id, generation_id FROM generation_framework_relationships").get() as { repository_id: string; generation_id: string };
          db.prepare("INSERT INTO generation_framework_relationships VALUES (?, ?, ?, ?)").run(generation.repository_id, generation.generation_id, key, JSON.stringify(relationship));
        } else db.prepare("UPDATE generation_framework_relationships SET output_key = ?, payload_json = ? WHERE output_key = ?").run(key, JSON.stringify(relationship), row.output_key);
      }
    } finally { db.close(); }
    const r = await f.call(); assert.equal(r.links.length, 1); assert.equal(r.links[0].target.repositoryId, getRepositoryIdentity(f.repos[2]).id);
    const bad = r.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[1]).id);
    assert.equal(bad.consumerCoverage.scanComplete, false); assert.equal(r.mayBeIncomplete, true); assert.equal(r.counts.compatibleLinks.total, null);
  } finally { await f.close(); }
});

for (const form of ["any", "wrong_import", "dynamic", "descendant_literal", "constructor", "property", "arbitrary"] as const) test(`workspace_message_links keeps unsupported Nest producer ${form} excluded`, async () => {
  let source = nestProducer();
  if (form === "any") source = source.replace("client: ClientProxy", "client: any");
  if (form === "wrong_import") source = source.replace("ClientProxy, ", "") + '\nimport { ClientProxy } from "wrong-package";';
  if (form === "dynamic") source = source.replace('client.send("orders.get", payload)', 'client.send(payload, payload)');
  if (form === "descendant_literal") source = source.replace('client.send("orders.get", payload)', 'client.send("orders.get" + payload, payload)');
  if (form === "constructor") source = source.replace('produce(client: ClientProxy, payload: string) {', 'constructor() { const client: ClientProxy = undefined!; const payload = "payload";');
  if (form === "property") source = source.replace('produce(client: ClientProxy, payload: string)', 'client: ClientProxy; produce(payload: string)').replace('client.send(', 'this.client.send(');
  if (form === "arbitrary") source = source.replace('client: ClientProxy', 'arbitraryObject: any').replace('client.send(', 'arbitraryObject.send(');
  const f = await fixture([{ text: source }, { text: nestConsumer() }]);
  try { const r = await f.call(); assert.equal(r.producerCalls.length, 0); assert.equal(r.links.length, 0); }
  finally { await f.close(); }
});

for (const form of ["sendDefault", "ProducerRecord", "Rabbit", "Kotlin"] as const) test(`workspace_message_links keeps unsupported ${form} producer excluded`, async () => {
  let source = kafkaProducer;
  if (form === "sendDefault") source = source.replace('template.send("events", payload)', 'template.sendDefault(payload)');
  if (form === "ProducerRecord") source = source.replace('template.send("events", payload)', 'template.send(new ProducerRecord("events", payload))');
  if (form === "Rabbit") source = source.replace('KafkaTemplate<String,String>', 'RabbitTemplate').replace('org.springframework.kafka.core.KafkaTemplate', 'org.springframework.amqp.rabbit.core.RabbitTemplate');
  if (form === "Kotlin") source = source.replace('template.send("events", payload);', '');
  const f = await fixture([{ text: source, language: "java" }, { text: kafkaConsumers, language: "java" }]);
  try {
    if (form === "Kotlin") {
      await writeFile(path.join(f.repos[0], "src/Producer.kt"), 'import org.springframework.kafka.core.KafkaTemplate\nclass KotlinProducer { fun produce(template: KafkaTemplate<String, String>, payload: String) { template.send("events", payload) } }');
      assert.equal((await indexRepository(f.repos[0], { skipGit: true })).kind, "published");
    }
    const r = await f.call(); assert.equal(r.producerCalls.length, 0); assert.equal(r.links.length, 0);
  } finally { await f.close(); }
});

test("workspace_message_links role profiles preserve D-A strict compatibility and do not inspect excluded endpoint roles", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const sourceRepositoryId = getRepositoryIdentity(f.repos[0]).id, targetRepositoryId = getRepositoryIdentity(f.repos[1]).id;
    const db = new DatabaseSync(path.join(f.repos[0], ".codeatlas/atlas.db"));
    try {
      const row = db.prepare("SELECT id, versions_json FROM index_generations WHERE status = 'committed'").get() as { id: string; versions_json: string };
      const versions = JSON.parse(row.versions_json); versions.frameworkResolutionVersion = "unsupported"; versions.derivedVersion = "unrelated";
      db.prepare("UPDATE index_generations SET versions_json = ? WHERE id = ?").run(JSON.stringify(versions), row.id);
      db.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?").run(JSON.stringify(versions), row.id);
    } finally { db.close(); }
    const r = await f.call({ sourceRepositoryId, targetRepositoryId }); assert.equal(r.links.length, 1);
    const source = r.repositories.find((m: any) => m.repositoryId === sourceRepositoryId);
    assert.equal(source.producerCoverage.status, "supported"); assert.equal(source.consumerCoverage.status, "not_requested");
    const target = r.repositories.find((m: any) => m.repositoryId === targetRepositoryId); assert.equal(target.producerCoverage.status, "not_requested");
    assert.equal((await queryWorkspaceMap({ repositories: f.repos })).repositories.find(m => m.repositoryId === sourceRepositoryId)?.health.compatibility, "incompatible");
    const all = await f.call(); assert.equal(all.repositories.find((m: any) => m.repositoryId === sourceRepositoryId).consumerCoverage.status, "unsupported");
  } finally { await f.close(); }
});

for (const role of ["producer", "consumer"] as const) test(`workspace_message_links ${role} oversized payload rejected before decode and selector absence stays unknown`, async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  const originalParse = JSON.parse;
  try {
    const repo = f.repos[role === "producer" ? 0 : 1], db = new DatabaseSync(path.join(repo, ".codeatlas/atlas.db"));
    const huge = JSON.stringify({ oversizedSentinel: "x".repeat(WORKSPACE_BOUNDS.maxPayloadBytes + 1) });
    try {
      if (role === "producer") db.prepare("UPDATE fact_blobs SET payload_json = ?").run(huge);
      else db.prepare("UPDATE generation_framework_entities SET payload_json = ? WHERE kind = 'message_consumer'").run(huge);
    } finally { db.close(); }
    JSON.parse = ((value: string, ...args: unknown[]) => { assert.equal(value.includes("oversizedSentinel"), false, "oversized payload must never reach JSON.parse"); return originalParse(value, ...args as []); }) as typeof JSON.parse;
    const r = await queryWorkspaceMessageLinks({ repositories: f.repos, ...(role === "producer" ? { producerSymbol: "produce", sourceRepositoryId: getRepositoryIdentity(repo).id } : { consumerId: "missing", targetRepositoryId: getRepositoryIdentity(repo).id }) });
    assert.equal(r.scanComplete, false); assert.ok(r.work.materializedBytes <= WORKSPACE_BOUNDS.maxPayloadBytes); assert.equal(r.links.length, 0);
    assert.ok(r.repositories.some(m => m.diagnostics.some(d => d.code === "payload_budget_exceeded")));
  } finally { JSON.parse = originalParse; await f.close(); }
});

test("workspace_message_links duplicate source call refs remain qualified and compact retains endpoint evidence", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const r = await f.call({ targetRepositoryId: getRepositoryIdentity(f.repos[2]).id, detail: "compact" });
    assert.equal(r.links.length, 2); assert.equal(r.producerCalls.length, 2);
    assert.equal(r.links[0].source.producerCallRef.callId, r.links[1].source.producerCallRef.callId);
    assert.notEqual(r.links[0].source.repositoryId, r.links[1].source.repositoryId);
    assert.ok(r.links[0].provenance.targetConsumerEvidence.refs.length > 0);
    assert.equal(r.links[0].provenance.sourceProducerEvidence.proof, undefined);
  } finally { await f.close(); }
});


test("workspace_message_links counts derived candidate work before detector batches and preserves vector on cutoff", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const db = new DatabaseSync(path.join(f.repos[0], ".codeatlas/atlas.db"));
    try {
      const row = db.prepare("SELECT fact_blob_key, payload_json FROM fact_blobs").get() as { fact_blob_key: string; payload_json: string };
      const facts = JSON.parse(row.payload_json);
      facts.frameworkSyntax.nodes = Array.from({ length: 1001 }, (_, i) => ({ ...facts.frameworkSyntax.nodes[0], id: `syntax:${i + 1}` }));
      db.prepare("UPDATE fact_blobs SET payload_json = ? WHERE fact_blob_key = ?").run(JSON.stringify(facts), row.fact_blob_key);
    } finally { db.close(); }
    const originalParse = JSON.parse;
    JSON.parse = ((value: string, ...args: unknown[]) => { assert.equal(value.includes('syntax:1001'), false, "record count preflight must precede fact decode"); return originalParse(value, ...args as []); }) as typeof JSON.parse;
    let r: any;
    try { r = await f.call(); } finally { JSON.parse = originalParse; }
    assert.equal(r.links.length, 0);
    const source = r.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[0]).id);
    assert.equal(source.producerCoverage.scanComplete, false); assert.ok(source.generationId);
    assert.ok(source.diagnostics.some((d: any) => d.code === "record_budget_exceeded"));
    assert.ok(r.work.inspectedRecords <= WORKSPACE_BOUNDS.maxRecords);
    assert.ok(r.repositories.every((m: any) => m.queryCoverage.inspectedRecords <= WORKSPACE_BOUNDS.maxRecordsPerRepository));
  } finally { await f.close(); }
});

test("workspace_message_links returns mandatory evidence envelope after cooperative deadline without not_found", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    let ticks = 0;
    const r = await queryWorkspaceMessageLinks({ repositories: f.repos, consumerId: "missing", targetRepositoryId: getRepositoryIdentity(f.repos[1]).id }, { now: () => ticks++ === 0 ? 0 : 30001 });
    assert.equal(r.repositories.length, 2); assert.equal(r.scanComplete, false);
    assert.ok(r.repositories.every(m => m.health.diagnostics.includes("deadline_exceeded")));
  } finally { await f.close(); }
});


test("workspace_message_links each returned link carries static runtime limits and role corruption changes health", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const r = await f.call(); assert.match(r.links[0].runtimeLimitation, /statically compatible/i);
    const db = new DatabaseSync(path.join(f.repos[1], ".codeatlas/atlas.db"));
    db.exec("DELETE FROM generation_framework_relationships"); db.close();
    const failed = await f.call({ sourceRepositoryId: getRepositoryIdentity(f.repos[0]).id, targetRepositoryId: getRepositoryIdentity(f.repos[1]).id });
    assert.equal(failed.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[1]).id).health.availability, "unavailable");
  } finally { await f.close(); }
});


test("workspace_message_links filtered-out members keep available metadata without role scans", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }, { text: nestConsumer() }]);
  try {
    const r = await f.call({ sourceRepositoryId: getRepositoryIdentity(f.repos[0]).id, targetRepositoryId: getRepositoryIdentity(f.repos[1]).id });
    const unused = r.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[2]).id);
    assert.equal(unused.health.availability, "available"); assert.equal(unused.producerCoverage.status, "not_requested"); assert.equal(unused.consumerCoverage.status, "not_requested");
    assert.ok(unused.generationId); assert.equal(r.links.length, 1);
  } finally { await f.close(); }
});


test("workspace_message_links partial consumer publication retains known links but never proves absence", async () => {
  const partial = nestConsumer().replace('consume(p: string) { service.work(); }', 'consume(p: string) { service.work(); }\n @MessagePattern(dynamicPattern) dynamic(p: string) {}');
  const f = await fixture([{ text: nestProducer() }, { text: partial }]);
  try {
    const targetRepositoryId = getRepositoryIdentity(f.repos[1]).id;
    const r = await f.call({ targetRepositoryId });
    assert.equal(r.links.length, 1);
    assert.equal(r.repositories.find((m: any) => m.repositoryId === targetRepositoryId).consumerCoverage.scanComplete, false);
    assert.equal(r.counts.compatibleLinks.total, null);
    const absent = await f.call({ targetRepositoryId, consumerId: "missing" });
    assert.equal(absent.unlinkedProducerCalls.length, 0);
    assert.equal(absent.producerCalls[0].cardinality, "unknown");
  } finally { await f.close(); }
});

test("workspace_message_links corrupted SQLite target is isolated and selectors remain unresolved", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }, { text: nestConsumer() }]);
  try {
    await writeFile(path.join(f.repos[1], ".codeatlas/atlas.db"), "not a SQLite database");
    const r = await f.call(); assert.equal(r.links.length, 1);
    const failed = r.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[1]).id);
    assert.equal(failed.health.availability, "unavailable"); assert.equal(failed.generationId, null);
    assert.equal(r.counts.compatibleLinks.total, null);
  } finally { await f.close(); }
});

test("workspace_message_links complete role selectors report exact absence and ambiguity", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    await writeFile(path.join(f.repos[0], "src/another.ts"), "export function produce() {}\n");
    assert.equal((await indexRepository(f.repos[0], { skipGit: true })).kind, "published");
    const sourceRepositoryId = getRepositoryIdentity(f.repos[0]).id, targetRepositoryId = getRepositoryIdentity(f.repos[1]).id;
    for (const [args, code] of [[{ sourceRepositoryId, producerSymbol: "missing" }, "not_found"], [{ sourceRepositoryId, producerSymbol: "produce" }, "ambiguous"], [{ targetRepositoryId, consumerId: "missing" }, "not_found"]] as const) {
      const r = await f.client.callTool({ name: "workspace_message_links", arguments: { repositories: f.repos, ...args } });
      assert.equal(r.isError, true, JSON.stringify({ args, r })); assert.match(JSON.stringify(r), new RegExp(code));
    }
  } finally { await f.close(); }
});


test("workspace_message_links empty consumer slice validates persisted detection metadata", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const db = new DatabaseSync(path.join(f.repos[1], ".codeatlas/atlas.db"));
    db.exec("DELETE FROM generation_framework_entities; DELETE FROM generation_framework_relationships; UPDATE generation_framework_state SET detections_json = '[{}]'"); db.close();
    const r = await f.call({ targetRepositoryId: getRepositoryIdentity(f.repos[1]).id, consumerId: "missing" });
    assert.equal(r.links.length, 0); assert.equal(r.producerCalls[0].cardinality, "unknown");
    assert.equal(r.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[1]).id).consumerCoverage.status, "unavailable");
  } finally { await f.close(); }
});

test("workspace_message_links partial source syntax never authorizes producer selector absence", async () => {
  const f = await fixture([{ text: nestProducer() }, { text: nestConsumer() }]);
  try {
    const db = new DatabaseSync(path.join(f.repos[0], ".codeatlas/atlas.db"));
    const row = db.prepare("SELECT fact_blob_key, payload_json FROM fact_blobs").get() as { fact_blob_key: string; payload_json: string };
    const facts = JSON.parse(row.payload_json); delete facts.frameworkSyntax;
    db.prepare("UPDATE fact_blobs SET payload_json = ? WHERE fact_blob_key = ?").run(JSON.stringify(facts), row.fact_blob_key); db.close();
    const r = await f.call({ sourceRepositoryId: getRepositoryIdentity(f.repos[0]).id, producerSymbol: "produce" });
    assert.equal(r.producerCalls.length, 0); assert.equal(r.counts.producerCalls.total, null);
    assert.equal(r.repositories.find((m: any) => m.repositoryId === getRepositoryIdentity(f.repos[0]).id).producerCoverage.scanComplete, false);
    const missing = await f.call({ sourceRepositoryId: getRepositoryIdentity(f.repos[0]).id, producerSymbol: "missing" });
    assert.equal(missing.counts.producerCalls.total, null);
  } finally { await f.close(); }
});

test("workspace_message_links larger fanout streams a deterministic prefix under one output limit", async () => {
  const listeners = `import org.springframework.kafka.annotation.KafkaListener;\nclass Consumer {\n${Array.from({ length: 12 }, (_, i) => ` @KafkaListener(topics="events", groupId="group${i}") void consume${i}(String p) {}`).join("\n")}\n}`;
  const f = await fixture([{ text: kafkaProducer, language: "java" }, ...Array.from({ length: 3 }, () => ({ text: listeners, language: "java" }))]);
  try {
    const full = await f.call({ limit: 1000 }), limited = await f.call({ limit: 7 });
    assert.equal(full.links.length, 36); assert.equal(limited.links.length, 6);
    assert.deepEqual(limited.links, full.links.slice(0, 6));
    assert.equal(limited.counts.compatibleLinks.total, 36); assert.equal(limited.counts.compatibleLinks.omitted, 30);
    assert.equal(limited.producerCalls.length + limited.links.length + limited.unlinkedProducerCalls.length + limited.diagnostics.length, 7);
    assert.ok(limited.work.materializedBytes <= WORKSPACE_BOUNDS.maxPayloadBytes);
    assert.deepEqual(await f.call({ limit: 7, repositories: [...f.repos].reverse() }), limited);
  } finally { await f.close(); }
});


test("workspace_message_links sixteen members share global work bounds and one read handle", async () => {
  const f = await fixture(Array.from({ length: 16 }, () => ({ text: nestConsumer() })));
  const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
  const opened = new Set<DatabaseSync>(); let peak = 0;
  try {
    for (const repo of f.repos) {
      const db = new DatabaseSync(path.join(repo, ".codeatlas/atlas.db"));
      const id = getRepositoryIdentity(repo).id;
      const gen = db.prepare("SELECT active_generation_id FROM repository_index_state WHERE repository_id = ?").get(id) as { active_generation_id: string };
      const row = db.prepare("SELECT * FROM generation_symbols WHERE repository_id = ? AND generation_id = ? AND type = 'method' LIMIT 1").get(id, gen.active_generation_id)!;
      const columns = Object.keys(row), insert = db.prepare(`INSERT INTO generation_symbols (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      db.exec("BEGIN");
      for (let i = 0; i < 850; i++) insert.run(...columns.map(c => c === "id" ? `budget-node-${i}` : c === "name" || c === "qualified_name" ? `budgetName${i}` : row[c]));
      db.exec("COMMIT"); db.close();
    }
    DatabaseSync.prototype.exec = function(sql: string) { if (sql === "BEGIN;") { opened.add(this); peak = Math.max(peak, opened.size); } return originalExec.call(this, sql); };
    DatabaseSync.prototype.close = function() { opened.delete(this); return originalClose.call(this); };
    const r = await f.call({ limit: 1000 });
    assert.equal(r.repositories.length, 16); assert.equal(r.generationVector.length, 16);
    assert.equal(peak, 1); assert.equal(opened.size, 0);
    assert.ok(r.work.inspectedRecords <= WORKSPACE_BOUNDS.maxRecords);
    assert.ok(r.work.materializedBytes <= WORKSPACE_BOUNDS.maxPayloadBytes);
    assert.ok(r.repositories.every((m: any) => m.queryCoverage.inspectedRecords <= WORKSPACE_BOUNDS.maxRecordsPerRepository));
    assert.ok(r.repositories.some((m: any) => m.diagnostics.some((d: any) => d.code === "record_budget_exceeded")));
    assert.equal(r.scanComplete, false); assert.equal(r.counts.consumersInspected.total, null);
    await assert.rejects(queryWorkspaceMessageLinks({ repositories: [...f.repos, f.root] }), { code: "invalid_arguments" });
  } finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalClose; await f.close(); }
});
