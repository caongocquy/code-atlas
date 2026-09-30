import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";

function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

test("repository_map tool projects configured areas with bounded compact and full details", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase17b-map-"));
  await mkdir(path.join(repoPath, "src/api"), { recursive: true });
  await mkdir(path.join(repoPath, "src/service"), { recursive: true });
  await writeFile(path.join(repoPath, "src/api/handler.ts"), "export function handler() { return service(); }\n");
  await writeFile(path.join(repoPath, "src/api/other.ts"), "export function other() { return 2; }\n");
  await writeFile(path.join(repoPath, "src/service/core.ts"), "export function service() { return 1; }\n");
  await writeFile(path.join(repoPath, "codeatlas.config.json"), JSON.stringify({
    version: 1,
    architecture: { groups: [
      { id: "api", include: ["src/api/**"] },
      { id: "service", include: ["src/service/**"] },
    ] },
  }));
  try {
    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "phase17b-repository-map-client", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "repository_map"));
      const args = { repoPath, maxAreas: 2, maxFilesPerArea: 1, maxRelations: 1 };
      const compact = payload(await client.callTool({ name: "repository_map", arguments: args }));
      const full = payload(await client.callTool({ name: "repository_map", arguments: { ...args, detail: "full" } }));
      assert.equal(compact.boundarySource, "architecture_group");
      const compactAreas = compact.areas as Array<Record<string, unknown>>;
      const fullAreas = full.areas as Array<Record<string, unknown>>;
      assert.deepEqual(compactAreas.map((area) => [area.id, area.fileCount, area.symbolCount]), fullAreas.map((area) => [area.id, area.fileCount, area.symbolCount]));
      assert.deepEqual(
        (compact.relations as Array<Record<string, unknown>>).map((relation) => [relation.sourceAreaId, relation.targetAreaId, relation.edgeCount, relation.relationCounts]),
        (full.relations as Array<Record<string, unknown>>).map((relation) => [relation.sourceAreaId, relation.targetAreaId, relation.edgeCount, relation.relationCounts]),
      );
      assert.deepEqual(compactAreas.map((area) => area.id), ["api", "service"]);
      assert.ok(compactAreas.every((area) => (area.files as string[]).length <= 1));
      assert.equal("directories" in (compactAreas[0] ?? {}), false);
      assert.equal(Array.isArray(fullAreas[0]?.directories), true);
      assert.equal((compact.diagnostics as { truncation: { files: boolean } }).truncation.files, true);
      assert.equal(compact.mayBeIncomplete, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
