import assert from "node:assert/strict";
import test from "node:test";
import { frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import type { FrameworkEntity, FrameworkRelationship } from "../src/core/framework/framework.types.js";
import type { FrameworkQueryProjection } from "../src/core/graph/query/framework-query.types.js";
import type { CodeGraph } from "../src/core/graph/types.js";
import { buildRepositoryEntryCatalog, filterRepositoryEntries } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { projectRepositoryEntryCatalogResponse } from "../src/adapters/mcp/mcp-server.js";
import { buildRepositoryMap } from "../src/core/graph/intelligence/repository-map.service.js";
import { defaultArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";

function fixture() {
  const graph: CodeGraph = { nodes: [
    {id:"one",type:"method",name:"one",qualifiedName:"Jobs.one",file:"src/jobs.ts"},
    {id:"two",type:"method",name:"two",qualifiedName:"Jobs.two",file:"src/jobs.ts"},
  ], edges:[{from:"one",to:"two",type:"calls"},{from:"two",to:"one",type:"calls"}] };
  const provenance = {origin:"framework_inferred" as const,framework:"nestjs" as const,capability:"nestjs.message_pattern",adapterId:"nestjs",adapterVersion:"1.4.0",strategy:"message.message_pattern",confidence:"exact" as const,evidenceIds:["declaration"],refs:[{relativePath:"src/jobs.ts",inputKey:"facts:src/jobs.ts",localId:"annotation"}]};
  const entities: FrameworkEntity[] = ["one","two"].map((method) => ({ref:{framework:"nestjs",kind:"message_consumer",logicalKey:JSON.stringify(["root",["src/jobs.ts","Jobs",method],"unspecified","request_response","pattern",method,{id:null,groupId:null}])},displayName:method,provenance,messageMetadata:{groupSource:null,concurrency:null,containerFactory:null}}));
  const relationships: FrameworkRelationship[] = entities.map((entity,i) => ({outputKind:"relationship",source:{kind:"language",nodeId:i===0?"one":"two"},target:{kind:"framework",entity:entity.ref},relationKind:"message_handler",provenance}));
  const projection: FrameworkQueryProjection = {nodes:[...graph.nodes.map(node=>({kind:"language" as const,node})),...entities.map(entity=>({kind:"framework" as const,entity}))],edges:relationships.map(relationship=>({kind:"framework" as const,relationship})),classifications:[],diagnostics:[],coverage:[],mayBeIncomplete:false};
  return { graph, projection, entities, relationships };
}

test("message catalog exact filters precede projection; semantic ordering and count are deterministic", () => {
  const {projection}=fixture();const catalog=buildRepositoryEntryCatalog(projection);
  assert.equal(catalog.entries.length,2);assert.equal(catalog.mayBeIncomplete,true);
  assert.deepEqual(buildRepositoryEntryCatalog({...projection,nodes:[...projection.nodes].reverse(),edges:[...projection.edges].reverse()}).entries,catalog.entries);
  for (const entry of catalog.entries) for (const key of ["path","method","operationKind","triggerKind","schedule"]) assert.equal(key in entry,false);
  assert.equal(filterRepositoryEntries(catalog.entries,{kind:"message_consumer",framework:"nestjs",protocolKind:"unspecified",consumerKind:"request_response",destinationKind:"pattern",destination:"two"}).length,1);
  for (const filters of [{path:"one"},{method:"GET"},{triggerKind:"cron" as const},{protocolKind:"kafka" as const},{consumerKind:"event" as const},{destinationKind:"topic" as const},{destination:"Two"}]) assert.equal(filterRepositoryEntries(catalog.entries,filters).length,0);
  const all=projectRepositoryEntryCatalogResponse(catalog,{kind:"message_consumer"},"full",1);
  assert.deepEqual((all.projection as {entries:unknown}).entries,{total:2,returned:1,omitted:1,truncated:true});
  const filtered=projectRepositoryEntryCatalogResponse(catalog,{destination:"two"},"full",1);
  assert.deepEqual((filtered.projection as {entries:unknown}).entries,{total:1,returned:1,omitted:0,truncated:false});
  assert.equal((filtered.entries as {destination:string}[])[0]?.destination,"two");
  assert.equal(buildRepositoryEntryCatalog({...projection,nodes:projection.nodes.filter(n=>n.kind==="language")}).entries.length,0);
});

test("message same-ID flow preserves calls, cycles, provenance and traversal limits", () => {
  const {graph,projection,relationships}=fixture();const id=buildRepositoryEntryCatalog(projection).entries[0]!.id;
  const flow=discoverExecutionFlow(graph,projection,{kind:"message_consumer",id});
  assert.equal(flow.status,"resolved");assert.equal(flow.cycles.length,1);assert.equal(flow.mayBeIncomplete,true);
  assert.ok(flow.edges.some(e=>e.kind==="call"));
  assert.deepEqual(flow.edges[0]?.kind==="framework_entry"&&flow.edges[0].provenance,relationships[0]!.provenance);
  assert.ok(flow.diagnostics.some(d=>d.code==="runtime_registration_unverified"));
  assert.equal(discoverExecutionFlow(graph,projection,{kind:"message_consumer",id},{maxNodes:1}).truncated,true);
  assert.equal(discoverExecutionFlow(graph,projection,{kind:"message_consumer",id},{maxDepth:0}).truncated,true);
  assert.equal(discoverExecutionFlow(graph,projection,{kind:"message_consumer",id:"malformed"}).status,"not_found");
  const missing=discoverExecutionFlow(graph,{...projection,edges:[]},{kind:"message_consumer",id});
  assert.ok(missing.diagnostics.some(d=>d.code==="message_binding_missing"));
  const ambiguous={...projection,edges:[...projection.edges,{kind:"framework" as const,relationship:{...relationships[0]!,source:{kind:"language" as const,nodeId:"two"}}}]};
  assert.equal(discoverExecutionFlow(graph,ambiguous,{kind:"message_consumer",id}).status,"ambiguous");
  assert.equal(buildRepositoryEntryCatalog(ambiguous).entries.length,1);
  const wrong={...projection,edges:[{kind:"framework" as const,relationship:{...relationships[0]!,relationKind:"scheduled_handler" as const}}]};
  assert.equal(buildRepositoryEntryCatalog(wrong).entries.length,0);
});

test("message malformed identities and noncallable projections create no public entry or call traversal", () => {
  const {graph,projection}=fixture();const id=buildRepositoryEntryCatalog(projection).entries[0]!.id;
  const invalid={...projection,nodes:projection.nodes.map(item=>item.kind==="framework"?{...item,entity:{...item.entity,ref:{...item.entity.ref,logicalKey:"[]"}}}:item)};
  const catalog=buildRepositoryEntryCatalog(invalid);assert.equal(catalog.entries.length,0);
  assert.ok(catalog.diagnostics.every(d=>d.code==="invalid_message_identity"));
  assert.equal(discoverExecutionFlow(graph,invalid,{kind:"message_consumer",id}).status,"not_found");
  const classes:CodeGraph={...graph,nodes:graph.nodes.map(node=>({...node,type:"class"}))};
  const noncallable={...projection,nodes:projection.nodes.map(item=>item.kind==="language"?{...item,node:{...item.node,type:"class" as const}}:item)};
  assert.equal(buildRepositoryEntryCatalog(noncallable).entries.length,0);
  const flow=discoverExecutionFlow(classes,noncallable,{kind:"message_consumer",id});
  assert.ok(flow.diagnostics.some(d=>d.code==="message_binding_missing"));assert.equal(flow.edges.length,0);
});

test("message facets leave route-only execution binding count and language coupling unchanged", () => {
  const {graph,projection,entities}=fixture();const map=buildRepositoryMap(graph,defaultArchitecturePolicy(),projection);
  const base=buildRepositoryMap(graph,defaultArchitecturePolicy());
  assert.ok(map.areas.every(a=>a.executionEntryBindingCount===0));assert.ok(map.areas.some(a=>a.frameworkIds.includes("nestjs")));
  assert.deepEqual(map.relations,base.relations);
  assert.notEqual(frameworkEntityKey(entities[0]!.ref),frameworkEntityKey(entities[1]!.ref));
});
