import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/adapters/mcp/mcp-server.js";
import { createWorkload } from "./benchmark.js";
import { createDeepWorkload } from "./qualification-fixtures.js";

const baselineRoot = process.argv[2];
assert.ok(baselineRoot, "Usage: node --import tsx/esm eval/mcp/legacy-parity.ts <clean-baseline-root>");
const baselineHead = execFileSync("git", ["-C", path.resolve(baselineRoot), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(baselineHead, "d2570bd789095d82442ff332beb36a5ddd998194", "Legacy parity baseline must be the approved immutable target");
const baseline = await import(pathToFileURL(path.resolve(baselineRoot, "src/adapters/mcp/mcp-server.ts")).href);
async function connected(factory: typeof createMcpServer) {
  const server = factory(), client = new Client({ name: "ca01-legacy-parity", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}
const a = await connected(baseline.createMcpServer), b = await connected(createMcpServer);
const repoPath = await createWorkload(process.cwd()), graphRepo = await createDeepWorkload();
try {
  const normalizeSchema = (value: Awaited<ReturnType<Client["listTools"]>>) => JSON.parse(JSON.stringify(value, (key, item) => key === "response" ? undefined : item));
  assert.deepEqual(normalizeSchema(await a.client.listTools()), normalizeSchema(await b.client.listTools()));
  const cases = [
    ["search_code", { repoPath, query: "largeEvidence", limit: 80 }],
    ["search_code", { repoPath, query: "MemoryCatalogStore load", mode: "hybrid" }],
    ["search_code", { repoPath, query: "missingZZZZZZ" }],
    ["get_symbol", { repoPath, query: "find" }],
    ["get_symbol", { repoPath: graphRepo, query: "deep0" }],
    ["find_callers", { repoPath: graphRepo, query: "deep0" }],
    ["find_callees", { repoPath: graphRepo, query: "deep10" }],
    ["impact", { repoPath: graphRepo, query: "deep0", maxDepth: 10, limit: 80 }],
    ["list_communities", { repoPath: graphRepo }],
    ["important_symbols", { repoPath: graphRepo }],
    ["inspect_retrieval", { repoPath, query: "largeEvidence", graphEnabled: false }],
  ] as const;
  const evidence = [];
  for (const [name, args] of cases) {
    const old = await a.client.callTool({ name, arguments: args });
    const current = await b.client.callTool({ name, arguments: args });
    const normalize = (result: typeof old) => {
      const value = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      if (name === "inspect_retrieval") delete value.metrics;
      return { isError: result.isError ?? false, value };
    };
    assert.deepEqual(normalize(current), normalize(old), name);
    const hash = createHash("sha256").update(JSON.stringify(normalize(current))).digest("hex");
    evidence.push({ name, arguments: args, status: "PASS", sha256: hash, normalization: name === "inspect_retrieval" ? "exclude volatile root metrics only" : "none" });
  }
  await writeFile("artifacts/closure-legacy-parity.json", JSON.stringify({ baseline: baselineHead, schemas: "PASS: all legacy schemas/annotations unchanged after removing optional response", cases: evidence }, null, 2) + "\n");
  console.log(`Legacy contract parity PASS: ${cases.length} cases, complete payload comparison except recorded inspection timings.`);
} finally {
  await a.client.close(); await a.server.close(); await b.client.close(); await b.server.close();
  await rm(repoPath, { recursive: true, force: true }); await rm(graphRepo, { recursive: true, force: true });
}
