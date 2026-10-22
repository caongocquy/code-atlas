import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/adapters/mcp/mcp-server.js";
import { indexRepository } from "../../src/core/indexing/index-pipeline.service.js";
import { createDeepWorkload, createReactWorkload } from "./qualification-fixtures.js";

export async function createWorkload(root: string) {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-ca01-"));
  try {
    await cp(path.join(root, "eval/retrieval/fixtures/catalog"), path.join(repoPath, "catalog"), { recursive: true });
    await cp(path.join(root, "eval/retrieval/fixtures/pricing"), path.join(repoPath, "pricing"), { recursive: true });
    const excerpt = "// evidence ngân sách 🌏 " + "largeEvidence ".repeat(180);
    await writeFile(path.join(repoPath, "large.ts"), Array.from({ length: 80 }, (_, i) =>
      `export function largeEvidence${i}() {\n${excerpt}\n return ${i};\n}\n`).join("\n"));
    await mkdir(path.join(repoPath, "chain"));
    for (let i = 0; i < 12; i++) {
      await writeFile(path.join(repoPath, "chain", `step${i}.ts`),
        `${i === 0 ? "" : `import { step${i - 1} } from './step${i - 1}.js';\n`}export function step${i}() { return ${i === 0 ? "true" : `step${i - 1}()`}; }\n`);
    }
    const outcome = await indexRepository(repoPath, { skipGit: true, includeSemantic: false });
    assert.notEqual(outcome.kind, "failed", JSON.stringify(outcome));
    return repoPath;
  } catch (error) {
    await rm(repoPath, { recursive: true, force: true });
    throw error;
  }
}

export const workloads = [
  { id: "small-symbol", name: "search_code", args: { query: "step0" } },
  { id: "large-lexical", name: "search_code", args: { query: "largeEvidence", limit: 80 } },
  { id: "hybrid-fallback", name: "search_code", args: { query: "largeEvidence", mode: "hybrid", limit: 80 } },
  { id: "owner-aware", name: "search_code", args: { query: "MemoryCatalogStore load", limit: 20 } },
  { id: "deep-impact", name: "impact", args: { query: "deep0", maxDepth: 10, limit: 80 } },
  { id: "repeated-stages", name: "inspect_retrieval", args: { query: "largeEvidence", limit: 80, graphEnabled: false } },
  { id: "ambiguous", name: "get_symbol", args: { query: "find" } },
  { id: "no-result", name: "search_code", args: { query: "missingZZZZZZ" } },
  { id: "unresolved", name: "get_symbol", args: { query: "missingZZZZZZ" } },
  { id: "large-excerpt", name: "search_code", args: { query: "largeEvidence0", limit: 1 } },
  { id: "real-react", name: "search_code", args: { query: "useState", limit: 80 } },
] as const;

