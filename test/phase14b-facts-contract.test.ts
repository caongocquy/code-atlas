import assert from "node:assert/strict";
import test from "node:test";

import {
  makeFacts,
  range,
  expectation,
} from "./helpers/phase14b-facts.js";
import type { FactLocalId } from "../src/core/facts/facts.types.js";
import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";

test("ParsedFacts carries objective receiver, flow, ownership, and language-specific seeds", () => {
  const facts = makeFacts({
    expressions: [{ localId: "expression:1" as FactLocalId, kind: "identifier", text: "service", range: range(2) }],
    members: [{ localId: "member:1" as FactLocalId, receiverId: "expression:1" as FactLocalId, memberName: "refresh", memberKind: "method", access: "instance", range: range(2) }],
    assignments: [{ localId: "assignment:1" as FactLocalId, targetId: "binding:1" as FactLocalId, sourceExpressionId: "expression:1" as FactLocalId, assignmentKind: "declaration", range: range(1) }],
    implementations: [{ localId: "implementation:1" as FactLocalId, subjectId: "symbol:1" as FactLocalId, targetName: "Service", relationKind: "implements", range: range(1) }],
  });
  assert.equal(facts.members[0]?.receiverId, "expression:1");
  assert.equal(facts.implementations[0]?.relationKind, "implements");
});

test("fact identity and codec use the complete parser identity", () => {
  const facts = makeFacts();
  const decoded = decodeFacts(encodeFacts(facts), expectation(facts));

  assert.equal(decoded.kind, "hit");
});

test("fact extraction returns every objective array and complete parser identity", () => {
  const result = extractParsedFacts({
    source: "const value = 1;",
    language: "typescript",
    contentHash: "snapshot-hash",
    factsVersion: "1",
    factsSchemaVersion: "1",
  });

  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  assert.deepEqual(
    Object.fromEntries([
      "expressions", "members", "assignments", "parameters", "returns",
      "constructors", "inheritances", "implementations", "aliases", "modules", "namespaces",
    ].map((key) => [key, result.facts[key as keyof typeof result.facts]])),
    {
      expressions: [], members: [], assignments: [], parameters: [], returns: [],
      constructors: [], inheritances: [], implementations: [], aliases: [], modules: [], namespaces: [],
    },
  );
  assert.deepEqual(result.facts.parserIdentity, {
    language: "typescript",
    runtimeName: "tree-sitter",
    runtimeVersion: "0.25.1",
    packageName: "tree-sitter-typescript",
    grammarName: "tree-sitter-typescript",
    grammarVersion: "0.23.2",
  });
});
