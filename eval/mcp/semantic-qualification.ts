import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTransformersLocalEmbeddingProvider } from "../../src/infrastructure/semantic/transformers-local-embedding-provider.js";
import { connect } from "./benchmark.js";

const repoPath = await mkdtemp(path.join(os.tmpdir(), "ca01-semantic-"));
const provider = createTransformersLocalEmbeddingProvider({ type: "builtin-local", model: "Xenova/all-MiniLM-L6-v2", revision: "751bff37182d3f1213fa05d7196b954e230abad9", dimensions: 384 }, { runtimeDirectory: path.resolve("artifacts/semantic-runtime"), allowRemoteModels: false });
let requests = 0, textsEmbedded = 0, delay = false;
const releases: Array<() => void> = [];
const api = http.createServer(async (request, response) => {
  try {
    let body = ""; for await (const chunk of request) body += chunk;
    const { input } = JSON.parse(body) as { input: string[] | string };
    if (delay) await new Promise<void>(resolve => releases.push(resolve));
    const texts = Array.isArray(input) ? input : [input];
    const vectors = await provider.embedBatch(texts); requests++; textsEmbedded += texts.length;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: vectors.map((embedding, index) => ({ embedding, index, object: "embedding" })) }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;
const { client, server } = await connect();
try {
  await writeFile(path.join(repoPath, "invoice.ts"), "export function calculateInvoice(price: number) { return price * 1.1; }\n");
  await writeFile(path.join(repoPath, "garden.ts"), "export function waterFlowers() { return 'garden soil irrigation'; }\n");
  const setup = await client.callTool({ name: "semantic_setup", arguments: { repoPath, provider: { type: "openai-compatible", baseUrl: `http://127.0.0.1:${port}`, model: "local-minilm-real-inference", dimensions: 384 } } });
  assert.equal(setup.isError, undefined, JSON.stringify(setup));
  const indexed = await client.callTool({ name: "index_repository", arguments: { repoPath, skipGit: true, includeSemantic: true } });
  assert.equal(indexed.isError, undefined, JSON.stringify(indexed));
  const args = { repoPath, query: "cost of bought goods and sales tax", mode: "hybrid", limit: 20 };
  const measurements = [];
  let identities: unknown;
  for (const mode of ["legacy", "compact", "focused", "full"]) {
    const start = performance.now();
    const result = await client.callTool({ name: "search_code", arguments: { ...args, ...(mode === "legacy" ? {} : { response: { mode, maxOutputBytes: 64_000 } }) } });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const value = result.structuredContent as Record<string, any>;
    assert.equal(value.semanticState, "ready"); assert.ok(value.results.length > 0);
    const current = value.results.map((item: any) => [item.file, item.symbolName, item.startLine, item.fusionScore]);
    if (mode === "legacy") identities = current; else assert.deepEqual(current, identities);
    measurements.push({ mode, bytes: Buffer.byteLength(JSON.stringify(result)), ms: performance.now() - start, semanticState: value.semanticState, identities: current });
  }
  delay = true;
  const abort = new AbortController();
  const cancelled = client.callTool({ name: "search_code", arguments: { ...args, response: { mode: "focused" } } }, undefined, { signal: abort.signal });
  abort.abort(); await assert.rejects(cancelled, /abort|cancel/i);
  await assert.rejects(client.callTool({ name: "search_code", arguments: { ...args, response: { mode: "focused" } } }, undefined, { timeout: 100 }), /timed out/i);
  delay = false; for (const release of releases.splice(0)) release();
  assert.equal((await client.callTool({ name: "search_code", arguments: args })).isError, undefined);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/closure-semantic.json", JSON.stringify({ provider: "Real local Transformers MiniLM inference behind loopback OpenAI-compatible adapter", model: provider.model, revision: provider.revision, dimensions: 384, requests, textsEmbedded, measurements, clientCancellation: "PASS", clientTimeout: "PASS", failureIsolation: "PASS", limitation: "SDK cancellation/timeout return promptly; synchronous SQLite/projection is not preemptible, and provider work may finish after client cancellation." }, null, 2) + "\n");
  console.log(JSON.stringify({ semantic: "PASS", requests, textsEmbedded, measurements }));
} finally {
  delay = false; for (const release of releases.splice(0)) release();
  await client.close(); await server.close();
  api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve()));
  await rm(repoPath, { recursive: true, force: true });
}
