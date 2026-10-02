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
  ["nestjs", "cron", "@Cron('0 * * * * *', { name: 'job', timeZone: 'UTC' })"],
  ["nestjs", "interval", "@Interval('job', 1000)"],
  ["nestjs", "timeout", "@Timeout('job', 0)"],
  ["spring", "cron", '@Scheduled(cron="0 * * * * *", zone="UTC")'],
  ["spring", "fixed_rate", "@Scheduled(fixedRate=1000, initialDelay=50)"],
  ["spring", "fixed_delay", "@Scheduled(fixedDelay=2000)"],
] as const;
function source(framework: string, annotation: string) {
  return framework === "nestjs" ? `import { Cron, Interval, Timeout } from "@nestjs/schedule";
class WorkService { work() { return "ok"; } }
const service: WorkService = new WorkService();
export class Jobs {
  ${annotation}
  runJob() { return service.work(); }
}
` : `import org.springframework.scheduling.annotation.Scheduled;
class WorkService { public String work() { return "ok"; } }
public class Jobs {
  private WorkService service;
  ${annotation}
  public void runJob() { service.work(); }
}
`;
}
for (const [framework, trigger, annotation] of cases) test(`scheduled real ${framework} ${trigger}: Atlas, same-ID MCP flow and calls`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase17c-c-"));
  const server = createMcpServer();
  const client = new Client({ name: "phase17c-c", version: "1.0.0" });
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
    assert.equal(entry.kind, "scheduled");
    if (entry.kind !== "scheduled") throw new Error("Expected scheduled entry");
    assert.equal(entry.triggerKind, trigger);
    assert.equal(entry.exposure, "declared_mapping");
    for (const key of ["path", "method", "operationKind", "fieldName"]) assert.equal(key in entry, false);
    const flow = discoverExecutionFlow(loaded.graph, loaded.framework, { kind: "scheduled", id: entry.id });
    assert.equal(flow.status, "resolved");
    assert.ok(flow.edges.some((edge) => edge.kind === "framework_entry" && edge.relation === "scheduled_handler"));
    assert.ok(flow.nodes.some((node) => node.subject.kind === "language" && node.subject.node.name === "work"));
    assert.equal(flow.mayBeIncomplete, true);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
    try { assert.equal(store.loadFramework(loaded.repoId)?.entities[0]?.ref.kind, "scheduled_job"); }
    finally { store.close(); }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);
    const listed = await client.callTool({ name: "list_entries", arguments: { repoPath: root, kind: "scheduled", triggerKind: trigger, detail: "full" } });
    const payload = listed.structuredContent as { entries: typeof entries };
    assert.equal(payload.entries[0]?.id, entry.id);
    const selected = await client.callTool({ name: "execution_flow", arguments: { repoPath: root, entry: { kind: "scheduled", id: entry.id } } });
    assert.equal((selected.structuredContent as { status: string }).status, "resolved");
    await writeFile(path.join(root, file), "\n\n" + source(framework, annotation));
    const synced = await syncRepository(root, { skipGit: true });
    assert.equal(synced.kind, "published");
    const moved = await loadIndexedGraphReadOnly(root);
    assert.equal(buildRepositoryEntryCatalog(moved.framework).entries[0]?.id, entry.id);
    const wrongFilter = await client.callTool({name:"list_entries",arguments:{repoPath:root,kind:"scheduled",triggerKind:trigger === "cron" ? "timeout" : "cron",detail:"full"}});
    assert.equal((wrongFilter.structuredContent as {entries:unknown[]}).entries.length,0);
    if(framework === "nestjs" && trigger === "cron") {
      await writeFile(path.join(root,file),source(framework,annotation.replace("{ name:","{ disabled: true, waitForCompletion: true, name:")));
      assert.equal((await syncRepository(root,{skipGit:true})).kind,"published");
      const metadata=buildRepositoryEntryCatalog((await loadIndexedGraphReadOnly(root)).framework).entries[0]!;
      assert.equal(metadata.id,entry.id);assert.ok(metadata.kind==="scheduled"&&metadata.declaration.disabled&&metadata.declaration.waitForCompletion);
      const db=new DatabaseSync(path.join(root,".codeatlas","atlas.db"));
      const current=(await loadIndexedGraphReadOnly(root)).evidenceState.generationId;
      try {
        for(const [table,column,where] of [["index_generations","versions_json","id"],["index_manifests","versions_json","generation_id"]]) {
          const row=db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}=?`).get(current) as {value:string};
          db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${where}=?`).run(JSON.stringify({...JSON.parse(row.value),frameworkResolutionVersion:"1.4.0"}),current);
        }
        db.prepare("UPDATE generation_framework_state SET framework_resolution_version='1.4.0' WHERE generation_id=?").run(current);
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

for(const mixed of [false,true]) test(`scheduled production partial publication retains diagnostics, accepted entries=${mixed?1:0}`,async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"code-atlas-phase17c-c-partial-"));
  try{
    await mkdir(path.join(root,"src"));
    const body=`import {Cron,Interval} from "@nestjs/schedule"; class Jobs { @Cron(EXPR) dynamic() {} ${mixed?'@Interval(100) valid() {}':''} }`;
    await writeFile(path.join(root,"src","jobs.ts"),body);
    const result=await indexRepository(root,{skipGit:true});assert.equal(result.kind,"published",JSON.stringify(result));
    const loaded=await loadIndexedGraphReadOnly(root);assert.equal(buildRepositoryEntryCatalog(loaded.framework).entries.length,mixed?1:0);
    assert.equal(loaded.framework?.mayBeIncomplete,true);
    assert.equal(loaded.framework?.diagnostics[0]?.code,"framework_schedule_unsupported");
    const store=new AtlasStore(path.join(root,".codeatlas","atlas.db"),{readOnly:true});
    try{assert.equal(store.loadFramework(loaded.repoId)?.complete,false);}finally{store.close();}
    await writeFile(path.join(root,"src","jobs.ts"),'import {Interval} from "@nestjs/schedule"; class Jobs { @Interval(100) run(x:any) {} }');
    const failed=await syncRepository(root,{skipGit:true});assert.equal(failed.kind,"failed");
    const preserved=await loadIndexedGraphReadOnly(root);assert.equal(preserved.evidenceState.generationId,loaded.evidenceState.generationId);
  }finally{await rm(root,{recursive:true,force:true});}
});
