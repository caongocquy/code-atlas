import test from "node:test";
import assert from "node:assert/strict";

import { getWorkspaceIdentity } from "../src/core/context/context-identity.js";

test("worktree audit contract remains explicit and workspace-scoped", () => {
  const identity = getWorkspaceIdentity(process.cwd());
  assert.ok(identity.repositoryIdentity.length > 0);
  assert.ok(identity.workspaceIdentity.length > 0);
  assert.notEqual(identity.repositoryIdentity, identity.workspaceIdentity);
});
