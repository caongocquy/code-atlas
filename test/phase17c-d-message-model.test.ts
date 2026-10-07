import assert from "node:assert/strict";
import test from "node:test";
import { collectMessageConsumerEvidence, decodeMessageIdentity, isMessageMetadata, isPublishableMessageDiagnostic } from "../src/core/framework/framework-message.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import { frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { springAdapter } from "../src/core/framework/adapters/spring.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import type { FrameworkAnalysisContext, FrameworkSemanticAdapter } from "../src/core/framework/framework.types.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";

function analyze(language: "typescript" | "java", source: string) {
  const relativePath = language === "java" ? "src/Consumer.java" : "src/consumer.ts";
  const parsed = extractParsedFacts({ source, filePath: relativePath, language, contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") throw new Error("fixture extraction failed");
  const facts = parsed.facts;
  const graph: CodeGraph = { nodes: facts.symbols.filter((s) => s.kind === "class" || s.kind === "method").map((s): GraphNode => ({
    id: `graph:${s.localId}`, type: s.kind as "class" | "method", name: s.name, qualifiedName: s.declaredQualifiedName ?? s.name, file: relativePath,
    startLine: s.range.startLine, endLine: s.range.endLine,
  })), edges: [] };
  const adapter: FrameworkSemanticAdapter = language === "typescript" ? nestjsAdapter : springAdapter;
  const base = { repositoryId: "repo", facts: [{ relativePath, facts }], graph, config: [] };
  const ctx: FrameworkAnalysisContext = { ...base, generationId: "gen", frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION,
    detections: adapter.detect(base), analyzePaths: new Set([relativePath]), maxObservations: 100 };
  const evidence = collectMessageConsumerEvidence(ctx, language === "typescript" ? "nestjs" : "spring");
  return { evidence, ctx };
}

test("Nest message and event patterns require exact imports and keep distinct identities", () => {
  const r = analyze("typescript", 'import { Controller } from "@nestjs/common"; import { MessagePattern, EventPattern } from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern("orders.created") receive(payload: unknown) {} @EventPattern("orders.created") observe(payload: unknown) {} }');
  const accepted = r.evidence.filter((item) => item.entities.length === 1);
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted.map((item) => item.entities[0]?.ref.kind), ["message_consumer", "message_consumer"]);
  assert.notEqual(accepted[0]?.entities[0]?.ref.logicalKey, accepted[1]?.entities[0]?.ref.logicalKey);
  assert.deepEqual(accepted.map((item) => item.relationKind), ["message_handler", "message_handler"]);
  const sameMethodMessage = analyze("typescript", 'import { Controller } from "@nestjs/common"; import { MessagePattern } from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern("orders") run() {} }').evidence.find((item) => item.entities.length === 1)!;
  const sameMethodEvent = analyze("typescript", 'import { Controller } from "@nestjs/common"; import { EventPattern } from "@nestjs/microservices"; @Controller() class Jobs { @EventPattern("orders") run() {} }').evidence.find((item) => item.entities.length === 1)!;
  assert.equal(decodeMessageIdentity("nestjs", sameMethodMessage.entities[0]!.ref.logicalKey)?.[1][2], decodeMessageIdentity("nestjs", sameMethodEvent.entities[0]!.ref.logicalKey)?.[1][2]);
  assert.notEqual(frameworkEntityKey(sameMethodMessage.entities[0]!.ref), frameworkEntityKey(sameMethodEvent.entities[0]!.ref));
  assert.equal(analyze("typescript", 'import { Controller } from "@nestjs/common"; import { MessagePattern } from "wrong"; @Controller() class Jobs { @MessagePattern("orders") receive() {} }').evidence.filter((item) => item.entities.length).length, 0);
  assert.equal(analyze("typescript", 'import { Controller } from "@nestjs/common"; import { MessagePattern } from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern({topic:"orders"}) receive() {} }').evidence.filter((item) => item.entities.length).length, 0);
});

test("Spring accepts only proven scalar destinations and keeps Kafka identity options separate from tuning metadata", () => {
  const r = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="orders", groupId="workers", id="listener", concurrency="3", containerFactory="factory") void receive(String payload) {} }');
  const accepted = r.evidence.find((item) => item.entities.length === 1);
  assert.ok(accepted);
  const ref = accepted.entities[0]!.ref;
  const identity = decodeMessageIdentity(ref.framework, ref.logicalKey);
  assert.ok(identity);
  assert.deepEqual(identity.slice(2), ["kafka", "event", "topic", "orders", { id: "listener", groupId: "workers" }]);
  assert.equal(accepted.entities[0]?.messageMetadata?.groupSource, "explicit");
  assert.equal(decodeMessageIdentity(ref.framework, ref.logicalKey.replace('"workers"', '"other"'))?.[5], "orders");
  assert.equal(analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics={"a", "b"}) void receive() {} }').evidence.filter((item) => item.entities.length).length, 0);
  assert.equal(analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="${topic}") void receive() {} }').evidence.filter((item) => item.entities.length).length, 0);
  const unknown = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="orders", condition="true") void receive() {} }');
  assert.equal(unknown.evidence.length, 1);
  assert.equal(unknown.evidence[0]?.state, "unknown");
  const mixedUnknown = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topicPattern="orders.*", mystery="x") void receive() {} }');
  assert.equal(mixedUnknown.evidence[0]?.state, "unknown");
  const mixedRabbitUnknown = analyze("java", 'import org.springframework.amqp.rabbit.annotation.RabbitListener; class Jobs { @RabbitListener(bindings=@QueueBinding(value=@Queue("orders")), mystery="x") void receive() {} }');
  assert.equal(mixedRabbitUnknown.evidence[0]?.state, "unknown");
});

