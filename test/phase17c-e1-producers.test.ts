import assert from "node:assert/strict";
import test from "node:test";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION } from "../src/core/repository/index-version.js";
import type { MaterializedFileFacts } from "../src/core/facts/facts.types.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";
import { detectMessageProducers } from "../src/core/graph/intelligence/message-producer-evidence.js";

function fixture(language: "typescript" | "java", source: string) {
  const file = language === "typescript" ? "src/producer.ts" : "src/Producer.java";
  const extracted = extractParsedFacts({ source, filePath: file, language, contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw new Error("fixture extraction failed");
  const facts: MaterializedFileFacts[] = [{ relativePath: file, facts: extracted.facts }];
  const nodes: GraphNode[] = extracted.facts.symbols.map((symbol) => ({
    id: `graph:${symbol.localId}`, type: symbol.kind === "method" ? "method" : symbol.kind === "class" ? "class" : "variable",
    name: symbol.name, qualifiedName: symbol.declaredQualifiedName, file,
    startLine: symbol.range.startLine, endLine: symbol.range.endLine,
  }));
  const graph: CodeGraph = { nodes, edges: [] };
  return detectMessageProducers(facts, graph, "generation-1");
}

test("Nest method parameters prove imported ClientProxy send and emit calls independently", () => {
  const result = fixture("typescript", 'import { ClientProxy as Proxy } from "@nestjs/microservices"; class Jobs { publish(client: Proxy) { client.send("orders", payload); client.emit("orders", payload); } }');
  assert.deepEqual(result.producers.map((item) => [item.apiKind, item.producerKind, item.destination.value]), [
    ["client_proxy_send", "request", "orders"],
    ["client_proxy_emit", "event", "orders"],
  ]);
  assert.ok(result.producers.every((item) => item.receiverProof === "exact" && item.wholeArgumentProof === "exact"));
  assert.ok(result.producers.every((item) => item.callRef.generationId === "generation-1"));
  assert.equal(new Set(result.producers.map((item) => item.callRef.callId)).size, 2);
});

test("Repeated supported calls preserve call-site multiplicity and deterministic order", () => {
  const source = 'import { ClientProxy } from "@nestjs/microservices"; class Jobs { publish(client: ClientProxy) { client.send("orders", first); client.send("orders", second); } }';
  const first = fixture("typescript", source);
  const repeated = fixture("typescript", source);
  assert.equal(first.producers.length, 2);
  assert.equal(new Set(first.producers.map((item) => item.callRef.callId)).size, 2);
  assert.deepEqual(first, repeated);
});

test("Nest rejects wrong imports, untyped and shadowed receivers", () => {
  const wrongImport = fixture("typescript", 'import { ClientProxy } from "wrong"; class Jobs { publish(client: ClientProxy) { client.send("orders", payload); } }');
  assert.equal(wrongImport.producers.length, 0);
  const untyped = fixture("typescript", 'class Jobs { publish(client: any) { client.send("orders", payload); } }');
  assert.equal(untyped.producers.length, 0);
  const shadowed = fixture("typescript", 'import { ClientProxy } from "@nestjs/microservices"; class Jobs { publish(client: ClientProxy) { { const client = other; client.send("orders", payload); } } }');
  assert.equal(shadowed.producers.length, 0);
});

test("Nest only accepts a whole literal destination argument", () => {
  const result = fixture("typescript", 'import { ClientProxy } from "@nestjs/microservices"; class Jobs { publish(client: ClientProxy) { client.send("orders" + suffix, payload); client.send(prefix + "orders", payload); client.send(("orders"), payload); client.send(-"orders", payload); client.send(`orders`, payload); client.send(topic, payload); client.send("orders", payload); } }');
  assert.deepEqual(result.producers.map((item) => item.destination.value), ["orders"]);
});

test("Nest does not promote constructor, field, deep receiver, or conflicting type declarations", () => {
  const constructor = fixture("typescript", 'import { ClientProxy } from "@nestjs/microservices"; class Jobs { constructor(client: ClientProxy) { client.send("orders", payload); } }');
  assert.equal(constructor.producers.length, 0);
  const field = fixture("typescript", 'import { ClientProxy } from "@nestjs/microservices"; class Jobs { client!: ClientProxy; publish() { this.client.send("orders", payload); } }');
  assert.equal(field.producers.length, 0);
  const deep = fixture("typescript", 'import { ClientProxy } from "@nestjs/microservices"; class Jobs { publish(client: ClientProxy) { wrapper.client.send("orders", payload); } }');
  assert.equal(deep.producers.length, 0);
  const conflictingType = fixture("typescript", 'import { ClientProxy } from "@nestjs/microservices"; type ClientProxy = unknown; class Jobs { publish(client: ClientProxy) { client.send("orders", payload); } }');
  assert.equal(conflictingType.producers.length, 0);
});

test("Java typed KafkaTemplate field and parameter accept only a two argument literal-topic send", () => {
  const result = fixture("java", 'import org.springframework.kafka.core.KafkaTemplate; class Jobs { KafkaTemplate<String,Object> template; void publish(KafkaTemplate<String,Object> client) { template.send("orders", payload); client.send("users", payload); template.send("orders", payload, callback); template.send("orders" + suffix, payload); } }');
  assert.deepEqual(result.producers.map((item) => item.destination), [
    { protocolKind: "kafka", destinationKind: "topic", value: "orders" },
    { protocolKind: "kafka", destinationKind: "topic", value: "users" },
  ]);
  assert.ok(result.producers.every((item) => item.apiKind === "kafka_template_send" && item.producerKind === "event"));
});

test("Java fully qualified KafkaTemplate origin is enough without an import", () => {
  const result = fixture("java", 'class Jobs { org.springframework.kafka.core.KafkaTemplate<String,Object> template; void publish() { template.send("orders",payload); } }');
  assert.equal(result.producers.length, 1);
  assert.equal(result.producers[0]?.provenance.importId, undefined);
});

test("Java this.field receiver remains an exact simple field receiver", () => {
  const result = fixture("java", 'import org.springframework.kafka.core.KafkaTemplate; class Jobs { KafkaTemplate<String,Object> template; void publish() { this.template.send("orders",payload); } }');
  assert.equal(result.producers.length, 1);
});

test("Java rejects wrong KafkaTemplate import and ambiguous receiver bindings", () => {
  const wrongImport = fixture("java", 'import wrong.KafkaTemplate; class Jobs { KafkaTemplate<String,Object> template; void publish() { template.send("orders", payload); } }');
  assert.equal(wrongImport.producers.length, 0);
  const ambiguous = fixture("java", 'import org.springframework.kafka.core.KafkaTemplate; class Jobs { KafkaTemplate<String,Object> template; void publish() { Object template = other; template.send("orders", payload); } }');
  assert.equal(ambiguous.producers.length, 0);
});

test("Java rejects compound, parenthesized, escaped, dynamic, unary, and non-string topic arguments", () => {
  const result = fixture("java", 'import org.springframework.kafka.core.KafkaTemplate; class Jobs { KafkaTemplate<String,Object> template; void publish() { template.send("a" + suffix, payload); template.send(prefix + "b", payload); template.send(("c"), payload); template.send(-"d", payload); template.send("\\u0061", payload); template.send(topic, payload); template.send(makeTopic(), payload); template.send(new String("e"), payload); template.send("ok", payload); } }');
  assert.deepEqual(result.producers.map((item) => item.destination.value), ["ok"]);
});

test("Java rejects constructor calls and deep receiver chains", () => {
  const constructor = fixture("java", 'import org.springframework.kafka.core.KafkaTemplate; class Jobs { Jobs(KafkaTemplate<String,Object> template) { template.send("orders", payload); } }');
  assert.equal(constructor.producers.length, 0);
  const deep = fixture("java", 'import org.springframework.kafka.core.KafkaTemplate; class Jobs { KafkaTemplate<String,Object> template; void publish() { holder.template.send("orders", payload); } }');
  assert.equal(deep.producers.length, 0);
});
