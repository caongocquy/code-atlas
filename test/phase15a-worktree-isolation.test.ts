import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { getWorkspaceIdentity } from "../src/core/context/context-identity.js";

test("unrelated non-Git repositories with identical files have distinct context identities", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-isolation-"));
  const repositories = [path.join(parent, "one"), path.join(parent, "two")];
  try {
    for (const repository of repositories) {
      await mkdir(repository);
      await writeFile(path.join(repository, "same.ts"), "export const same = true;\n");
    }

    const identities = repositories.map(getWorkspaceIdentity);
    assert.notEqual(identities[0]?.repositoryIdentity, identities[1]?.repositoryIdentity);
    assert.notEqual(identities[0]?.workspaceIdentity, identities[1]?.workspaceIdentity);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