test("Rabbit queue semantics differ from Kafka and wrong imports never produce consumers", () => {
  const r = analyze("java", 'import org.springframework.amqp.rabbit.annotation.RabbitListener; class Jobs { @RabbitListener(queues="orders") void receive(String payload) {} }');
  const accepted = r.evidence.find((item) => item.entities.length === 1)!;
  const identity = decodeMessageIdentity("spring", accepted.entities[0]!.ref.logicalKey);
  assert.deepEqual(identity?.slice(2), ["rabbit", "event", "queue", "orders", { id: null, groupId: null }]);
  assert.equal(analyze("java", 'import other.RabbitListener; class Jobs { @RabbitListener(queues="orders") void receive() {} }').evidence.filter((item) => item.entities.length).length, 0);
});

test("canonical message identity rejects malformed and noncanonical payloads", () => {
  const valid = JSON.stringify(["root", ["src/consumer.ts", "Jobs", "receive"], "unspecified", "request_response", "pattern", "orders", { id: null, groupId: null }]);
  assert.ok(decodeMessageIdentity("nestjs", valid));
  for (const key of [valid.replace('"root"', '"../root"'), valid.replace('"receive"', '"receive",1'), valid.replace('"unspecified"', '"kafka"'), valid.replace('"id":null', '"id":""'), valid.replace('"id":null', '"extra":null,"id":null')]) {
    assert.equal(decodeMessageIdentity("nestjs", key), undefined);
  }
});

test("identity follows callable semantics across line shifts, methods, pattern kinds, and metadata-only tuning", () => {
  const source = 'import { Controller } from "@nestjs/common"; import { MessagePattern as MP, EventPattern as EP } from "@nestjs/microservices"; @Controller() class Jobs { @MP("orders") receive(payload: unknown) {} @MP("orders") other(payload: unknown) {} @EP("orders") event(payload: unknown) {} }';
  const first = analyze("typescript", source).evidence.filter((item) => item.entities.length === 1);
  const shifted = analyze("typescript", `\n\n${source}`).evidence.filter((item) => item.entities.length === 1);
  assert.deepEqual(first.map((item) => item.entities[0]!.ref.logicalKey), shifted.map((item) => item.entities[0]!.ref.logicalKey));
  assert.equal(new Set(first.map((item) => frameworkEntityKey(item.entities[0]!.ref))).size, 3);
  const a = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="orders", id="listener", concurrency="2", containerFactory="fast") void receive(String payload) {} }').evidence.find((item) => item.entities.length === 1)!;
  const b = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="orders", id="listener", concurrency="8", containerFactory="safe") void receive(String payload) {} }').evidence.find((item) => item.entities.length === 1)!;
  assert.equal(frameworkEntityKey(a.entities[0]!.ref), frameworkEntityKey(b.entities[0]!.ref));
  assert.notDeepEqual(a.entities[0]?.messageMetadata, b.entities[0]?.messageMetadata);
});

