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

  for (const key of [
    "expressions", "members", "assignments", "parameters", "returns",
    "constructors", "inheritances", "implementations", "aliases", "modules", "namespaces",
  ] as const) assert.ok(Array.isArray(result.facts[key]), `${key} is an array`);
  assert.equal(result.facts.expressions[0]?.localId, "expression:3");
  assert.equal(result.facts.assignments[0]?.sourceExpressionId, "expression:3");
  assert.equal(result.facts.modules.length, 1);
  assert.equal(result.facts.frameworkSyntax?.complete, true);
  assert.ok(result.facts.frameworkSyntax?.nodes.some((node) => node.kind === "literal" && node.value === 1));
  assert.deepEqual(result.facts.parserIdentity, {
    language: "typescript",
    runtimeName: "tree-sitter",
    runtimeVersion: "0.25.1",
    packageName: "tree-sitter-typescript",
    grammarName: "tree-sitter-typescript",
    grammarVersion: "0.23.2",
  });
});

test("fact codec rejects malformed records in every objective array", () => {
  const objectiveFields = [
    "expressions", "members", "assignments", "parameters", "returns",
    "constructors", "inheritances", "implementations", "aliases", "modules", "namespaces",
  ] as const;

  for (const field of objectiveFields) {
    for (const malformed of [null, {}]) {
      const facts = makeFacts({ [field]: [malformed] });
      assert.deepEqual(
        decodeFacts(encodeFacts(facts), expectation(facts)),
        { kind: "miss", reason: "schema_mismatch" },
        `${field} should reject ${malformed === null ? "null" : "an empty record"}`,
      );
    }
  }
});
