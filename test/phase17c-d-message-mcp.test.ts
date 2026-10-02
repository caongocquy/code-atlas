import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { buildRepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const cases = [
  ["nestjs", "request_response", "@MessagePattern('users.find')"],
  ["nestjs", "event", "@EventPattern('users.created')"],
  ["spring", "event", '@KafkaListener(topics="users.created")'],
  ["spring", "event", '@RabbitListener(queues="users.created")'],
] as const;
function source(framework: string, annotation: string) {
  return framework === "nestjs" ? `import { Controller } from "@nestjs/common";
import { MessagePattern, EventPattern } from "@nestjs/microservices";
class WorkService { work() { return "ok"; } }
const service: WorkService = new WorkService();
@Controller()
export class Jobs {
  ${annotation}
  runJob(payload: string) { return service.work(); }
}
` : `import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
class WorkService { public String work() { return "ok"; } }
public class Jobs {
  private WorkService service;
  ${annotation}
  public void runJob(String payload) { service.work(); }
}
`;
}
for (const [framework, consumerKind, annotation] of cases) test(`message_consumer real ${framework} ${annotation}: Atlas, same-ID MCP flow and calls`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase17c-d-"));
  const server = createMcpServer();
  const client = new Client({ name: "phase17c-d", version: "1.0.0" });
  try {
    await mkdir(path.join(root, "src"));
    const file = `src/jobs.${framework === "nestjs" ? "ts" : "java"}`;
    await writeFile(path.join(root, file), source(framework, annotation));
    const indexed = await indexRepository(root, { skipGit: true });
    assert.equal(indexed.kind, "published", indexed.kind === "failed" ? indexed.failure.message : undefined);
    const loaded = await loadIndexedGraphReadOnly(root);
    const entries = buildRepositoryEntryCatalog(loaded.framework).entries;
    assert.equal(entries.length, 1);
    const entry = entries[0]!;
    assert.equal(entry.kind, "message_consumer");
    if (entry.kind !== "message_consumer") throw new Error("Expected message_consumer entry");
    assert.equal(entry.consumerKind, consumerKind);
    assert.equal(entry.exposure, "declared_mapping");
    for (const key of ["path", "method", "operationKind", "fieldName", "triggerKind", "schedule"]) assert.equal(key in entry, false);
    const flow = discoverExecutionFlow(loaded.graph, loaded.framework, { kind: "message_consumer", id: entry.id });
    assert.equal(flow.status, "resolved");
    assert.ok(flow.edges.some((edge) => edge.kind === "framework_entry" && edge.relation === "message_handler"));
    assert.ok(flow.nodes.some((node) => node.subject.kind === "language" && node.subject.node.name === "work"));
    assert.equal(flow.mayBeIncomplete, true);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
    try { assert.equal(store.loadFramework(loaded.repoId)?.entities[0]?.ref.kind, "message_consumer"); }
    finally { store.close(); }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const listed = await client.callTool({ name: "list_entries", arguments: { repoPath: root, kind: "message_consumer", consumerKind: consumerKind, detail: "full" } });
    const payload = listed.structuredContent as { entries: typeof entries };
    assert.equal(payload.entries[0]?.id, entry.id);
    const selected = await client.callTool({ name: "execution_flow", arguments: { repoPath: root, entry: { kind: "message_consumer", id: entry.id } } });
    const publicFlow = selected.structuredContent as { status: string; edges: {kind:string;relation?:string}[]; nodes: {subject:{kind:string;node?:{name:string}}}[]; mayBeIncomplete:boolean };
    assert.equal(publicFlow.status, "resolved");
    assert.ok(publicFlow.edges.some(edge => edge.kind === "framework_entry" && edge.relation === "message_handler"));
    assert.ok(publicFlow.nodes.some(node => node.subject.kind === "language" && node.subject.node?.name === "work"));
    assert.equal(publicFlow.mayBeIncomplete,true);
    await writeFile(path.join(root, file), "\n\n" + source(framework, annotation));
    const synced = await syncRepository(root, { skipGit: true });
    assert.equal(synced.kind, "published");
    const moved = await loadIndexedGraphReadOnly(root);
    assert.equal(buildRepositoryEntryCatalog(moved.framework).entries[0]?.id, entry.id);
    const wrongFilter = await client.callTool({name:"list_entries",arguments:{repoPath:root,kind:"message_consumer",destination:"other",detail:"full"}});
    assert.equal((wrongFilter.structuredContent as {entries:unknown[]}).entries.length,0);
    if (framework === "spring" && annotation.includes("KafkaListener")) {
      await writeFile(path.join(root,file),source(framework,annotation.replace('topics=', 'concurrency="3", containerFactory="factory", topics=')));
      assert.equal((await syncRepository(root,{skipGit:true})).kind,"published");
      const metadata=buildRepositoryEntryCatalog((await loadIndexedGraphReadOnly(root)).framework).entries[0]!;
      assert.equal(metadata.id,entry.id);assert.ok(metadata.kind==="message_consumer"&&metadata.metadata.concurrency==="3");
      const db=new DatabaseSync(path.join(root,".codeatlas","atlas.db"));
      const current=(await loadIndexedGraphReadOnly(root)).evidenceState.generationId;
      try {
        for(const [table,column,where] of [["index_generations","versions_json","id"],["index_manifests","versions_json","generation_id"]]) {
          const row=db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}=?`).get(current) as {value:string};
          db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}=?`).run(JSON.stringify({...JSON.parse(row.value),frameworkResolutionVersion:"1.5.0"}),current);
        }
        db.prepare("UPDATE generation_framework_state SET framework_resolution_version='1.5.0' WHERE generation_id=?").run(current);
      }finally{db.close();}
      const upgrade=await syncRepository(root,{skipGit:true});assert.equal(upgrade.kind,"published");
      if(upgrade.kind==="published") assert.ok(upgrade.counters.frameworkFilesResolved>0);
      const upgraded=await loadIndexedGraphReadOnly(root);
      assert.equal(buildRepositoryEntryCatalog(upgraded.framework).entries[0]?.id,entry.id);
      const atlas=new AtlasStore(path.join(root,".codeatlas","atlas.db"),{readOnly:true});
      try{assert.equal(atlas.loadFramework(upgraded.repoId)?.frameworkResolutionVersion,FRAMEWORK_RESOLUTION_VERSION);}finally{atlas.close();}
    }
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

for (const framework of ["nestjs","spring"] as const) for (const mixed of [false,true]) test(`message production partial ${framework}, accepted entries=${mixed?1:0}; ambiguous candidate preserves active`, async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"code-atlas-phase17c-d-partial-"));
  try {
    await mkdir(path.join(root,"src"));
    const file=path.join(root,"src",framework==="nestjs"?"jobs.ts":"Jobs.java");
    const declarations=framework==="nestjs"
      ? 'import {Controller} from "@nestjs/common"; import {MessagePattern,EventPattern} from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern(EXPR) dynamic() {} '+(mixed?'@EventPattern("users") valid() {}':'')+' }'
      : 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics={"a" + "b"}) void dynamic() {} '+(mixed?'@KafkaListener(topics="users") void valid() {}':'')+' }';
    await writeFile(file,declarations);
    const published=await indexRepository(root,{skipGit:true});assert.equal(published.kind,"published",JSON.stringify(published));
    const loaded=await loadIndexedGraphReadOnly(root);const catalog=buildRepositoryEntryCatalog(loaded.framework);
    assert.equal(catalog.entries.length,mixed?1:0);assert.equal(catalog.mayBeIncomplete,true);
    assert.ok(loaded.framework?.diagnostics.some(d=>d.code==="framework_message_unsupported"));
    const store=new AtlasStore(path.join(root,".codeatlas","atlas.db"),{readOnly:true});
    try {assert.equal(store.loadFramework(loaded.repoId)?.complete,false);} finally {store.close();}
    const ambiguous=framework==="nestjs"
      ? 'import {Controller} from "@nestjs/common"; import {MessagePattern} from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern("users") run(x:string) {} @MessagePattern("users") run(x:number) {} }'
      : 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="users") @KafkaListener(topics="users") void run() {} }';
    await writeFile(file,ambiguous);const failed=await syncRepository(root,{skipGit:true});assert.equal(failed.kind,"failed");
    assert.equal((await loadIndexedGraphReadOnly(root)).evidenceState.generationId,loaded.evidenceState.generationId);
  } finally {await rm(root,{recursive:true,force:true});}
});
