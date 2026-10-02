import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { loadIndexedMessageGraphReadOnly, loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { buildMessageLinks, messageCompatibility } from "../src/core/graph/intelligence/message-links.service.js";
import { buildRepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";

const source = (kind: "send" | "emit" | "kafka") => kind === "kafka" ? `
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.annotation.KafkaListener;
class Work { void work() {} }
class Jobs {
 private KafkaTemplate<String,String> template;
 private Work service;
 void produce(String payload) { template.send("same-topic", payload); template.send("same-topic", payload); }
 @KafkaListener(topics="same-topic", groupId="one") void consume(String p) { service.work(); }
 @KafkaListener(topics="same-topic", groupId="two") void consumeTwo(String p) { service.work(); }
 @KafkaListener(topics="different") void other(String p) {}
}` : `
import { Controller } from "@nestjs/common";
import { ClientProxy, MessagePattern, EventPattern } from "@nestjs/microservices";
class Work { work() {} }
const service: Work = new Work();
@Controller() class Jobs {
 produce(client: ClientProxy, payload: string) { client.${kind}("same-topic", payload); client.${kind}("same-topic", payload); }
 @${kind === "send" ? "MessagePattern" : "EventPattern"}("same-topic") consume(p: string) { service.work(); }
 @${kind === "send" ? "EventPattern" : "MessagePattern"}("same-topic") wrong(p: string) {}
 @${kind === "send" ? "MessagePattern" : "EventPattern"}("different") other(p: string) {}
}`;

async function fixture(kind: "send" | "emit" | "kafka") {
 const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-e1-links-"));
 await mkdir(path.join(root,"src"));
 const file=path.join(root,"src",kind === "kafka" ? "Jobs.java" : "jobs.ts");
 await writeFile(file, source(kind));
 const result=await indexRepository(root,{skipGit:true, scipIndexer: {discover: async () => ({status:"unavailable" as const}),index: async () => []}});
 assert.equal(result.kind,"published",JSON.stringify(result));
 const server=createMcpServer(), client=new Client({name:"e1-proof",version:"1.0.0"});
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(ct),server.connect(st)]);
 return {root,file,client,server,close:async()=>{await client.close();await server.close();await rm(root,{recursive:true,force:true});}};
}

test("message_links actual tools/list exposes exactly one static read-only tool",async()=>{
 const server=createMcpServer(),client=new Client({name:"e1-metadata",version:"1"});
 const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(ct),server.connect(st)]);
 try {
 const tools=(await client.listTools()).tools;const tool=tools.find(t=>t.name==="message_links");assert.ok(tool);
 assert.match(tool.description ?? "",/static compatibility/i);
 assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
 assert.equal(tools.some(t=>["protocol_links","producer_entries","producer_flow"].includes(t.name)),false);
 assert.equal(tool.inputSchema.properties?.direction,undefined);
 } finally {await client.close();await server.close();}
});

