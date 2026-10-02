import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import type { FrameworkId, FrameworkMaterialization, FrameworkRelationship } from "../src/core/framework/framework.types.js";
import type { MessageIdentity, MessageMetadata, MessageProtocolKind, MessageConsumerKind, MessageDestinationKind } from "../src/core/framework/framework-message.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";

function fixture(options: {
  framework?: FrameworkId;
  protocol?: MessageProtocolKind;
  consumer?: MessageConsumerKind;
  destinationKind?: MessageDestinationKind;
  destination?: string;
  identityOptions?: MessageIdentity[6];
  metadata?: MessageMetadata;
  unsupported?: boolean;
  entityCapability?: string;
  relationCapability?: string;
  detections?: FrameworkMaterialization["detections"];
  callableName?: string;
  callableType?: string;
} = {}) {
  const framework = options.framework ?? "nestjs";
  const protocol = options.protocol ?? "unspecified";
  const consumer = options.consumer ?? "request_response";
  const destinationKind = options.destinationKind ?? "pattern";
  const destination = options.destination ?? "orders.created";
  const identityOptions = options.identityOptions ?? { id: null, groupId: null };
  const metadata = options.metadata ?? { groupSource: null, concurrency: null, containerFactory: null };
  const capability = framework === "nestjs" ? consumer === "event" ? "nestjs.event_pattern" : "nestjs.message_pattern"
    : protocol === "kafka" ? "spring.kafka_listener" : "spring.rabbit_listener";
  const strategy = options.unsupported ? "messaging.dynamic_pattern" : framework === "nestjs" ? "messaging.pattern" : `messaging.${protocol}`;
  const relativePath = "src/consumer.ts";
  const callableName = options.callableName ?? "run";
  const sourceId = `graph:method:Worker.${callableName}`;
  const identity: MessageIdentity = ["root", [relativePath, options.callableType ?? "Worker", callableName], protocol, consumer, destinationKind, destination, identityOptions];
  const ref = { framework, kind: "message_consumer" as const, logicalKey: JSON.stringify(identity) };
  const evidenceId = `message:${relativePath}:${options.unsupported ? "dynamic-annotation" : "annotation"}`;
  const evidenceRef = { relativePath, inputKey: `facts:${relativePath}`, localId: options.unsupported ? "dynamic-annotation" : "annotation", range: { startLine: 3, endLine: 3, startColumn: options.unsupported ? 41 : 2, endColumn: options.unsupported ? 80 : 40 } };
  const provenance = { origin: "framework_inferred" as const, framework, capability: options.entityCapability ?? capability, adapterId: framework, adapterVersion: "1.4.0", strategy: options.unsupported ? "messaging.pattern" : strategy, confidence: "exact" as const, evidenceIds: [evidenceId], refs: [evidenceRef] };
  const relationProvenance = { ...provenance, capability: options.relationCapability ?? capability };
  const entity = { ref, displayName: "Worker.run", messageMetadata: metadata, provenance };
  const relationship: FrameworkRelationship = { outputKind: "relationship", source: { kind: "language", nodeId: sourceId }, target: { kind: "framework", entity: ref }, relationKind: "message_handler", provenance: relationProvenance };
  const graph: CodeGraph = { nodes: [
    { id: "graph:class:Worker", type: "class", name: "Worker", qualifiedName: "Worker", file: relativePath } as GraphNode,
    { id: sourceId, type: "method", name: "run", qualifiedName: "Worker.run", file: relativePath, startLine: 3, endLine: 3 } as GraphNode,
  ], edges: [] };
  const detection = { framework, scope: "root", configured: true, observed: true, capabilities: [capability], refs: [{ relativePath, inputKey: `facts:${relativePath}` }], complete: true };
  const coverage = { framework, capability, relativePath, strategy: options.unsupported ? strategy : framework === "nestjs" ? "messaging.pattern" : `messaging.${protocol}`, outputKind: "relationship" as const, kind: "message_handler" as const,
    applicable: 1, supported: options.unsupported ? 0 : 1, attempted: 1, resolved: options.unsupported ? 0 : 1, ambiguous: 0, unknown: 0, unsupported: options.unsupported ? 1 : 0, budgetExhausted: 0, weakDropped: 0 };
  const materialization: FrameworkMaterialization = {
    frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION,
    entities: options.unsupported ? [] : [entity],
    relationships: options.unsupported ? [] : [relationship],
    classifications: [],
    diagnostics: options.unsupported ? [{ code: "framework_message_unsupported", outcome: "unsupported", framework, capability, relativePath, strategy, evidenceIds: [evidenceId], refs: [evidenceRef], reason: "dynamic_pattern" }] : [],
    coverage: [coverage], config: [], detections: options.detections ?? [detection], dependencies: [], complete: !options.unsupported,
  };
  return { graph, materialization, ref, relationship };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17c-d-storage-"));
  const store = new AtlasStore(path.join(root, "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(root));
  const stage = (graph: CodeGraph, materialization: FrameworkMaterialization) => {
    const generation = createCandidateGeneration(repository.id, store.getActiveGenerationId(repository.id), CURRENT_INDEX_VERSION_DOMAINS, []);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    store.writeCandidateGraph(generation.id, graph, new Map());
    store.writeCandidateFramework(generation.id, materialization);
    return generation.id;
  };
  return { root, store, repository, stage, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("message consumer Atlas write and load accept one callable handler", async () => {
  const env = await setup();
  try {
    const value = fixture();
    const generationId = env.stage(value.graph, value.materialization);
    env.store.publishCandidateGeneration(generationId, { frameworkStaged: true });
    const loaded = env.store.loadFramework(env.repository.id);
    assert.ok(loaded);
    assert.equal(loaded.entities.length, 1);
    assert.equal(loaded.entities[0]?.ref.kind, "message_consumer");
    assert.equal(loaded.relationships[0]?.relationKind, "message_handler");

    const literalTemplate = fixture({ destination: "${topic}" });
    const templateGeneration = env.stage(literalTemplate.graph, literalTemplate.materialization);
    env.store.publishCandidateGeneration(templateGeneration, { frameworkStaged: true });
    assert.equal(env.store.loadFramework(env.repository.id)?.entities[0]?.ref.kind, "message_consumer");
  } finally { await env.close(); }
});

test("message consumer partial publication accepts supported plus known unsupported and unsupported only", async () => {
  const env = await setup();
  try {
    const good = fixture();
    const partial = fixture({ unsupported: true });
    const mixedGeneration = env.stage(good.graph, { ...good.materialization,
      diagnostics: partial.materialization.diagnostics, coverage: [...good.materialization.coverage, ...partial.materialization.coverage], complete: false });
    env.store.publishCandidateGeneration(mixedGeneration, { frameworkStaged: true });
    const loadedMixed = env.store.loadFramework(env.repository.id)!;
    assert.equal(loadedMixed.entities.length, 1);
    assert.equal(loadedMixed.complete, false);

    const unsupportedGeneration = env.stage(partial.graph, partial.materialization);
    env.store.publishCandidateGeneration(unsupportedGeneration, { frameworkStaged: true });
    assert.equal(env.store.loadFramework(env.repository.id)?.entities.length, 0);
    assert.equal(env.store.loadFramework(env.repository.id)?.complete, false);
  } finally { await env.close(); }
});

test("message publication blocks unknown diagnostics and invalid handler bindings without replacing active generation", async () => {
  const env = await setup();
  try {
    const good = fixture();
    const first = env.stage(good.graph, good.materialization);
    env.store.publishCandidateGeneration(first, { frameworkStaged: true });
    const active = env.store.getActiveGenerationId(env.repository.id);
    const partial = fixture({ unsupported: true });
    const bad = { ...partial.materialization, diagnostics: partial.materialization.diagnostics.map((item) => ({ ...item, reason: "unknown_unsupported" })) };
    const badDiagnostic = env.stage(partial.graph, bad);
    assert.throws(() => env.store.publishCandidateGeneration(badDiagnostic, { frameworkStaged: true }), /incomplete/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);

    for (const change of [
      { detections: [] },
      { coverage: partial.materialization.coverage.map((item) => ({ ...item, unsupported: 0 })) },
      { diagnostics: partial.materialization.diagnostics.map((item) => ({ ...item, code: "framework_adapter_failed" as const, outcome: "adapter_failed" as const })) },
    ]) {
      const blocked = env.stage(partial.graph, { ...partial.materialization, ...change });
      assert.throws(() => env.store.publishCandidateGeneration(blocked, { frameworkStaged: true }), /incomplete/i);
      assert.equal(env.store.getActiveGenerationId(env.repository.id), active);
    }

    const acceptedEvidence = good.materialization.entities[0]!.provenance.evidenceIds[0]!;
    const reusedEvidence = { ...good.materialization, diagnostics: partial.materialization.diagnostics.map((item) => ({ ...item, evidenceIds: [acceptedEvidence] })), coverage: [...good.materialization.coverage, ...partial.materialization.coverage], complete: false };
    const reused = env.stage(good.graph, reusedEvidence);
    assert.throws(() => env.store.publishCandidateGeneration(reused, { frameworkStaged: true }), /incomplete/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);

    const sameSource = { ...good.materialization, diagnostics: partial.materialization.diagnostics.map((item) => ({ ...item, refs: good.materialization.entities[0]!.provenance.refs })), coverage: [...good.materialization.coverage, ...partial.materialization.coverage], complete: false };
    const sameSourceGeneration = env.stage(good.graph, sameSource);
    assert.throws(() => env.store.publishCandidateGeneration(sameSourceGeneration, { frameworkStaged: true }), /incomplete/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);

    const eventUnsupported = fixture({ consumer: "event", unsupported: true });
    const wrongReason = { ...eventUnsupported.materialization,
      diagnostics: eventUnsupported.materialization.diagnostics.map((item) => ({ ...item, reason: "unsupported_topics", strategy: "messaging.unsupported_topics" })) };
    const wrongReasonGeneration = env.stage(eventUnsupported.graph, wrongReason);
    assert.throws(() => env.store.publishCandidateGeneration(wrongReasonGeneration, { frameworkStaged: true }), /incomplete/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);

    const duplicateRefDiagnostics = partial.materialization.diagnostics.map((item, index) => ({ ...item, evidenceIds: [`message:src/consumer.ts:unsupported-${index}`] }));
    const duplicateRefs: FrameworkMaterialization = { ...partial.materialization,
      diagnostics: duplicateRefDiagnostics,
      coverage: partial.materialization.coverage.map((item) => ({ ...item, applicable: 2, attempted: 2, unsupported: 2 })),
    };
    const duplicateRefGeneration = env.stage(partial.graph, duplicateRefs);
    assert.throws(() => env.store.publishCandidateGeneration(duplicateRefGeneration, { frameworkStaged: true }), /incomplete/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);

    const otherId = "graph:method:Worker.other";
    const otherGraph: CodeGraph = { ...good.graph, nodes: [...good.graph.nodes, { id: otherId, type: "method", name: "other", qualifiedName: "Worker.other", file: "src/consumer.ts" }] };
    const ambiguous: FrameworkMaterialization = { ...good.materialization, relationships: [good.relationship, { ...good.relationship, source: { kind: "language", nodeId: otherId } }] };
    assert.throws(() => env.stage(otherGraph, ambiguous), /one handler|invalid framework/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);
    assert.throws(() => env.stage(good.graph, { ...good.materialization, relationships: [good.relationship, { ...good.relationship, relationKind: "scheduled_handler" } as FrameworkRelationship] }), /message_handler|invalid framework/i);
    assert.equal(env.store.getActiveGenerationId(env.repository.id), active);
  } finally { await env.close(); }
});

test("message consumer persisted identity, metadata, relation direction and callable type fail closed", async () => {
  const env = await setup();
  try {
    const nestMetadata = fixture({ metadata: { groupSource: null, concurrency: "2", containerFactory: null } });
    assert.throws(() => env.stage(nestMetadata.graph, nestMetadata.materialization), /invalid or dynamic/i);
    const value = fixture({ framework: "spring", protocol: "kafka", consumer: "event", destinationKind: "topic", destination: "orders", identityOptions: { id: "listener-a", groupId: "group-a" }, metadata: { groupSource: "explicit", concurrency: null, containerFactory: null } });
    const badWriteIdentity = JSON.parse(value.ref.logicalKey) as unknown[];
    badWriteIdentity[5] = "${topic}";
    assert.throws(() => env.stage(value.graph, { ...value.materialization, entities: value.materialization.entities.map((entity) => ({ ...entity, ref: { ...entity.ref, logicalKey: JSON.stringify(badWriteIdentity) } })) }), /static values|invalid framework entity reference/i);
    assert.throws(() => env.stage(value.graph, { ...value.materialization, entities: value.materialization.entities.map((entity) => ({ ...entity, messageMetadata: { ...entity.messageMetadata!, concurrency: "#{workers}" } })) }), /static values|invalid message consumer identity|metadata|capability/i);
    const generationId = env.stage(value.graph, value.materialization);
    env.store.publishCandidateGeneration(generationId, { frameworkStaged: true });
    const db = new DatabaseSync(path.join(env.root, "atlas.db"));
    try {
      const row = db.prepare("SELECT entity_key,payload_json FROM generation_framework_entities WHERE generation_id=?").get(generationId) as { entity_key: string; payload_json: string };
      const originalEntity = JSON.parse(row.payload_json) as Record<string, unknown>;
      const originalRef = originalEntity.ref as Record<string, unknown>;
      const identity = JSON.parse(String(originalRef.logicalKey)) as unknown[];
      const badIdentity = identity.map((item, index) => index === 3 ? "invalid_consumer_kind" : item);
      const dynamicDestination = identity.map((item, index) => index === 5 ? "${topic}" : item);
      for (const corrupt of [
        { ...originalEntity, ref: { ...originalRef, logicalKey: JSON.stringify(badIdentity) } },
        { ...originalEntity, ref: { ...originalRef, logicalKey: JSON.stringify(dynamicDestination) } },
        { ...originalEntity, messageMetadata: { groupSource: "id", concurrency: null, containerFactory: null } },
        { ...originalEntity, messageMetadata: { groupSource: "explicit", concurrency: null, containerFactory: "#{factory}" } },
      ]) {
        db.prepare("UPDATE generation_framework_entities SET payload_json=? WHERE generation_id=? AND entity_key=?").run(JSON.stringify(corrupt), generationId, row.entity_key);
        assert.equal(env.store.loadFramework(env.repository.id), undefined);
      }
      db.prepare("UPDATE generation_framework_entities SET payload_json=? WHERE generation_id=? AND entity_key=?").run(row.payload_json, generationId, row.entity_key);

      const rel = db.prepare("SELECT rowid,payload_json FROM generation_framework_relationships WHERE generation_id=?").get(generationId) as { rowid: number; payload_json: string };
      const originalRelation = JSON.parse(rel.payload_json) as Record<string, unknown>;
      db.prepare("UPDATE generation_framework_relationships SET payload_json=? WHERE rowid=?").run(JSON.stringify({ ...originalRelation, source: originalRelation.target, target: originalRelation.source }), rel.rowid);
      assert.equal(env.store.loadFramework(env.repository.id), undefined);
      db.prepare("UPDATE generation_framework_relationships SET payload_json=? WHERE rowid=?").run(rel.payload_json, rel.rowid);
      const source = originalRelation.source as { nodeId: string };
      db.prepare("UPDATE generation_symbols SET type='class' WHERE generation_id=? AND id=?").run(generationId, source.nodeId);
      assert.equal(env.store.loadFramework(env.repository.id), undefined);
    } finally { db.close(); }
    assert.equal(env.store.getActiveGenerationId(env.repository.id), generationId);
  } finally { await env.close(); }
});

test("message consumer Atlas binds identity/provenance to its granular detected capability and callable", async () => {
  const env = await setup();
  try {
    const invalid = [
      fixture({ entityCapability: "nestjs.routes" }),
      fixture({ relationCapability: "nestjs.event_pattern" }),
      fixture({ detections: [] }),
      fixture({ callableName: "notRun" }),
      fixture({ callableType: "OtherWorker" }),
    ];
    for (const value of invalid) assert.throws(() => env.stage(value.graph, value.materialization));

    const valid = fixture();
    const generationId = env.stage(valid.graph, valid.materialization);
    env.store.publishCandidateGeneration(generationId, { frameworkStaged: true });
    const db = new DatabaseSync(path.join(env.root, "atlas.db"));
    try {
      const row = db.prepare("SELECT entity_key,payload_json FROM generation_framework_entities WHERE generation_id=?").get(generationId) as { entity_key: string; payload_json: string };
      const original = JSON.parse(row.payload_json) as Record<string, unknown>;
      const corrupt = { ...original, provenance: { ...(original.provenance as object), capability: "nestjs.routes" } };
      db.prepare("UPDATE generation_framework_entities SET payload_json=? WHERE generation_id=? AND entity_key=?").run(JSON.stringify(corrupt), generationId, row.entity_key);
      assert.equal(env.store.loadFramework(env.repository.id), undefined);
      db.prepare("UPDATE generation_framework_entities SET payload_json=? WHERE generation_id=? AND entity_key=?").run(row.payload_json, generationId, row.entity_key);

      const relation = db.prepare("SELECT rowid,payload_json FROM generation_framework_relationships WHERE generation_id=?").get(generationId) as { rowid: number; payload_json: string };
      const originalRelation = JSON.parse(relation.payload_json) as Record<string, unknown>;
      const badRelation = { ...originalRelation, provenance: { ...(originalRelation.provenance as object), capability: "nestjs.event_pattern" } };
      db.prepare("UPDATE generation_framework_relationships SET payload_json=? WHERE rowid=?").run(JSON.stringify(badRelation), relation.rowid);
      assert.equal(env.store.loadFramework(env.repository.id), undefined);
      db.prepare("UPDATE generation_framework_relationships SET payload_json=? WHERE rowid=?").run(relation.payload_json, relation.rowid);
      db.prepare("UPDATE generation_framework_state SET detections_json='[]' WHERE generation_id=?").run(generationId);
      assert.equal(env.store.loadFramework(env.repository.id), undefined);
    } finally { db.close(); }
  } finally { await env.close(); }
});
