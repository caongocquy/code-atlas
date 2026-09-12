import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalProjectionIdentity,
  canonicalSubjectIdentity,
  validateContextSession,
  validateContextSubject,
} from "../src/core/context/context-identity.js";
import type { ContextSession, ContextSubject } from "../src/core/context/context.types.js";

test("context contracts require explicit sessions and independent context generations", () => {
  const session: ContextSession = {
    sessionId: "session-1",
    repositoryIdentity: "repo-1",
    workspaceIdentity: "workspace-1",
    createdAt: "2026-09-12T00:00:00.000Z",
    lastSeenAt: "2026-09-12T00:00:00.000Z",
    contextGeneration: "context-1",
    schemaVersion: 1,
  };
  assert.deepEqual(validateContextSession(session), session);
  assert.notEqual({ ...session, contextGeneration: "context-2" }.contextGeneration, session.contextGeneration);
  assert.throws(() => validateContextSession({ ...session, sessionId: "" }), /sessionId/);
});

test("subject and projection identities are canonical and reject unsafe selectors", () => {
  const subject: ContextSubject = { kind: "file", path: "src/index.ts" };
  assert.equal(canonicalSubjectIdentity("repo", "workspace", subject), '{"kind":"file","path":"src/index.ts","repositoryIdentity":"repo","workspaceIdentity":"workspace"}');
  assert.equal(canonicalProjectionIdentity("source", { schemaVersion: 1, detail: "compact" }), '{"detail":"compact","name":"source","schemaVersion":1}');
  assert.deepEqual(validateContextSubject({ kind: "symbol", path: "src/index.ts", symbolId: "fn:main", selectorVersion: "1" }), { kind: "symbol", path: "src/index.ts", symbolId: "fn:main", selectorVersion: "1" });
  assert.throws(() => validateContextSubject({ kind: "file", path: "../secret.ts" }), /path/);
  assert.throws(() => validateContextSubject({ kind: "file", path: "/absolute.ts" }), /path/);
});