for(const kind of ["send","emit","kafka"] as const) test(`message_links real ${kind}: persisted receiver proof, composition, same consumer ID and downstream flow`,async()=>{
 const f=await fixture(kind);
 try {
 const loaded=await loadIndexedGraphReadOnly(f.root);const catalog=buildRepositoryEntryCatalog(loaded.framework);
 const pinned=await loadIndexedMessageGraphReadOnly(f.root);assert.equal(pinned.generationManifest?.versions.scipStatus,"unavailable");
 const before=await readFile(path.join(f.root,".codeatlas","atlas.db"));
 const call=async(args:Record<string,unknown>={})=>{
 const response=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,detail:"full",...args}});
 assert.equal(response.isError,undefined,JSON.stringify(response));return response.structuredContent as any;
 };
 const result=await call();assert.equal(result.producerCalls.length,2);assert.equal(result.producerCount.total,2);
 for (const e of catalog.entries) if (e.kind === "message_consumer") {
 const expected = e.destination === "same-topic" && (kind === "kafka" || e.consumerKind === (kind === "send" ? "request_response" : "event"));
 assert.equal(messageCompatibility(result.producerCalls[0],e), expected ? "compatible" : "incompatible");
 }
 const n=kind==="kafka"?2:1;assert.equal(result.linkCount.total,2*n);assert.equal(result.links.length,2*n);
 assert.deepEqual(result.evidenceState,loaded.evidenceState);assert.equal(result.scanComplete,true);
 assert.equal(result.producerCalls[0].receiverProof,"exact");assert.equal(result.producerCalls[0].wholeArgumentProof,"exact");
 assert.notDeepEqual(result.producerCalls[0].callRef,result.producerCalls[1].callRef);
 assert.equal(result.producerCalls[0].callRef.generationId,loaded.evidenceState.generationId);
 assert.equal(result.producerCalls[0].destination.value,"same-topic");
 for(const link of result.links) {
 assert.equal(link.compatibility,"compatible");assert.match(link.runtimeLimitation,/static|unverified/i);
 assert.ok(catalog.entries.some(e=>e.id===link.consumerId));
 const flow=await f.client.callTool({name:"execution_flow",arguments:{repoPath:f.root,entry:{kind:"message_consumer",id:link.consumerId},detail:"full"}});
 const payload=flow.structuredContent as any;assert.equal(payload.status,"resolved");
 assert.ok(payload.edges.some((e:any)=>e.kind==="framework_entry"&&e.relation==="message_handler"));
 assert.ok(payload.nodes.some((n:any)=>n.subject.kind==="language"&&n.subject.node?.name==="work"));
 }
 assert.deepEqual(await call(),result);assert.deepEqual(await readFile(path.join(f.root,".codeatlas","atlas.db")),before);
 const incoming=await call({consumerId:result.links[0].consumerId});assert.equal(incoming.producerCount.total,2);assert.equal(incoming.linkCount.total,2);
 const filtered=await call({destination:"different"});assert.equal(filtered.producerCount.total,0);
 const compact=await call({detail:"compact"});assert.equal(compact.producerCalls[0].provenance,undefined);
 const bounded=await call({limit:3});assert.ok(bounded.producerCalls.length+bounded.links.length+bounded.unlinkedProducerCalls.length+bounded.diagnostics.length<=3);
 assert.equal(bounded.linkCount.total,2*n);assert.equal(bounded.linkCount.omitted,2*n-bounded.links.length);
 const bad=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,producerSymbol:"produce",consumerId:result.links[0].consumerId}});assert.equal(bad.isError,true);
 const outgoing=await call({producerSymbol:"produce"});assert.equal(outgoing.producerCount.total,2);
 const ids=catalog.entries.map(e=>e.id);await writeFile(f.file,"\n\n"+source(kind));assert.equal((await syncRepository(f.root,{skipGit:true})).kind,"published");
 const moved=await call();assert.equal(moved.producerCount.total,2);assert.notEqual(moved.evidenceState.generationId,result.evidenceState.generationId);
 assert.deepEqual(buildRepositoryEntryCatalog((await loadIndexedGraphReadOnly(f.root)).framework).entries.map(e=>e.id),ids);
 }finally{await f.close();}
});

for(const kind of ["send","kafka"] as const) test(`message_links real ${kind} rejects arbitrary receiver and literal descendant`,async()=>{
 const f=await fixture(kind);
 try {
 const text=source(kind).replaceAll(kind==="kafka"?'template.send("same-topic", payload)':'client.send("same-topic", payload)',kind==="kafka"?'template.send("same-topic" + payload, payload)':'client.send("same-topic" + payload, payload)');
 const extra=kind==="kafka"?'void fake(Object arbitraryObject) { arbitraryObject.send("same-topic", "payload"); }':'fake(arbitraryObject: any) { arbitraryObject.send("same-topic", "payload"); }';
 await writeFile(f.file,text.replace(/}\s*$/,extra+"}"));assert.equal((await syncRepository(f.root,{skipGit:true})).kind,"published");
 const response=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,detail:"full"}});assert.equal(response.isError,undefined,JSON.stringify(response));
 const result=response.structuredContent as any;assert.equal(result.producerCount.total,0);assert.equal(result.linkCount.total,0);assert.equal(result.producerCalls.length,0);assert.equal(result.mayBeIncomplete,true);
 assert.ok(result.diagnostics.length>0);
 }finally{await f.close();}
});

test("message_links unlinked producer calls remain visible and selectors fail closed",async()=>{
 const f=await fixture("send");
 try {
 await writeFile(f.file,source("send").replace('@MessagePattern("same-topic")','@MessagePattern("other-topic")'));
 assert.equal((await syncRepository(f.root,{skipGit:true})).kind,"published");
 const response=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,detail:"full"}});
 const r=response.structuredContent as any;assert.equal(r.producerCount.total,2);assert.equal(r.linkCount.total,0);
 assert.equal(r.unlinkedProducerCount.total,2);assert.equal(r.unlinkedProducerCalls.length,2);assert.equal(r.producerCalls[0].cardinality,"none");
 for(const args of [{consumerId:"missing"},{producerSymbol:"Jobs"},{producerSymbol:"prod"},{protocolKind:"rabbit"},{direction:"outgoing"}]) {
 const bad=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,...args}});assert.equal(bad.isError,true,JSON.stringify(args));
 }
 }finally{await f.close();}
});

