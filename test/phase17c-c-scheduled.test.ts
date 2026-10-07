import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { filterRepositoryEntries } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import { projectRepositoryEntryCatalogResponse } from "../src/adapters/mcp/mcp-server.js";
import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { springAdapter } from "../src/core/framework/adapters/spring.js";
import { frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import { planFrameworkInvalidation } from "../src/core/framework/framework-invalidation.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import type { FrameworkAnalysisContext, FrameworkSemanticAdapter } from "../src/core/framework/framework.types.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { projectFrameworkGraph } from "../src/core/graph/query/framework-query.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { buildRepositoryMap } from "../src/core/graph/intelligence/repository-map.service.js";
import { defaultArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";
import { buildRepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";

import { decodeScheduledIdentity, isPublishableScheduledDiagnostic } from "../src/core/framework/framework-scheduled.js";
function sourceCase(language: "typescript" | "java" | "kotlin", source: string, partial = false) {
  const relativePath = language === "java" ? "src/Resolver.java" : language === "kotlin" ? "src/Resolver.kt" : "src/resolver.ts";
  const extracted = extractParsedFacts({ source, filePath: relativePath, language, contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw new Error("fixture extraction failed");
  const facts = extracted.facts;
  if (partial && facts.frameworkSyntax) facts.frameworkSyntax = { ...facts.frameworkSyntax, complete: false };
  const graph: CodeGraph = { nodes: facts.symbols.filter((s) => s.kind === "class" || s.kind === "method").map((s): GraphNode => ({
    id: `graph:${s.localId}`, type: s.kind as "class" | "method", name: s.name, qualifiedName: s.declaredQualifiedName ?? s.name, file: relativePath,
    startLine: s.range.startLine, endLine: s.range.endLine,
  })), edges: [] };
  const adapter: FrameworkSemanticAdapter = language === "typescript" ? nestjsAdapter : springAdapter;
  const base = { repositoryId: "repo", facts: [{ relativePath, facts }], graph, config: [] };
  const ctx: FrameworkAnalysisContext = { ...base, generationId: "gen", frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION,
    detections: adapter.detect(base), analyzePaths: new Set([relativePath]), maxObservations: 100 };
  const evidence = adapter.analyze(ctx).evidence;
  const materialization = resolveFrameworkEvidence(ctx, evidence);
  const catalog = buildRepositoryEntryCatalog(projectFrameworkGraph(graph, { ...materialization, repositoryId: "repo", generationId: "gen" }));
  return { materialization, catalog, ctx, evidence, projection: projectFrameworkGraph(graph, { ...materialization, repositoryId: "repo", generationId: "gen" }) };
}

const nest = (body: string) => 'import { Cron, Interval, Timeout } from "@nestjs/schedule";\n' + body;
const spring = (body: string) => 'import org.springframework.scheduling.annotation.Scheduled;\n' + body;
const ids = (r: ReturnType<typeof sourceCase>) => r.materialization.entities.map((e) => frameworkEntityKey(e.ref));
test("scheduled callable identity is stable across lines and metadata, distinct across methods and modifiers", () => {
  const a = sourceCase("typescript", nest('class Jobs { @Cron("* * * * * *", {disabled:false}) one() {} @Cron("* * * * * *") two() {} }'));
  const b = sourceCase("typescript", nest('\n\nclass Jobs { @Cron("* * * * * *", {disabled:true,waitForCompletion:true}) one() {} @Cron("* * * * * *") two() {} }'));
  assert.equal(a.materialization.entities.length, 2); assert.deepEqual(ids(a), ids(b));
  assert.equal(b.materialization.entities.some((e) => e.scheduledMetadata?.disabled), true);
  assert.notDeepEqual(ids(a), ids(sourceCase("typescript", nest('class Jobs { @Cron("* * * * * *", {timeZone:"UTC"}) one() {} }'))));
  const repeat = sourceCase("java", spring('class Jobs { @Scheduled(fixedRate=100) @Scheduled(fixedDelay=200) void one() {} }'));
  assert.equal(repeat.materialization.entities.length, 2);
});
test("scheduled declarations preserve exact literal options, aliases and disabled Spring cron", () => {
  const result = sourceCase("typescript", 'import {Cron as C} from "@nestjs/schedule"; class Jobs { @C("* * * * * *", {name:"job",utcOffset:60,disabled:true,waitForCompletion:true}) run() {} }');
  assert.equal(result.catalog.entries.length, 1);
  const entity = result.materialization.entities[0]!;
  assert.deepEqual(decodeScheduledIdentity("nestjs",entity.ref.logicalKey)?.slice(2), ["cron",{kind:"cron",expression:"* * * * * *"},"job",{timeZone:null,utcOffset:60,initialDelay:null}]);
  const disabled = sourceCase("java",spring('class Jobs { @Scheduled(cron="-") void run() {} }'));
  assert.equal(disabled.materialization.entities[0]?.scheduledMetadata?.disabled,true);
});
test("bounded unsupported Nest forms emit diagnostics and no invented scheduled entries", () => {
  for (const annotation of ['@Cron(EXPR)','@Cron(CronExpression.EVERY_DAY)','@Cron(new Date())','@Cron("* * * * * *", {...options})','@Cron("* * * * * *", {name:NAME})','@Cron("* * * * * *", {timeZone:"UTC",utcOffset:0})','@Interval(0)','@Interval(-1)','@Timeout(1.5)','@Timeout(9007199254740992)','@Cron("* * * * * *") @Timeout(1)']) {
    const r = sourceCase("typescript",nest(`class Jobs { ${annotation} run() {} }`));
    assert.equal(r.materialization.entities.length,0,annotation); assert.ok(r.materialization.diagnostics.length,annotation);
    assert.ok(r.materialization.diagnostics.every(isPublishableScheduledDiagnostic),annotation);
  }
});
test("bounded unsupported Spring forms do not decode enums, placeholders or alternative numeric syntax", () => {
  for (const annotation of ['@Scheduled(cron="${cron}")','@Scheduled(cron="#{bean.cron}")','@Scheduled(cron="* * * * * *"+EXPR)','@Scheduled(fixedRate=VALUE)','@Scheduled(fixedRate=1000L)','@Scheduled(fixedRate=1_000)','@Scheduled(fixedRate=100,timeUnit=TimeUnit.SECONDS)','@Scheduled(fixedRateString="1000")','@Scheduled(fixedRate=100,fixedDelay=200)','@Scheduled(cron="* * * * * *",initialDelay=1)']) {
    const r=sourceCase("java",spring(`class Jobs { ${annotation} void run() {} }`));
    assert.equal(r.materialization.entities.length,0,annotation); assert.ok(r.materialization.diagnostics.length,annotation);
    assert.ok(r.materialization.diagnostics.every(isPublishableScheduledDiagnostic),annotation);
  }
});
test("scheduling origin, partial facts and duplicate declarations fail closed", () => {
  assert.equal(sourceCase("typescript",'import {Cron} from "other"; class Jobs { @Cron("* * * * * *") run() {} }').materialization.entities.length,0);
  const shadow=sourceCase("typescript",nest('function Cron() {} class Jobs { @Cron("* * * * * *") run() {} }'));
  assert.equal(shadow.materialization.entities.length,0); assert.ok(shadow.materialization.diagnostics.length);
  const partial=sourceCase("typescript",nest('class Jobs { @Interval(1) run() {} }'),true);
  assert.equal(partial.materialization.entities.length,0); assert.ok(partial.materialization.diagnostics.some((d)=>!isPublishableScheduledDiagnostic(d)));
  const duplicate=sourceCase("java",spring('class Jobs { @Scheduled(fixedRate=100) @Scheduled(fixedRate=100) void run() {} }'));
  assert.equal(duplicate.materialization.relationships.length,0); assert.ok(duplicate.materialization.diagnostics.some((d)=>!isPublishableScheduledDiagnostic(d)));
});
test("scheduled filters, exact flow selector and repository map remain isolated", () => {
  const r=sourceCase("typescript",nest('class Jobs { @Interval("job",100) one() {} @Timeout(0) two() {} }'));
  assert.equal(r.catalog.entries.length,2);
  const id=r.catalog.entries[0]!.id;
  const flow=discoverExecutionFlow(r.ctx.graph,r.projection,{kind:"scheduled",id});
  assert.equal(flow.status,"resolved"); assert.equal(flow.edges[0]?.kind==="framework_entry"&&flow.edges[0].relation,"scheduled_handler");
  assert.ok(flow.diagnostics.some((d)=>d.code==="runtime_registration_unverified"));
  const missing=discoverExecutionFlow(r.ctx.graph,{...r.projection,edges:[]},{kind:"scheduled",id});
  assert.ok(missing.diagnostics.some((d)=>d.code==="scheduled_binding_missing"));
  assert.equal(discoverExecutionFlow(r.ctx.graph,r.projection,{kind:"scheduled",id:"bad"}).status,"not_found");
  const withSchedules=buildRepositoryMap(r.ctx.graph,defaultArchitecturePolicy(),r.projection);
  const without=buildRepositoryMap(r.ctx.graph,defaultArchitecturePolicy());
  assert.ok(withSchedules.areas.every((a)=>a.executionEntryBindingCount===0));
  assert.ok(withSchedules.areas.some((a)=>a.frameworkIds.includes("nestjs")));
  assert.deepEqual(withSchedules.relations,without.relations);
});

test("scheduled exact filters precede bounded projection and ordering survives declaration reorder", () => {
  const one='class Jobs { @Interval("job",100) one() {} @Timeout(0) two() {} }';
  const r=sourceCase("typescript",nest(one));
  assert.equal(filterRepositoryEntries(r.catalog.entries,{kind:"scheduled",framework:"nestjs",triggerKind:"interval",declaredName:"job"}).length,1);
  for(const f of [{path:"/"},{method:"GET"},{declaredName:"Job"},{framework:"spring" as const}]) assert.equal(filterRepositoryEntries(r.catalog.entries,f).length,0);
  const out=projectRepositoryEntryCatalogResponse(r.catalog,{kind:"scheduled"},"full",1);
  assert.deepEqual((out.projection as {entries:unknown}).entries,{total:2,returned:1,omitted:1,truncated:true});
  assert.deepEqual(ids(r),ids(sourceCase("typescript",nest('class Jobs { @Timeout(0) two() {} @Interval("job",100) one() {} }'))));
  const detection=sourceCase("typescript",nest('class Jobs { run() {} }'));
  assert.equal(detection.catalog.entries.length,0); assert.ok(detection.ctx.detections[0]?.capabilities.includes("nestjs.schedule"));
  const packageOnly=nestjsAdapter.detect({...detection.ctx,facts:[],graph:{nodes:[],edges:[]},config:[{relativePath:"package.json",scope:"root",inputKey:"config:package.json",kind:"package",values:{"@nestjs/schedule":"1"},complete:true}]});
  assert.ok(packageOnly[0]?.capabilities.includes("nestjs.schedule")); assert.equal(packageOnly[0]?.observed,false);
});
test("scheduled identity rejects malformed trust-boundary payloads and distinguishes trigger modifiers", () => {
  const r=sourceCase("typescript",nest('class Jobs { @Interval(100) run() {} }'));
  const ref=r.materialization.entities[0]!.ref;
  const canonical=JSON.parse(ref.logicalKey) as unknown[];
  const bad=(index:number,value:unknown)=>canonical.map((v,i)=>i===index?value:v);
  for(const key of [bad(0,"../root"),bad(1,["/src/file.ts","Jobs","run"]),bad(1,["src/file.ts","Jobs","run",1]),bad(2,"fixed_delay"),bad(3,{kind:"duration",value:-1,unit:"milliseconds"}),bad(3,{kind:"duration",value:100,unit:"seconds"}),bad(5,{timeZone:"UTC",utcOffset:null,initialDelay:null}),bad(5,{timeZone:null,utcOffset:null,initialDelay:null,disabled:true})]) {
    assert.throws(()=>frameworkEntityKey({...ref,logicalKey:JSON.stringify(key)}));
  }
  const duration=canonical[3];
  assert.notEqual(frameworkEntityKey(ref),frameworkEntityKey({...ref,logicalKey:JSON.stringify(bad(2,"timeout"))}));
  assert.ok(duration);
  for(const annotation of ['@Timeout(10)','@Timeout("job",10)','@Interval(10)','@Interval("job",10)']) assert.equal(sourceCase("typescript",nest(`class Jobs { ${annotation} run() {} }`)).catalog.entries.length,1);
  const a=sourceCase("java",spring('class Jobs { @Scheduled(fixedRate=100,initialDelay=1) void run() {} }'));
  const b=sourceCase("java",spring('class Jobs { @Scheduled(fixedRate=100,initialDelay=2) void run() {} }'));
  assert.notDeepEqual(ids(a),ids(b));
  for(const annotation of ['@Scheduled(fixedRate=-1)','@Scheduled(fixedDelay=1+2)','@Scheduled(fixedRate = -1)','@Scheduled(fixedRate =100)','@Scheduled(initialDelay=1)']) assert.equal(sourceCase("java",spring(`class Jobs { ${annotation} void run() {} }`)).materialization.entities.length,0,annotation);
  for(const annotation of ['@Interval(1+2)','@Timeout(+1)','@Cron("* * * * * *", {utcOffset:-60})','@Cron("* * * * * *", {name:"a"+"b"})']) assert.equal(sourceCase("typescript",nest(`class Jobs { ${annotation} run() {} }`)).materialization.entities.length,0,annotation);
});
test("scheduled ambiguous flow fails closed with provenance, limits and existing call cycles", () => {
  const r=sourceCase("typescript",nest('class Jobs { @Interval(100) one() {} two() {} }'));
  const id=r.catalog.entries[0]!.id;
  const relationship=r.materialization.relationships[0]!;
  assert.equal(relationship.source.kind,"language");
  if(relationship.source.kind!=="language") throw new Error("Expected callable");
  const owner=relationship.source.nodeId;
  const other=r.ctx.graph.nodes.find((n)=>n.type==="method"&&n.id!==owner)!;
  const graph={...r.ctx.graph,edges:[{from:owner,to:other.id,type:"calls" as const},{from:other.id,to:owner,type:"calls" as const}]};
  const flow=discoverExecutionFlow(graph,r.projection,{kind:"scheduled",id});
  assert.equal(flow.cycles.length,1); assert.deepEqual(flow.edges[0]?.kind==="framework_entry"&&flow.edges[0].provenance,relationship.provenance);
  assert.equal(discoverExecutionFlow(graph,r.projection,{kind:"scheduled",id},{maxNodes:1}).truncated,true);
  assert.equal(discoverExecutionFlow(graph,r.projection,{kind:"scheduled",id},{maxDepth:0}).truncated,true);
  const ambiguous={...r.projection,edges:[...r.projection.edges,{kind:"framework" as const,relationship:{...relationship,source:{kind:"language" as const,nodeId:other.id}}}]};
  assert.equal(discoverExecutionFlow(graph,ambiguous,{kind:"scheduled",id}).status,"ambiguous");
  assert.equal(buildRepositoryEntryCatalog(ambiguous).entries.length,0);
});
test("scheduled Atlas policy A-F: supported, bounded partial, unknown diagnostics, conflicts and active safety",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"code-atlas-phase17c-c-policy-"));
  const store=new AtlasStore(path.join(root,"atlas.db"));
  try {
    const repository=store.ensureRepository(getRepositoryIdentity(root));
    const good=sourceCase("typescript",nest('class Jobs { @Interval(100) one() {} two() {} }'));
    const mixed=sourceCase("typescript",nest('class Jobs { @Interval(100) one() {} @Cron(EXPR) two() {} }'));
    const dynamic=sourceCase("typescript",nest('class Jobs { @Cron(EXPR) one() {} }'));
    const stage=(r:ReturnType<typeof sourceCase>,candidate=r.materialization)=>{
      const generation=createCandidateGeneration(repository.id,store.getActiveGenerationId(repository.id),CURRENT_INDEX_VERSION_DOMAINS,[]);
      store.beginCandidateGeneration(generation);store.writeCandidateManifest(generation.manifest);
      store.writeCandidateGraph(generation.id,r.ctx.graph,new Map());
      store.writeCandidateFramework(generation.id,candidate);
      return generation.id;
    };
    const complete=stage(good);store.publishCandidateGeneration(complete,{frameworkStaged:true});
    assert.equal(store.loadFramework(repository.id)?.complete,true);
    const partial=stage(mixed);store.publishCandidateGeneration(partial,{frameworkStaged:true});
    const loaded=store.loadFramework(repository.id)!;
    assert.equal(loaded.entities.length,1);assert.equal(loaded.complete,false);assert.ok(loaded.diagnostics[0]!.refs[0]!.range);
    assert.equal(loaded.coverage.reduce((n,c)=>n+c.unsupported,0),1);
    const empty=stage(dynamic);store.publishCandidateGeneration(empty,{frameworkStaged:true});
    assert.equal(store.loadFramework(repository.id)?.entities.length,0);assert.equal(store.loadFramework(repository.id)?.complete,false);
    const active=store.getActiveGenerationId(repository.id);
    const diagnostic=dynamic.materialization.diagnostics[0]!;
    for(const change of [
      {diagnostics:[{...diagnostic,reason:"unknown_unsupported"}]},
      {diagnostics:[{...diagnostic,code:"framework_adapter_failed" as const,outcome:"adapter_failed" as const}]},
      {diagnostics:[{...diagnostic,code:"framework_target_unknown" as const,outcome:"unknown" as const}]},
      {detections:[]},
      {coverage:dynamic.materialization.coverage.map((c)=>({...c,unknown:1,unsupported:0}))},
    ]) {
      const failed=stage(dynamic,{...dynamic.materialization,...change});
      assert.throws(()=>store.publishCandidateGeneration(failed,{frameworkStaged:true}),/incomplete/i);
      assert.equal(store.getActiveGenerationId(repository.id),active);assert.ok(store.loadFramework(repository.id));
    }
    const relation=good.materialization.relationships[0]!;
    const other=good.ctx.graph.nodes.find((n)=>n.type==="method"&&n.name==="two")!;
    assert.throws(()=>stage(good,{...good.materialization,relationships:[relation,{...relation,source:{kind:"language",nodeId:other.id}}]}),/one handler|invalid framework/i);
    assert.throws(()=>stage(good,{...good.materialization,relationships:[{...relation,source:relation.target,target:relation.source}]}),/invalid framework/i);
    assert.throws(()=>stage(good,{...good.materialization,relationships:[{...relation,source:{kind:"language",nodeId:good.ctx.graph.nodes.find((n)=>n.type==="class")!.id}}]}),/callable|invalid framework/i);
    assert.equal(store.getActiveGenerationId(repository.id),active);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test("scheduled Atlas load rejects corrupt payloads including wrong direction and keeps stored active pointer",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"code-atlas-phase17c-c-corrupt-"));
  const store=new AtlasStore(path.join(root,"atlas.db"));
  try{
    const r=sourceCase("typescript",nest('class Jobs { @Interval(100) run() {} }'));
    const repository=store.ensureRepository(getRepositoryIdentity(root));
    const gen=createCandidateGeneration(repository.id,undefined,CURRENT_INDEX_VERSION_DOMAINS,[]);
    store.beginCandidateGeneration(gen);store.writeCandidateManifest(gen.manifest);store.writeCandidateGraph(gen.id,r.ctx.graph,new Map());store.writeCandidateFramework(gen.id,r.materialization);store.publishCandidateGeneration(gen.id,{frameworkStaged:true});
    const db=new DatabaseSync(path.join(root,"atlas.db"));
    try{
      const row=db.prepare("SELECT entity_key,payload_json FROM generation_framework_entities WHERE generation_id=?").get(gen.id) as {entity_key:string;payload_json:string};
      const original=JSON.parse(row.payload_json);
      const identity=JSON.parse(original.ref.logicalKey) as unknown[];
      const invalidKeys=[
        identity.map((v,i)=>i===2?"fixed_rate":v),
        identity.map((v,i)=>i===1?["/src/a.ts","Jobs","run"]:v),
        identity.map((v,i)=>i===3?{kind:"duration",value:-1,unit:"milliseconds"}:v),
        identity.map((v,i)=>i===3?{kind:"duration",value:100,unit:"seconds"}:v),
        identity.map((v,i)=>i===5?{timeZone:"UTC",utcOffset:null,initialDelay:null}:v),
      ];
      for(const corrupt of [
        {...original,scheduledMetadata:{disabled:"true",waitForCompletion:false}},
        ...invalidKeys.map((key)=>({...original,ref:{...original.ref,logicalKey:JSON.stringify(key)}})),
      ]){
        db.prepare("UPDATE generation_framework_entities SET payload_json=? WHERE generation_id=? AND entity_key=?").run(JSON.stringify(corrupt),gen.id,row.entity_key);
        assert.equal(store.loadFramework(repository.id),undefined);assert.equal(store.getActiveGenerationId(repository.id),gen.id);
      }
      db.prepare("UPDATE generation_framework_entities SET payload_json=? WHERE generation_id=? AND entity_key=?").run(row.payload_json,gen.id,row.entity_key);
      const rel=db.prepare("SELECT rowid,payload_json FROM generation_framework_relationships WHERE generation_id=?").get(gen.id) as {rowid:number;payload_json:string};
      const value=JSON.parse(rel.payload_json);
      db.prepare("UPDATE generation_framework_relationships SET payload_json=? WHERE rowid=?").run(JSON.stringify({...value,source:value.target,target:value.source}),rel.rowid);
      assert.equal(store.loadFramework(repository.id),undefined);
      db.prepare("UPDATE generation_framework_relationships SET payload_json=? WHERE rowid=?").run(rel.payload_json,rel.rowid);
      db.prepare("UPDATE generation_symbols SET type='class' WHERE generation_id=? AND id=?").run(gen.id,value.source.nodeId);
      assert.equal(store.loadFramework(repository.id),undefined);
      db.prepare("UPDATE generation_symbols SET type='method' WHERE generation_id=? AND id=?").run(gen.id,value.source.nodeId);
      assert.ok(store.loadFramework(repository.id));
    }finally{db.close();}
    const previous={...r.materialization,repositoryId:repository.id,generationId:gen.id,frameworkResolutionVersion:"1.4.0"};
    const plan=planFrameworkInvalidation({paths:[],allPaths:[...r.ctx.analyzePaths],changedInputKeys:new Set(),changedLookupKeys:new Set(),previous,frameworkResolutionVersion:FRAMEWORK_RESOLUTION_VERSION,topologyComplete:true});
    assert.equal(plan.widened,true);assert.deepEqual(plan.analyzePaths,[...r.ctx.analyzePaths]);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
