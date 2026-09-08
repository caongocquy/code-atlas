import assert from "node:assert/strict";
import test from "node:test";

import {
  makeFacts,
  range,
} from "./helpers/phase14b-facts.js";
import type { FactLocalId } from "../src/core/facts/facts.types.js";

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