test("Kafka group identity applies explicit override, id default, and idIsGroup false", () => {
  const parse = (attrs: string) => {
    const item = analyze("java", `import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="orders", ${attrs}) void receive() {} }`).evidence.find((value) => value.entities.length === 1)!;
    return { identity: decodeMessageIdentity("spring", item.entities[0]!.ref.logicalKey), metadata: item.entities[0]!.messageMetadata };
  };
  const byId = parse('id="worker"');
  assert.equal(byId.identity?.[6].groupId, "worker"); assert.equal(byId.metadata?.groupSource, "id");
  const explicit = parse('id="worker", groupId="group", idIsGroup=false');
  assert.equal(explicit.identity?.[6].groupId, "group"); assert.equal(explicit.metadata?.groupSource, "explicit");
  const disabled = parse('id="worker", idIsGroup=false');
  assert.equal(disabled.identity?.[6].groupId, null); assert.equal(disabled.metadata?.groupSource, "default");
  assert.notEqual(frameworkEntityKey({ framework: "spring", kind: "message_consumer", logicalKey: JSON.stringify(byId.identity) }), frameworkEntityKey({ framework: "spring", kind: "message_consumer", logicalKey: JSON.stringify(disabled.identity) }));
  const equalById = parse('id="worker"');
  const equalExplicit = parse('id="worker", groupId="worker"');
  assert.equal(frameworkEntityKey({ framework: "spring", kind: "message_consumer", logicalKey: JSON.stringify(equalById.identity) }), frameworkEntityKey({ framework: "spring", kind: "message_consumer", logicalKey: JSON.stringify(equalExplicit.identity) }));
  assert.notEqual(equalById.metadata?.groupSource, equalExplicit.metadata?.groupSource);
});

test("message identity rejects string escapes whose runtime value is not proven by facts", () => {
  const nestCases = [String.raw`'\u0061'`, String.raw`'\x61'`, String.raw`"\x61"`];
  for (const literal of nestCases) {
    const result = analyze("typescript", `import { Controller } from "@nestjs/common"; import { MessagePattern } from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern(${literal}) run() {} }`);
    assert.equal(result.evidence.some((item) => item.entities.length), false, literal);
  }
  const decodedNest = analyze("typescript", String.raw`import { Controller } from "@nestjs/common"; import { MessagePattern } from "@nestjs/microservices"; @Controller() class Jobs { @MessagePattern("\u0061") run() {} }`);
  const decodedNestIdentity = decodedNest.evidence.find((item) => item.entities.length === 1)?.entities[0]?.ref.logicalKey;
  assert.equal(decodeMessageIdentity("nestjs", decodedNestIdentity)?.[5], "a");
  for (const value of [String.raw`"\141"`, String.raw`"\u0061"`, String.raw`"\x61"`]) {
    const result = analyze("java", `import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics=${value}) void run() {} }`);
    assert.equal(result.evidence.some((item) => item.entities.length), false, value);
  }
});

