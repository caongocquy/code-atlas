import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";

export const responseOptionsSchema = z.object({
  mode: z.enum(["compact", "focused", "full"]),
  sections: z.array(z.enum(["source", "relationships", "provenance", "stages"])).max(4).optional(),
  relationKinds: z.array(z.enum(["calls", "imports", "extends", "implements", "references", "contains"])).max(6).optional(),
  maxOutputBytes: z.number().int().min(512).max(1_000_000).optional(),
  maxOutputTokens: z.number().int().min(128).max(250_000).describe("Approximation only: selects a byte allowance of tokens * 4, not a model-specific token guarantee.").optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(4096).optional(),
}).strict();

export type ResponseOptions = z.infer<typeof responseOptionsSchema>;
type JsonObject = Record<string, unknown>;

// Receipt-bearing context and federated workspace tools have independent contracts.
export const optimizedTools = new Set([
  "search_code", "get_symbol", "find_callers", "find_callees", "find_imports", "find_imported_by",
  "impact", "trace", "execution_flow", "inspect_retrieval", "get_community", "list_communities",
  "important_symbols", "architectural_bridges", "find_cycles", "repository_map", "list_entries", "message_links",
]);

export class McpResponseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function responseResult(value: JsonObject): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function responseBytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(responseResult(value)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("base64url"); }

export function readResponseGeneration(repoPath: string): string | undefined {
  let store: AtlasStore;
  try { store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ERR_SQLITE_ERROR") return undefined;
    throw error;
  }
  try {
    const repository = store.findRepository(getRepositoryIdentity(repoPath));
    return repository ? `${repository.id}:${store.getActiveGenerationId(repository.id) ?? "legacy"}` : undefined;
  } finally { store.close(); }
}

