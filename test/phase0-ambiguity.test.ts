import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodeGraph } from "../src/core/graph/build-graph.js";

const fixturePath = fileURLToPath(new URL("./fixtures/phase-0-ambiguity", import.meta.url));

test("ambiguity fixture documents current deterministic first-match behavior", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-0-ambiguity-"));

  try {
    await cp(fixturePath, repoPath, { recursive: true });
    const graph = await buildCodeGraph(repoPath);
    const targets = graph.nodes.filter(
      (node) => node.file === "ambiguous.ts" && node.name === "duplicate",
    );
    const caller = graph.nodes.find(
      (node) => node.file === "ambiguous.ts" && node.qualifiedName === "caller",
    );
    const callTargets = graph.edges
      .filter((edge) => edge.type === "calls" && edge.from === caller?.id)
      .map((edge) => edge.to);

    assert.equal(targets.length, 2);
    assert.notEqual(targets[0]?.id, targets[1]?.id);
    assert.ok(caller);
    assert.deepEqual(callTargets, [targets[0]?.id]);
    // TODO(Resolution Evidence v2): change this baseline to unique-or-drop.
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