test("unsupported exact forms produce no entries; unknown options and invalid owners remain blocking", () => {
  const nest = (annotation: string, owner = "@Controller() class Jobs") => analyze("typescript", `import { Controller } from "@nestjs/common"; import { MessagePattern, EventPattern } from "@nestjs/microservices"; ${owner} { ${annotation} run(payload: unknown) {} }`);
  for (const pattern of ['@MessagePattern(1)', '@MessagePattern({topic:"x"})', '@MessagePattern(topic)', '@MessagePattern("x", {transport:"TCP"})', '@MessagePattern("x") @EventPattern("x")']) {
    const result = nest(pattern);
    assert.equal(result.evidence.filter((item) => item.entities.length).length, 0, pattern);
    assert.ok(result.evidence.every((item) => item.state === "unsupported" || item.state === "unknown"), pattern);
  }
  assert.equal(nest('@MessagePattern("x")', "class Jobs").evidence.some((item) => item.entities.length), false);
  const badController = analyze("typescript", 'import { Controller as C } from "wrong"; import { MessagePattern } from "@nestjs/microservices"; @C() class Jobs { @MessagePattern("x") run() {} }');
  assert.equal(badController.evidence.some((item) => item.entities.length), false);
  for (const topics of ['{"a", "b"}', '{"a" + "b"}', '"${topic}"', '"#{topic}"']) {
    const result = analyze("java", `import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics=${topics}) void run() {} }`);
    assert.equal(result.evidence.some((item) => item.entities.length), false, topics);
  }
  for (const extras of ['topicPattern="orders.*"', 'condition="true"', 'mystery="value"']) {
    const result = analyze("java", `import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="orders", ${extras}) void run() {} }`);
    assert.equal(result.evidence.some((item) => item.entities.length), false, extras);
    if (extras.startsWith("mystery")) assert.equal(result.evidence[0]?.state, "unknown");
  }
  for (const queues of ['{"a", "b"}', 'queuesToDeclare={@Queue("a")}', 'bindings={@QueueBinding}', '"#{queue}"']) {
    const result = analyze("java", `import org.springframework.amqp.rabbit.annotation.RabbitListener; class Jobs { @RabbitListener(queues=${queues}) void run() {} }`);
    assert.equal(result.evidence.some((item) => item.entities.length), false, queues);
  }
  const realRabbitBindings = analyze("java", 'import org.springframework.amqp.rabbit.annotation.RabbitListener; class Jobs { @RabbitListener(bindings=@QueueBinding(value=@Queue("orders"))) void run() {} }');
  assert.equal(realRabbitBindings.evidence.some((item) => item.entities.length), false);
  const kotlin = extractParsedFacts({ source: 'import org.springframework.kafka.annotation.KafkaListener\nclass Jobs { @KafkaListener(topics=["a", "b"]) fun run() {} }', filePath: "src/Jobs.kt", language: "kotlin", contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
  assert.equal(kotlin.kind, "facts");
  if (kotlin.kind === "facts") {
    const graph: CodeGraph = { nodes: [], edges: [] };
    const adapter = springAdapter;
    const base = { repositoryId: "repo", facts: [{ relativePath: "src/Jobs.kt", facts: kotlin.facts }], graph, config: [] };
    const ctx: FrameworkAnalysisContext = { ...base, generationId: "gen", frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION, detections: adapter.detect(base), analyzePaths: new Set(["src/Jobs.kt"]), maxObservations: 100 };
    assert.equal(collectMessageConsumerEvidence(ctx, "spring").some((item) => item.entities.length), false);
  }
});

test("duplicate declarations cannot resolve a unique handler", () => {
  const result = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; class Jobs { @KafkaListener(topics="x") @KafkaListener(topics="x") void run() {} }');
  const materialized = resolveFrameworkEvidence(result.ctx, result.evidence);
  assert.equal(materialized.relationships.filter((item) => item.relationKind === "message_handler").length, 0);
  assert.ok(materialized.diagnostics.some((item) => item.outcome === "ambiguous"));
});

test("unused granular capabilities stay complete, while handler payload types do not become DI evidence", () => {
  const emptyNest = analyze("typescript", 'import { Controller } from "@nestjs/common"; import { MessagePattern, EventPattern } from "@nestjs/microservices"; @Controller() class Jobs { ordinary(payload: unknown) {} }');
  assert.equal(resolveFrameworkEvidence(emptyNest.ctx, emptyNest.evidence).complete, true);
  assert.equal(nestjsAdapter.detect(emptyNest.ctx).some((item) => item.capabilities.includes("nestjs.injection")), false);
  const spring = analyze("java", 'import org.springframework.kafka.annotation.KafkaListener; import org.springframework.amqp.rabbit.annotation.RabbitListener; class Jobs { @KafkaListener(topics="orders") void receive(String payload) {} }');
  const materialized = resolveFrameworkEvidence(spring.ctx, spring.evidence);
  assert.equal(materialized.entities.length, 1);
  assert.equal(materialized.complete, true);
  assert.equal(springAdapter.detect(spring.ctx).some((item) => item.capabilities.includes("spring.injection")), false);
});

test("message policy validators reject malformed metadata and reason-capability pairs", () => {
  assert.equal(isMessageMetadata({ groupSource: "id", concurrency: "2", containerFactory: null }), true);
  assert.equal(isMessageMetadata({ groupSource: "id", concurrency: "${workers}", containerFactory: null }), false);
  assert.equal(isMessageMetadata({ groupSource: "unknown", concurrency: null, containerFactory: null }), false);
  const base = { code: "framework_message_unsupported" as const, outcome: "unsupported" as const, framework: "nestjs" as const, capability: "nestjs.event_pattern", relativePath: "src/a.ts", strategy: "messaging.unsupported_topics", evidenceIds: ["e"], refs: [], reason: "unsupported_topics" };
  assert.equal(isPublishableMessageDiagnostic(base), false);
  assert.equal(isPublishableMessageDiagnostic({ ...base, reason: "dynamic_pattern", strategy: "messaging.dynamic_pattern" }), true);
});