const cursorSchema = z.object({
  v: z.literal(1), request: z.string(), generation: z.string(), snapshot: z.string(),
  offsets: z.record(z.string(), z.number().int().nonnegative()), expires: z.number().int(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;

function encodeCursor(cursor: Cursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

function decodeCursor(value: string, key: Buffer, now: number): Cursor {
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) throw new Error();
    const expected = createHmac("sha256", key).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (cursor.expires <= now) throw new McpResponseError("expired_cursor", "Cursor expired; restart without cursor.");
    return cursor;
  } catch (error) {
    if (error instanceof McpResponseError) throw error;
    throw new McpResponseError("invalid_cursor", "Invalid cursor; restart without cursor.");
  }
}

function excerpt(value: string, length: number): string {
  const end = value.charCodeAt(length - 1);
  return value.slice(0, end >= 0xD800 && end <= 0xDBFF ? length - 1 : length);
}

export function optimizeResponse(
  name: string, args: JsonObject, value: JsonObject, generation: string | undefined,
  key: Buffer, now = Date.now(),
): JsonObject {
  const options = responseOptionsSchema.parse(args.response);
  const sections = new Set(options.sections ?? (options.mode === "compact" ? ["relationships"] : options.mode === "focused" ? ["source", "relationships", "provenance"] : ["source", "relationships", "provenance", "stages"]));
  const { cursor: rawCursor, ...requestOptions } = options;
  const request = digest({ name, ...args, response: requestOptions });
  const currentGeneration = generation ?? "unavailable";
  const cursor = rawCursor ? decodeCursor(rawCursor, key, now) : undefined;
  if (cursor && cursor.request !== request) throw new McpResponseError("invalid_cursor", "Cursor request/options differ; restart without cursor.");
  if (cursor && cursor.generation !== currentGeneration) throw new McpResponseError("stale_cursor", "Index generation changed; restart without cursor.");
  let omittedFields = 0, filteredRelations = 0;
  const relations = new Set(options.relationKinds);
  const relationshipFields = new Set(["edge", "directImpact", "transitiveImpact", "hops", "relations", "relationships", "graphExpansion"]);
  const stageFields = new Set(["vectorResults", "lexicalResults", "fusedResults", "rerankedResults", "retrievalOnly", "withGraph", "finalContext"]);
  const project = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.filter(item => {
      const relation = item && typeof item === "object" ? (item as JsonObject).relation : undefined;
      if (options.relationKinds && typeof relation === "string" && !relations.has(relation as never)) { filteredRelations++; return false; }
      return true;
    }).map(project);
    if (!input || typeof input !== "object") return input;
    const output: JsonObject = {};
    for (const [field, item] of Object.entries(input)) {
      if (item === undefined) continue;
      if (["content", "snippet", "rendered"].includes(field) && typeof item === "string") {
        if (!sections.has("source") || (options.mode !== "full" && (field === "rendered" || (field === "snippet" && "content" in input)))) { omittedFields++; continue; }
        output[field] = options.mode === "full" ? item : excerpt(item, options.mode === "focused" ? 600 : 160);
        if (output[field] !== item) omittedFields++;
      } else if (stageFields.has(field) && !sections.has("stages")) {
        omittedFields++;
      } else if ((field === "provenance" || field === "evidence") && !sections.has("provenance")) {
        omittedFields++;
      } else if (relationshipFields.has(field) && !sections.has("relationships")) {
        omittedFields++;
      } else {
        output[field] = project(item);
      }
    }
    return output;
  };
  // Keep one primary ranking without exposing the repeated inspection stage contract.
  const source = name === "inspect_retrieval" && !sections.has("stages")
    ? { results: value.fusedResults, ...value } : value;
  const projected = project(source) as JsonObject;
  // Inspection stage timings vary per call and are not part of cursor identity.
  const { metrics: _metrics, ...snapshotValue } = projected;
  let snapshot = cursor ? digest(snapshotValue) : undefined;
  if (cursor && cursor.snapshot !== snapshot) throw new McpResponseError("stale_cursor", "Result snapshot changed; restart without cursor.");
  const collections = Object.entries(projected).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]));
  const offsets: Record<string, number> = {};
  for (const [field, items] of collections) {
    offsets[field] = cursor?.offsets[field] ?? 0;
    if (offsets[field]! > items.length) throw new McpResponseError("invalid_cursor", "Cursor position is invalid.");
  }
  const output: JsonObject = { ...projected };
  const maxBytes = Math.min(options.maxOutputBytes ?? 64_000, options.maxOutputTokens === undefined ? Infinity : options.maxOutputTokens * 4);
  const pageSize = options.pageSize ?? 100;
  const expires = cursor?.expires ?? Math.floor(now + 15 * 60_000);
  const resultCounts = typeof value.totalReturned === "number" && Array.isArray(value.results) && Array.isArray(projected.results)
    ? { beforeFilter: value.results.length, afterFilter: projected.results.length } : undefined;
  const updateMetadata = () => {
    if (resultCounts) output.totalReturned = (output.results as unknown[]).length;
    const remaining = collections.reduce((sum, [field, items]) => sum + items.length - offsets[field]!, 0);
    output.output = {
      ...(resultCounts ? { resultCounts } : {}),
      mode: options.mode, sections: [...sections], omittedFields, filteredRelations,
      truncated: remaining > 0 || omittedFields > 0 || filteredRelations > 0 || value.truncated === true,
      hasMore: remaining > 0, remainingItems: remaining,
      projectionComplete: remaining === 0 && omittedFields === 0 && filteredRelations === 0,
      retrievalTruncated: value.truncated === true,
      tokenBudgetIsEstimate: options.maxOutputTokens !== undefined,
      detailsAvailable: true, next: "cursor; mode=full; get_symbol/context_read",
      ...(remaining > 0 ? { nextCursor: encodeCursor({ v: 1, request, generation: currentGeneration, snapshot: snapshot ??= digest(snapshotValue), offsets: { ...offsets }, expires }, key) } : {}),
    };
  };
  // Whole-window responses need no continuation fingerprint or intermediate empty page.
  if (!cursor && collections.every(([, items]) => items.length <= pageSize)) {
    for (const [field, items] of collections) offsets[field] = items.length;
    updateMetadata();
    if (responseBytes(output) <= maxBytes) return output;
    for (const [field] of collections) offsets[field] = 0;
  }
  for (const [field] of collections) output[field] = [];
  updateMetadata();
  if (responseBytes(output) > maxBytes) throw new McpResponseError("output_budget_too_small", "Metadata exceeds budget; increase maxOutputBytes or use compact.");
  let admitted = 0;
  for (const [field, items] of collections) {
    const start = offsets[field]!;
    const available = Math.min(pageSize, items.length - start);
    const select = (count: number) => {
      output[field] = items.slice(start, start + count);
      offsets[field] = start + count;
      updateMetadata();
      return responseBytes(output) <= maxBytes;
    };
    if (select(available)) { admitted += available; continue; }
    let low = 0, high = available - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (select(middle)) low = middle;
      else high = middle - 1;
    }
    select(low);
    if (admitted + low === 0) throw new McpResponseError("output_budget_too_small", "First item exceeds budget; increase maxOutputBytes or use compact.");
    return output;
  }
  return output;
}