export async function connect() {
  const server = createMcpServer();
  const client = new Client({ name: "ca01-protocol-benchmark", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function percentile(values: number[], fraction: number) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
}

export async function benchmark(output: string, modes: string[], samples = 12) {
  const root = process.cwd();
  const repoPath = await createWorkload(root);
  const graphRepo = await createDeepWorkload();
  const reactRepo = await createReactWorkload(root);
  const { client, server } = await connect();
  let queries = 0, databaseMs = 0;
  let sqlCounts: Record<string, number> = {};
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) {
    const start = performance.now();
    const statement = originalPrepare.apply(this, args);
    databaseMs += performance.now() - start;
    for (const name of ["all", "get", "run"] as const) {
      const original = statement[name];
      Object.defineProperty(statement, name, { value: function (...parameters: unknown[]) {
        queries++;
        const sql = args[0].replace(/\s+/g, " ").trim();
        sqlCounts[sql] = (sqlCounts[sql] ?? 0) + 1;
        const before = performance.now();
        try { return Reflect.apply(original, statement, parameters); }
        finally { databaseMs += performance.now() - before; }
      } });
    }
    return statement;
  };
  const measurements = [];
  try {
    for (const workload of workloads) {
      if (process.env.CA01_CASE && process.env.CA01_CASE !== workload.id) continue;
      for (const mode of modes) {
        const args = { repoPath: workload.id === "deep-impact" ? graphRepo : workload.id === "real-react" ? reactRepo : repoPath, ...workload.args, ...(mode === "legacy" ? {} : { response: { mode, maxOutputBytes: 1_000_000 } }) };
        const times: number[] = [], dbTimes: number[] = [], counts: number[] = [];
        // Warm runtime/parser/cache setup outside measured samples.
        await client.callTool({ name: workload.name, arguments: args });
        globalThis.gc?.();
        const memoryBefore = process.memoryUsage();
        let observedRss = memoryBefore.rss, observedHeap = memoryBefore.heapUsed;
        let result;
        for (let sample = 0; sample < samples; sample++) {
          queries = 0; databaseMs = 0; sqlCounts = {};
          const start = performance.now();
          result = await client.callTool({ name: workload.name, arguments: args });
          times.push(performance.now() - start); dbTimes.push(databaseMs); counts.push(queries);
          const memory = process.memoryUsage(); observedRss = Math.max(observedRss, memory.rss); observedHeap = Math.max(observedHeap, memory.heapUsed);
          assert.notEqual(result.isError, true, JSON.stringify(result));
        }
        assert.ok(result);
        const text: string = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === "text")!.text!;
        const value = JSON.parse(text);
        assert.equal(text, JSON.stringify(result.structuredContent), "text and structured JSON must agree");
        const serialized = JSON.stringify(result);
        const collections = Object.fromEntries(Object.entries(value).filter(([, items]) => Array.isArray(items)).map(([key, items]) => [key, (items as unknown[]).length]));
        measurements.push({ scenario: workload.id, mode, tool: workload.name, arguments: workload.args,
          resultCounts: collections, payloadBytes: Buffer.byteLength(text), responseBytes: Buffer.byteLength(serialized),
          estimatedTokens: Math.ceil(serialized.length / 4), tokenMethod: "UTF-16 code units / 4; estimate only",
          sqliteExecutions: { min: Math.min(...counts), max: Math.max(...counts) },
          sqliteLastSample: sqlCounts,
          memory: { before: memoryBefore, after: process.memoryUsage(), maxObservedRss: observedRss, maxObservedHeap: observedHeap, method: "GC before measured samples when exposed; RSS/heap sampled after each response, not exact transient peak" },
          databaseMs: { p50: percentile(dbTimes, .5), p95: percentile(dbTimes, .95) },
          mcpMs: { p50: percentile(times, .5), p95: percentile(times, .95) },
          status: value.status, semanticState: value.semanticState, mayBeIncomplete: value.mayBeIncomplete,
          identities: (value.results ?? value.directImpact ?? value.candidates ?? []).map((item: Record<string, unknown>) => {
            const entity = (item.entity ?? item) as Record<string, unknown>;
            return [entity.file, entity.symbolName ?? entity.name, entity.startLine, entity.endLine];
          }),
          output: value.output,
        });
      }
    }
    const report = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
      benchmarkSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus()[0]?.model },
      samples, transport: "MCP SDK InMemoryTransport; includes content and structuredContent; excludes JSON-RPC frame",
      sqliteMethod: "all/get/run execution count and time plus prepare time; excludes exec/connection/fs work",
      processPeakRssKiB: process.resourceUsage().maxRSS,
      semantic: "No configured model; hybrid fallback measured, real embeddings not measured",
      measurements };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(measurements.map(({ scenario, mode, responseBytes, sqliteExecutions, mcpMs }) => ({ scenario, mode, responseBytes, sqliteExecutions, mcpMs })), null, 2));
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await client.close(); await server.close();
    await rm(repoPath, { recursive: true, force: true });
    await rm(graphRepo, { recursive: true, force: true });
    await rm(reactRepo, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await benchmark(process.argv[2] ?? "artifacts/ca01-baseline.json", process.argv.slice(3).length ? process.argv.slice(3) : ["legacy"]);
}