test("message_links missing index returns index_required without creating Atlas",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"code-atlas-e1-empty-"));
 const server=createMcpServer(),client=new Client({name:"e1-empty",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(ct),server.connect(st)]);
 try {const r=await client.callTool({name:"message_links",arguments:{repoPath:root}});assert.equal(r.isError,true);assert.match(JSON.stringify(r),/index_required/);await assert.rejects(readFile(path.join(root,".codeatlas","atlas.db")));}
 finally{await client.close();await server.close();await rm(root,{recursive:true,force:true});}
});

test("message_links missing fact coverage reports unknown repository totals and preserves global evidenceState",async()=>{
 const f=await fixture("send");
 try {
 const before=await loadIndexedGraphReadOnly(f.root);
 const db=new DatabaseSync(path.join(f.root,".codeatlas","atlas.db"));try {db.exec("UPDATE fact_blobs SET payload_json = '{'");}finally{db.close();}
 const global=await loadIndexedGraphReadOnly(f.root);assert.deepEqual(global.evidenceState,before.evidenceState);
 const response=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,detail:"full"}});
 assert.equal(response.isError,undefined,JSON.stringify(response));const r=response.structuredContent as any;
 assert.equal(r.scanComplete,false);assert.equal(r.producerCount.total,null);assert.equal(r.producerCount.omitted,null);
 assert.equal(r.linkCount.total,null);assert.equal(r.producerCount.knownInspected.total,0);assert.equal(r.mayBeIncomplete,true);
 assert.deepEqual(r.evidenceState,global.evidenceState);assert.ok(r.diagnostics.length>0);
 }finally{await f.close();}
});

test("message_links many-to-many counts remain exact under one small global output budget",async()=>{
 const f=await fixture("kafka");
 try {
 const loaded=await loadIndexedMessageGraphReadOnly(f.root);const framework=loaded.framework!;
 const template=framework.nodes.find((n:any)=>n.kind==="framework"&&n.entity.messageMetadata)! as any;
 const relation=framework.edges.find((e:any)=>e.kind==="framework"&&e.relationship.relationKind==="message_handler"&&e.relationship.target.entity.logicalKey===template.entity.ref.logicalKey)! as any;
 const language=framework.nodes.filter(n=>n.kind==="language");const nodes:any[]=[...language],edges:any[]=[];
 for(let i=0;i<1001;i++) {
 const tuple=JSON.parse(template.entity.ref.logicalKey);tuple[5]="same-topic";tuple[6]={...tuple[6],groupId:`group-${i}`};
 const ref={...template.entity.ref,logicalKey:JSON.stringify(tuple)};
 nodes.push({kind:"framework",entity:{...template.entity,ref}});
 edges.push({kind:"framework",relationship:{...relation.relationship,target:{kind:"framework",entity:ref}}});
 }
 const context={...loaded,framework:{...framework,nodes,edges}};
 const result=buildMessageLinks(context,{limit:5,detail:"full"});
 assert.equal(result.producerCount.total,2);assert.equal(result.linkCount.total,2002);assert.equal(result.links.length,4);
 assert.equal(result.producerCalls.length,1);assert.equal(result.producerCalls[0].cardinality,"many");
 assert.equal(result.linkCount.omitted,1998);assert.equal(result.producerCount.omitted,1);
 assert.ok(result.producerCalls.length+result.links.length+result.unlinkedProducerCalls.length+result.diagnostics.length<=5);
 assert.deepEqual(buildMessageLinks(context,{limit:5,detail:"full"}),result);
 }finally{await f.close();}
});

test("message_links real Kafka topic never composes with the same literal Rabbit queue",async()=>{
 const f=await fixture("kafka");
 try {
 const text=source("kafka").replace('import org.springframework.kafka.annotation.KafkaListener;','import org.springframework.kafka.annotation.KafkaListener; import org.springframework.amqp.rabbit.annotation.RabbitListener;')
 .replace(/}\s*$/,'@RabbitListener(queues="same-topic") void rabbitConsumer(String p) {} }');
 await writeFile(f.file,text);assert.equal((await syncRepository(f.root,{skipGit:true})).kind,"published");
 const loaded=await loadIndexedGraphReadOnly(f.root);const rabbit=buildRepositoryEntryCatalog(loaded.framework).entries.find(e=>e.kind==="message_consumer"&&e.protocolKind==="rabbit")!;
 assert.ok(rabbit);const response=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,detail:"full"}});
 const r=response.structuredContent as any;assert.equal(r.producerCount.total,2);assert.equal(r.linkCount.total,4);
 assert.ok(r.links.every((link:any)=>link.consumerId!==rabbit.id));
 if(rabbit.kind!=="message_consumer")throw new Error("Expected Rabbit consumer");
 assert.equal(messageCompatibility(r.producerCalls[0],rabbit),"incompatible");
 const incoming=await f.client.callTool({name:"message_links",arguments:{repoPath:f.root,consumerId:rabbit.id}});
 assert.equal((incoming.structuredContent as any).producerCount.total,0);
 }finally{await f.close();}
});
