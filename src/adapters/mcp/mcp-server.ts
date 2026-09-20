import path from "node:path";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import { canonicalRepositoryPath } from "../../core/repository/repository-identity.js";
import { loadIndexedGraphReadOnly, type IndexedGraph } from "../../core/graph/indexed-graph.service.js";
import { searchLexical } from "../../core/lexical/lexical-search.service.js";
import { inspectHybridSearch } from "../../core/retrieval/hybrid-search.service.js";
import {
  indexRepository,
  syncRepository,
} from "../../core/indexing/index-pipeline.service.js";
import {
  inspectRetrieval,
  type InspectorChunk,
  type RetrievalInspection,
} from "../../core/retrieval/retrieval-inspector.service.js";
import { resolveGraphEntity } from "../../core/graph/query/graph-query-entity-resolver.js";
import {
  findCallers,
  findCallees,
  findImports,
  findImportedBy,
} from "../../core/graph/query/graph-query.service.js";
import { analyzeImpact } from "../../core/graph/query/impact.service.js";
import { traceGraph } from "../../core/graph/query/trace.service.js";
import { calculateImportance } from "../../core/graph/intelligence/importance.service.js";
import {
  detectArchitecturalBridges,
} from "../../core/graph/intelligence/bridges.service.js";
import {
  detectCommunities,
  getCommunityById,
} from "../../core/graph/intelligence/communities.service.js";
import { detectStructuralCycles } from "../../core/graph/intelligence/cycles.service.js";
import { inspectChange } from "../../core/change/inspect-change.service.js";
import type { InspectChangeInput } from "../../core/change/change.types.js";
import { affectedTests } from "../../core/change/affected-tests.service.js";
import type { DefaultProviderSet } from "../../infrastructure/provider-defaults.js";
import { explainIncomplete } from "../../core/diagnostics/explain-incomplete.service.js";
import { graphDelta } from "../../core/change/graph-delta.service.js";
import type { GraphDeltaInput } from "../../core/change/graph-delta.types.js";
import { architectureDrift } from "../../core/architecture/architecture-drift.service.js";
import type { ArchitectureDriftInput } from "../../core/architecture/architecture-drift.types.js";
import { changeGate } from "../../core/gate/change-gate.service.js";
import type { ChangeGateInput } from "../../core/gate/change-gate.types.js";
import { readContextAware } from "../../core/context/context-aware-read.service.js";
import { CONTEXT_AWARE_SOURCE_PROJECTION } from "../../core/context/context-delivery-preparation.js";
import { compileTaskContextForRepository, TaskContextRepositoryCompilerError } from "../../core/context/task-context-repository-compiler.js";
import { closeTaskContext, refreshTaskContext, startTaskContext } from "../../core/context/task-context-lifecycle.service.js";
import { TaskContextLifecycleDomainError } from "../../core/context/task-context-lifecycle.types.js";

const MAX_LIMIT = 1_000;
const MAX_CANDIDATES = 20;
const MAX_COMMUNITIES = 10_000;
const MAX_TEXT = 2_000;
const DEFAULT_LIMIT = 20;
const DEFAULT_DETAIL_LIMIT = 20;
const packageJson = createRequire(import.meta.url)("../../../package.json") as { version: string };

const repoInput = z.string().min(1).describe("Local repository path; defaults to the server working directory.").optional();
const limitInput = z.number().int().min(1).max(MAX_LIMIT).optional();
const queryInput = z.string().min(1);
const commonInput = {
  repoPath: repoInput,
  limit: limitInput,
  detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional().default("compact"),
};

type JsonObject = Record<string, unknown>;
export type McpDetail = "compact" | "full";

type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const readOnlyAnnotations: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const localWriteAnnotations: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const toolAnnotations: Record<string, McpToolAnnotations> = {
  repository_status: localWriteAnnotations,
  search_code: localWriteAnnotations,
  get_symbol: readOnlyAnnotations,
  context_read: localWriteAnnotations,
  compile_task_context: localWriteAnnotations,
  start_task_context: localWriteAnnotations,
  refresh_task_context: localWriteAnnotations,
  close_task_context: { ...localWriteAnnotations, idempotentHint: true },
  find_callers: readOnlyAnnotations,
  find_callees: readOnlyAnnotations,
  find_imports: readOnlyAnnotations,
  find_imported_by: readOnlyAnnotations,
  impact: readOnlyAnnotations,
  inspect_change: readOnlyAnnotations,
  affected_tests: readOnlyAnnotations,
  explain_incomplete: readOnlyAnnotations,
  graph_delta: readOnlyAnnotations,
  architecture_drift: readOnlyAnnotations,
  change_gate: readOnlyAnnotations,
  trace: readOnlyAnnotations,
  inspect_retrieval: localWriteAnnotations,
  list_communities: readOnlyAnnotations,
  get_community: readOnlyAnnotations,
  important_symbols: readOnlyAnnotations,
  architectural_bridges: readOnlyAnnotations,
  find_cycles: readOnlyAnnotations,
  index_repository: localWriteAnnotations,
  sync_repository: localWriteAnnotations,
};

class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message);
  }
}

function resolveRepo(repoPath?: string): string {
  return canonicalRepositoryPath(path.resolve(repoPath ?? process.cwd()));
}

function errorResult(error: unknown): CallToolResult {
  const failure = error instanceof TaskContextLifecycleDomainError
    ? { code: error.operationError.code, message: error.operationError.message, details: error.operationError }
    : error instanceof McpToolError
    ? { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
    : { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
  const value = { error: failure };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function jsonResult(value: unknown): CallToolResult {
  const structuredContent = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent,
  };
}

function registerJsonTool(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodType,
  handler: (args: JsonObject) => Promise<unknown>,
): void {
  server.registerTool(name, { description, inputSchema: schema, annotations: toolAnnotations[name] }, async (args) => {
    try {
      return jsonResult(await handler(args as JsonObject));
    } catch (error) {
      return errorResult(error);
    }
  });
}

async function lexicalStatus(repoPath: string) {
  const status = await getRepositoryStatus(repoPath);
  if (status.capabilities.lexical.state === "not_configured" || status.capabilities.lexical.state === "not_indexed") {
    throw new McpToolError("index_required", "Repository lexical index is not ready.", {
      repositoryPath: repoPath,
      next: "Call index_repository or sync_repository first.",
    });
  }
  return status;
}

async function withGraph<T>(
  repoPath: string,
  callback: (context: IndexedGraph) => Promise<T>,
): Promise<T> {
  let graph: IndexedGraph;
  try {
    graph = await loadIndexedGraphReadOnly(repoPath);
  } catch (error) {
    if (error instanceof Error && error.message === "Repository graph is not indexed.") {
      throw new McpToolError("index_required", error.message, {
        repositoryPath: repoPath,
        next: "Call index_repository or sync_repository first.",
      });
    }
    throw error;
  }
  return callback(graph);
}

function bounded(value: string | undefined, max = MAX_TEXT): string | undefined {
  if (value === undefined || value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated]`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sortedBounded<T>(items: T[], limit: number, key: (item: T) => unknown): { items: T[]; omitted: number } {
  const sorted = [...items].sort((a, b) => stableJson(key(a)).localeCompare(stableJson(key(b))));
  return { items: sorted.slice(0, limit), omitted: Math.max(0, sorted.length - limit) };
}

function withOmissions<T extends JsonObject>(value: T, omitted: Record<string, number>): T & { truncated?: true; omitted?: Record<string, number>; detailsAvailable?: true } {
  const actual = Object.fromEntries(Object.entries(omitted).filter(([, count]) => count > 0));
  return Object.keys(actual).length === 0
    ? value
    : { ...value, truncated: true, omitted: actual, detailsAvailable: true };
}

function projectDiagnostics(diagnostics: JsonObject, limit: number): JsonObject {
  const gaps = Array.isArray(diagnostics.gaps) ? sortedBounded(diagnostics.gaps, limit, (item) => stableJson(item)).items.map((gap) => {
    if (!gap || typeof gap !== "object") return gap;
    const projected = { ...(gap as JsonObject) };
    const nestedOmitted: Record<string, number> = {};
    for (const field of ["files", "symbols", "details"] as const) {
      if (!Array.isArray(projected[field])) continue;
      const nested = sortedBounded(projected[field] as unknown[], limit, (item) => item);
      projected[field] = nested.items;
      if (nested.omitted > 0) nestedOmitted[field] = nested.omitted;
    }
    return Object.keys(nestedOmitted).length === 0 ? projected : { ...projected, truncated: true, omitted: nestedOmitted, detailsAvailable: true };
  }) : diagnostics.gaps;
  const verificationTargets = Array.isArray(diagnostics.verificationTargets)
    ? sortedBounded(diagnostics.verificationTargets, limit, (item) => stableJson(item)).items
    : diagnostics.verificationTargets;
  const reasons = Array.isArray(diagnostics.reasons)
    ? sortedBounded(diagnostics.reasons, limit, (item) => item).items
    : diagnostics.reasons;
  const omitted: Record<string, number> = {};
  if (Array.isArray(diagnostics.gaps)) omitted.gaps = (diagnostics.gaps as unknown[]).length - (gaps as unknown[]).length;
  if (Array.isArray(diagnostics.verificationTargets)) omitted.verificationTargets = (diagnostics.verificationTargets as unknown[]).length - (verificationTargets as unknown[]).length;
  if (Array.isArray(diagnostics.reasons)) omitted.reasons = (diagnostics.reasons as unknown[]).length - (reasons as unknown[]).length;
  return withOmissions({ ...diagnostics, gaps, verificationTargets, reasons }, omitted);
}

function projectNestedArray(value: unknown, field: string, limit: number): unknown {
  if (!Array.isArray(value)) return value;
  const boundedItems = sortedBounded(value, limit, (item) => item);
  return boundedItems.omitted > 0
    ? { items: boundedItems.items, truncated: true, omitted: { [field]: boundedItems.omitted }, detailsAvailable: true }
    : boundedItems.items;
}

export function projectInspectChangeResponse<T extends JsonObject>(result: T, detail: McpDetail = "compact", limit = DEFAULT_DETAIL_LIMIT): T & JsonObject {
  if (detail === "full") return result;
  const omitted: Record<string, number> = {};
  const output = { ...result } as JsonObject;
  for (const field of ["files", "changedSymbols", "affectedSymbols", "affectedFiles"] as const) {
    const items = result[field];
    if (Array.isArray(items)) {
      const boundedItems = sortedBounded(items, limit, (item) => item);
      output[field] = boundedItems.items;
      omitted[field] = boundedItems.omitted;
    }
  }
  if (Array.isArray(output.files)) {
    output.files = output.files.map((file) => {
      if (!file || typeof file !== "object") return file;
      const projected = { ...(file as JsonObject) };
      projected.hunks = projectNestedArray(projected.hunks, "hunks", limit);
      return projected;
    });
  }
  if (result.diagnostics && typeof result.diagnostics === "object") {
    output.diagnostics = projectDiagnostics(result.diagnostics as JsonObject, limit);
  }
  return withOmissions(output, omitted) as T & JsonObject;
}

export function projectAffectedTestsResponse<T extends JsonObject>(result: T, detail: McpDetail = "compact", limit = DEFAULT_DETAIL_LIMIT): T & JsonObject {
  if (detail === "full") return result;
  const omitted: Record<string, number> = {};
  const output = { ...result } as JsonObject;
  for (const field of ["tests", "changedTests", "uncoveredAffectedSymbols", "uncoveredAffectedFiles"] as const) {
    const items = result[field];
    if (Array.isArray(items)) {
      const boundedItems = sortedBounded(items, limit, (item) => item);
      output[field] = boundedItems.items;
      omitted[field] = boundedItems.omitted;
    }
  }
  if (Array.isArray(output.tests)) {
    output.tests = output.tests.map((item) => {
      if (!item || typeof item !== "object") return item;
      const test = { ...(item as JsonObject) };
      test.testSymbols = projectNestedArray(test.testSymbols, "testSymbols", limit);
      test.reasons = projectNestedArray(test.reasons, "reasons", limit);
      return test;
    });
  }
  if (result.diagnostics && typeof result.diagnostics === "object") {
    output.diagnostics = projectDiagnostics(result.diagnostics as JsonObject, limit);
  }
  return withOmissions(output, omitted) as T & JsonObject;
}

export function projectMcpResponse<T extends JsonObject>(result: T, detail: McpDetail = "compact", limit = DEFAULT_DETAIL_LIMIT): T & JsonObject {
  if (detail === "full") return result;
  const output = { ...result } as JsonObject;
  const omitted: Record<string, number> = {};
  for (const field of [
    "addedEdges", "removedEdges", "introduced", "resolved", "checks", "verificationTargets",
    "communities", "coupling", "bridges", "cycles", "items", "results",
  ]) {
    const items = result[field];
    if (!Array.isArray(items)) continue;
    const boundedItems = sortedBounded(items, limit, (item) => item);
    output[field] = boundedItems.items;
    omitted[field] = boundedItems.omitted;
  }
  if (result.diagnostics && typeof result.diagnostics === "object") {
    output.diagnostics = projectDiagnostics(result.diagnostics as JsonObject, limit);
  }
  return withOmissions(output, omitted) as T & JsonObject;
}

function compactChunk(chunk: InspectorChunk): JsonObject {
  return {
    key: chunk.key,
    source: chunk.source,
    file: chunk.file,
    symbolName: chunk.symbolName,
    symbolType: chunk.symbolType,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: bounded(chunk.content),
    score: chunk.score,
    vectorScore: chunk.vectorScore,
    lexicalScore: chunk.lexicalScore,
    fusionScore: chunk.fusionScore,
    rerankScore: chunk.rerankScore,
    vectorRank: chunk.vectorRank,
    lexicalRank: chunk.lexicalRank,
    fusionRank: chunk.fusionRank,
    rerankRank: chunk.rerankRank,
    provenance: chunk.provenance,
  };
}

export function projectRetrievalInspectionResponse(inspection: RetrievalInspection, detail: McpDetail = "compact", limit = DEFAULT_DETAIL_LIMIT): JsonObject {
  if (detail === "full") return compactInspection(inspection);
  const omitted: Record<string, number> = {};
  const seen = new Set<string>();
  const stage = (name: string, items: InspectorChunk[]) => {
    const unique = items.filter((item) => {
      if (seen.has(item.key)) { omitted.duplicateChunks = (omitted.duplicateChunks ?? 0) + 1; return false; }
      seen.add(item.key);
      return true;
    });
    const boundedItems = sortedBounded(unique, limit, (item) => item.key);
    omitted[name] = (omitted[name] ?? 0) + boundedItems.omitted;
    return boundedItems.items.map(compactChunk);
  };
  const compactContext = (context: RetrievalInspection["retrievalOnly"]) => ({
    chunks: stage("contextChunks", context.chunks),
    dropped: stage("dropped", context.dropped),
    tokens: context.tokens,
    budget: context.budget,
    rendered: bounded(context.rendered, 20_000),
  });
  const graphDetails = inspection.graphExpansion.details.filter((detail) => {
    if (seen.has(detail.node.key)) { omitted.duplicateChunks = (omitted.duplicateChunks ?? 0) + 1; return false; }
    seen.add(detail.node.key);
    return true;
  });
  const boundedGraphDetails = sortedBounded(graphDetails, limit, (detail) => detail.node.key);
  omitted.graphDetails = boundedGraphDetails.omitted;
  return withOmissions({
    query: inspection.query,
    repoId: inspection.repoId,
    options: inspection.options,
    vectorResults: stage("vectorResults", inspection.vectorResults),
    lexicalResults: stage("lexicalResults", inspection.lexicalResults),
    fusedResults: stage("fusedResults", inspection.fusedResults),
    rerankedResults: stage("rerankedResults", inspection.rerankedResults),
    graphExpansion: {
      ...inspection.graphExpansion,
      details: boundedGraphDetails.items.map((detail) => ({ ...detail, node: compactChunk(detail.node) })),
    },
    retrievalOnly: compactContext(inspection.retrievalOnly),
    withGraph: compactContext(inspection.withGraph),
    finalContext: compactContext(inspection.finalContext),
    metrics: inspection.metrics,
    capabilities: inspection.capabilities,
  }, omitted);
}

function compactInspection(inspection: RetrievalInspection): JsonObject {
  const compactContext = (context: RetrievalInspection["retrievalOnly"]) => ({
    chunks: context.chunks.map(compactChunk),
    dropped: context.dropped.map(compactChunk),
    tokens: context.tokens,
    budget: context.budget,
    rendered: bounded(context.rendered, 20_000),
  });
  return {
    query: inspection.query,
    repoId: inspection.repoId,
    options: inspection.options,
    vectorResults: inspection.vectorResults.map(compactChunk),
    lexicalResults: inspection.lexicalResults.map(compactChunk),
    fusedResults: inspection.fusedResults.map(compactChunk),
    rerankedResults: inspection.rerankedResults.map(compactChunk),
    graphExpansion: {
      ...inspection.graphExpansion,
      details: inspection.graphExpansion.details.map((detail) => ({
        ...detail,
        node: compactChunk(detail.node),
      })),
    },
    retrievalOnly: compactContext(inspection.retrievalOnly),
    withGraph: compactContext(inspection.withGraph),
    finalContext: compactContext(inspection.finalContext),
    metrics: inspection.metrics,
    capabilities: inspection.capabilities,
  };
}

function relationResult(
  context: IndexedGraph,
  resolution: ReturnType<typeof resolveGraphEntity>,
  relations: ReturnType<typeof findCallers>,
  limit: number,
): JsonObject {
  if (resolution.status !== "resolved") {
    return {
      status: resolution.status,
      query: resolution.query,
      candidates: resolution.candidates.slice(0, MAX_CANDIDATES),
      capabilityState: context.capabilityState,
      mayBeIncomplete: context.mayBeIncomplete,
    };
  }
  const items = relations.slice(0, limit);
  return {
    status: "resolved",
    target: resolution.entity,
    results: items,
    totalReturned: items.length,
    truncated: relations.length > limit,
    limit,
    capabilityState: context.capabilityState,
    mayBeIncomplete: context.mayBeIncomplete,
    ...(context.framework?.reliability ? { reliability: context.framework.reliability } : {}),
  };
}

const locks = new Map<string, Promise<void>>();

async function withWriteLock<T>(repoPath: string, callback: () => Promise<T>): Promise<T> {
  const previous = locks.get(repoPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(repoPath, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (locks.get(repoPath) === current) locks.delete(repoPath);
  }
}

async function optionalProviders(repoPath: string, enabled: boolean): Promise<DefaultProviderSet | undefined> {
  if (!enabled) return undefined;
  const { createDefaultProviders } = await import("../../infrastructure/provider-defaults.js");
  return createDefaultProviders(repoPath);
}

async function closeProviders(providers: DefaultProviderSet | undefined): Promise<void> {
  if (providers && "close" in providers.vectorStore && typeof providers.vectorStore.close === "function") {
    providers.vectorStore.close();
  }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "code-atlas",
    version: packageJson.version,
  });

  registerJsonTool(server, "repository_status", "Check repository index and capability readiness when availability or freshness is unknown.", z.object({
    repoPath: repoInput,
    detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional().default("compact"),
    includeOptionalCapabilities: z.boolean().describe("Initialize only currently configured local optional capabilities before reporting status.").optional().default(false),
  }).strict(), async (args) => {
    const repoPath = resolveRepo(args.repoPath as string | undefined);
    const providers = await optionalProviders(repoPath, args.includeOptionalCapabilities === true);
    try {
      const result = await getRepositoryStatus(repoPath, providers ? {
        embeddingProvider: providers.embeddingProvider,
        vectorStore: providers.vectorStore,
        rerankerProvider: providers.rerankerProvider,
      } : {});
      return projectMcpResponse(result as unknown as JsonObject, args.detail as McpDetail | undefined);
    } finally {
      await closeProviders(providers);
    }
  });

  registerJsonTool(server, "search_code", "Find matching code in the indexed repository; use get_symbol when the symbol is already known.", z.object({
    ...commonInput,
    query: queryInput,
    mode: z.enum(["lexical", "hybrid"]).describe("lexical uses FTS5; hybrid requests semantic fusion but this MCP server has no embedding provider wired, so it falls back to lexical-only with semanticState not_configured.").optional().default("lexical"),
    filePrefix: z.string().min(1).optional(),
  }).strict(), async (args) => {
    const repoPath = resolveRepo(args.repoPath as string | undefined);
    const status = await lexicalStatus(repoPath);
    const limit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
    const query = args.query as string;
    if (args.mode !== "hybrid") {
      const results = await searchLexical(query, limit + 1, repoPath, args.filePrefix as string | undefined);
      return {
        mode: "lexical",
        query,
        results: results.slice(0, limit),
        truncated: results.length > limit,
        limit,
        capabilityState: status.capabilities.lexical.state,
        mayBeIncomplete: status.capabilities.lexical.state === "stale",
      };
    }

    const providers = await optionalProviders(repoPath, true);
    try {
      const { inspectHybridSearch } = await import("../../core/retrieval/hybrid-search.service.js");
      const stages = await inspectHybridSearch(query, limit, repoPath, {
        embeddingProvider: providers!.embeddingProvider,
        vectorStore: providers!.vectorStore,
      });
      return {
        mode: "hybrid",
        query,
        results: stages.fusedResults,
        vectorResults: stages.vectorResults,
        lexicalResults: stages.lexicalResults,
        semanticState: stages.semanticState,
        limit,
        capabilityState: status.capabilities.lexical.state,
        mayBeIncomplete: status.capabilities.lexical.state === "stale",
      };
    } finally {
      await closeProviders(providers);
    }
  });

  registerJsonTool(server, "get_symbol", "Retrieve one known symbol or file from the indexed graph.", z.object({
    ...commonInput,
    query: queryInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
    const resolution = resolveGraphEntity(context.graph, args.query as string);
    return {
      ...resolution,
      candidates: resolution.candidates.slice(0, MAX_CANDIDATES),
      candidateCount: resolution.candidates.length,
      candidatesTruncated: resolution.candidates.length > MAX_CANDIDATES,
      capabilityState: context.capabilityState,
      mayBeIncomplete: context.mayBeIncomplete,
      ...(context.framework?.reliability ? { reliability: context.framework.reliability } : {}),
    };
  }));

  registerJsonTool(server, "context_read", "Safely read and deliver a selected file while recording the context delivery.", z.object({
    repoPath: repoInput,
    file: z.string().min(1),
    sessionId: z.string().min(1).describe("Lifecycle session identifier for the exact context state."),
    contextGeneration: z.string().min(1).describe("Published context generation to read from the lifecycle state."),
  }).strict(), async (args) => readContextAware(resolveRepo(args.repoPath as string | undefined), {
    sessionId: args.sessionId as string,
    contextGeneration: args.contextGeneration as string,
    subject: { kind: "file", path: args.file as string },
    projection: CONTEXT_AWARE_SOURCE_PROJECTION,
  }));

  registerJsonTool(server, "compile_task_context", "Assemble bounded task evidence; use search_code for matching-code lookup and context_read to deliver a selected file.", z.object({
    task: z.string().min(1),
    repoPath: repoInput,
    anchors: z.array(z.union([
      z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("symbol"), path: z.string().min(1).optional(), name: z.string().min(1) }).strict(),
    ])).describe("Known file or symbol anchors that seed task evidence.").optional(),
    changedPaths: z.array(z.string().min(1)).describe("Known changed paths to include as task evidence.").optional(),
    budget: z.object({ maxItems: z.number().int().positive().optional(), maxEstimatedTokens: z.number().int().positive().optional() }).strict().optional(),
    detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional(),
  }).strict(), async (args) => {
    const repoPath = resolveRepo(args.repoPath as string | undefined);
    try {
      return await compileTaskContextForRepository(repoPath, {
      task: args.task as string,
      repoPath,
      anchors: args.anchors as never,
      changedPaths: args.changedPaths as string[] | undefined,
      budget: args.budget as { maxItems?: number; maxEstimatedTokens?: number } | undefined,
      detail: args.detail as "compact" | "full" | undefined,
      });
    } catch (error) {
      if (error instanceof TaskContextRepositoryCompilerError && error.code === "index_required") throw new McpToolError("index_required", error.message, { repositoryPath: repoPath, next: "Call index_repository or sync_repository first." });
      throw error;
    }
  });

  const lifecycleAnchor = z.union([
    z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("symbol"), path: z.string().min(1).optional(), name: z.string().min(1) }).strict(),
  ]);
  registerJsonTool(server, "start_task_context", "Create a durable task context lifecycle and publish initial evidence for a task.", z.object({
    repoPath: repoInput,
    task: z.string().min(1),
    anchors: z.array(lifecycleAnchor).describe("Known file or symbol anchors that seed the lifecycle evidence.").optional(),
    budget: z.object({ maxItems: z.number().int().positive().optional(), maxEstimatedTokens: z.number().int().positive().optional() }).strict().optional(),
    ttlSeconds: z.number().int().positive().optional(),
    detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional(),
  }).strict(), async (args) => {
    try { return await startTaskContext({ task: args.task as string, anchors: args.anchors as never, budget: args.budget as never, ttlSeconds: args.ttlSeconds as number | undefined, detail: args.detail as "compact" | "full" | undefined }, { repositoryPath: resolveRepo(args.repoPath as string | undefined) }); }
    catch (error) { if (error instanceof TaskContextLifecycleDomainError && error.operationError.code === "compiler_validation_failed" && error.operationError.message === "Repository graph is not indexed.") throw new McpToolError("index_required", error.operationError.message, { repositoryPath: resolveRepo(args.repoPath as string | undefined), next: "Call index_repository or sync_repository first." }); throw error; }
  });
  registerJsonTool(server, "refresh_task_context", "Refresh a known task context lifecycle and publish a new generation.", z.object({ repoPath: repoInput, taskContextId: z.string().min(1).describe("Task context lifecycle identifier to refresh."), budget: z.object({ maxItems: z.number().int().positive().optional(), maxEstimatedTokens: z.number().int().positive().optional() }).strict().optional(), detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional() }).strict(), async (args) => refreshTaskContext({ taskContextId: args.taskContextId as string, budget: args.budget as never, detail: args.detail as "compact" | "full" | undefined }, { repositoryPath: resolveRepo(args.repoPath as string | undefined) }));
  registerJsonTool(server, "close_task_context", "Close a known task context lifecycle; repeated close requests have no further effect.", z.object({ repoPath: repoInput, taskContextId: z.string().min(1).describe("Task context lifecycle identifier to close.") }).strict(), async (args) => closeTaskContext({ taskContextId: args.taskContextId as string }, { repositoryPath: resolveRepo(args.repoPath as string | undefined) }));

  const relationTools = [
    ["find_callers", findCallers, "Find symbols that call into a known target; use impact for the wider structural blast radius."],
    ["find_callees", findCallees, "Find symbols called from a known source; use impact for the wider structural blast radius."],
    ["find_imports", findImports, "Find files a target imports from; use find_imported_by for the reverse import direction."],
    ["find_imported_by", findImportedBy, "Find files whose imports reference the target; use find_imports for the reverse direction."],
  ] as const;
  for (const [name, relation, description] of relationTools) {
    registerJsonTool(server, name, description, z.object({
      ...commonInput,
      query: queryInput,
    }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
      const limit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
      const resolution = resolveGraphEntity(context.graph, args.query as string);
      const relations = resolution.status === "resolved" ? relation(context.graph, resolution.entity, limit + 1) : [];
      return relationResult(context, resolution, relations, limit);
    }));
  }

  registerJsonTool(server, "impact", "Analyze a structural blast radius across callers, importers, and inheritance; use a find_* tool for one single relation.", z.object({
    ...commonInput,
    query: queryInput,
    maxDepth: z.number().int().min(0).max(10).describe("Bound structural traversal depth for the blast-radius analysis.").optional(),
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => ({
    ...analyzeImpact(context.graph, args.query as string, {
      maxDepth: args.maxDepth as number | undefined,
      maxResults: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    }),
    capabilityState: context.capabilityState,
    ...(context.framework?.reliability ? { reliability: context.framework.reliability } : {}),
  })));

  const changeSourceShape = {
    repoPath: repoInput,
    detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional().default("compact"),
    mode: z.enum(["working", "staged", "commit", "range"]).describe("working and staged inspect local snapshots; commit requires commit; range requires base and head.").optional().default("working"),
    commit: z.string().min(1).describe("Commit revision required when mode is commit.").optional(),
    base: z.string().min(1).describe("Base revision required when mode is range.").optional(),
    head: z.string().min(1).describe("Head revision required when mode is range.").optional(),
  };
  function validateChangeSource(value: { mode?: string; commit?: string; base?: string; head?: string }, context: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void }): void {
    const mode = value.mode ?? "working";
    const has = (name: "commit" | "base" | "head") => value[name] !== undefined;
    if (mode === "commit" && !has("commit")) context.addIssue({ code: "custom", path: ["commit"], message: "commit is required for commit mode" });
    if (mode === "range" && (!has("base") || !has("head"))) context.addIssue({ code: "custom", path: ["base"], message: "base and head are required for range mode" });
    if (mode !== "commit" && has("commit")) context.addIssue({ code: "custom", path: ["commit"], message: "commit is only valid in commit mode" });
    if (mode !== "range" && (has("base") || has("head"))) context.addIssue({ code: "custom", path: ["base"], message: "base and head are only valid in range mode" });
  }
  const inspectChangeSchema = z.object({
    ...changeSourceShape,
    maxDepth: z.number().int().min(0).max(10).describe("Bound structural traversal depth while mapping changed-symbol impact.").optional(),
  }).strict().superRefine(validateChangeSource);
  registerJsonTool(server, "inspect_change", "Inspect Git changes and map changed symbols to their structural blast radius.", inspectChangeSchema, async (args) => {
    const detail = args.detail as McpDetail | undefined;
    const mode = (args.mode as InspectChangeInput["mode"] | undefined) ?? "working";
    const result = mode === "commit"
      ? await inspectChange(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, maxDepth: args.maxDepth as number | undefined })
      : mode === "range"
        ? await inspectChange(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, maxDepth: args.maxDepth as number | undefined })
        : await inspectChange(resolveRepo(args.repoPath as string | undefined), { mode, maxDepth: args.maxDepth as number | undefined });
    return projectInspectChangeResponse(result as unknown as JsonObject, detail);
  });

  const affectedTestsSchema = inspectChangeSchema.extend({
    maxTests: z.number().int().min(1).max(1_000).optional(),
  });
  registerJsonTool(server, "affected_tests", "Find tests structurally affected by Git changes and identify affected code with no indexed test evidence.", affectedTestsSchema, async (args) => {
    const detail = args.detail as McpDetail | undefined;
    const mode = (args.mode as InspectChangeInput["mode"] | undefined) ?? "working";
    const options = { maxDepth: args.maxDepth as number | undefined, maxTests: args.maxTests as number | undefined };
    const result = mode === "commit"
      ? await affectedTests(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options })
      : mode === "range"
        ? await affectedTests(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options })
        : await affectedTests(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
    return projectAffectedTestsResponse(result as unknown as JsonObject, detail);
  });

  const explainIncompleteSchema = z.object({
    repoPath: repoInput,
    detail: z.enum(["compact", "full"]).describe("compact returns bounded output; full returns all available details.").optional().default("compact"),
    scope: z.enum(["repository", "change", "tests"]).describe("Explain repository-wide evidence, one change, or affected tests; change-source fields apply only to change or tests scope.").optional().default("repository"),
    mode: z.enum(["working", "staged", "commit", "range"]).describe("Choose working-tree or staged changes, one commit, or a revision range; commit requires commit, and range requires base and head.").optional(),
    commit: z.string().min(1).describe("Commit revision required for commit mode; valid only with change or tests scope.").optional(),
    base: z.string().min(1).describe("Base revision required for range mode; range mode also requires head and is valid only with change or tests scope.").optional(),
    head: z.string().min(1).describe("Head revision required for range mode; range mode also requires base and is valid only with change or tests scope.").optional(),
    maxDepth: z.number().int().min(0).max(10).describe("Bound change or test traversal when the selected scope uses a change source.").optional(),
  }).strict().superRefine((value, context) => {
    const mode = value.mode ?? "working";
    const has = (name: "commit" | "base" | "head") => value[name] !== undefined;
    if (value.scope === "repository" && (value.mode || has("commit") || has("base") || has("head") || value.maxDepth !== undefined)) {
      context.addIssue({ code: "custom", path: ["scope"], message: "change source options require change or tests scope" });
    }
    if (value.scope !== "repository" && mode === "commit" && !has("commit")) context.addIssue({ code: "custom", path: ["commit"], message: "commit is required for commit mode" });
    if (value.scope !== "repository" && mode === "range" && (!has("base") || !has("head"))) context.addIssue({ code: "custom", path: ["base"], message: "base and head are required for range mode" });
    if (value.scope !== "repository" && mode !== "commit" && has("commit")) context.addIssue({ code: "custom", path: ["commit"], message: "commit is only valid in commit mode" });
    if (value.scope !== "repository" && mode !== "range" && (has("base") || has("head"))) context.addIssue({ code: "custom", path: ["base"], message: "base and head are only valid in range mode" });
  });
  registerJsonTool(server, "explain_incomplete", "Explain why CodeAtlas evidence may be incomplete and what should be verified directly.", explainIncompleteSchema, async (args) => projectMcpResponse(await explainIncomplete(resolveRepo(args.repoPath as string | undefined), {
    scope: args.scope as "repository" | "change" | "tests" | undefined,
    mode: args.mode as "working" | "staged" | "commit" | "range" | undefined,
    commit: args.commit as string | undefined,
    base: args.base as string | undefined,
    head: args.head as string | undefined,
    maxDepth: args.maxDepth as number | undefined,
  }), args.detail as McpDetail | undefined));

  const graphDeltaSchema = z.object(changeSourceShape).strict().superRefine(validateChangeSource).extend({
    maxEdges: z.number().int().min(1).max(10_000).optional(),
  });
  registerJsonTool(server, "graph_delta", "Compare structural relationships before and after Git changes.", graphDeltaSchema, async (args) => {
    const mode = (args.mode as GraphDeltaInput["mode"] | undefined) ?? "working";
    const options = { maxEdges: args.maxEdges as number | undefined };
    const result = mode === "commit"
      ? await graphDelta(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options })
      : mode === "range"
        ? await graphDelta(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options })
        : await graphDelta(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
    return projectMcpResponse(result as unknown as JsonObject, args.detail as McpDetail | undefined);
  });

  const architectureDriftSchema = z.object({
    ...changeSourceShape,
    maxEdges: z.number().int().min(1).max(10_000).optional(),
    configPath: z.string().min(1).optional(),
  }).strict().superRefine(validateChangeSource);
  registerJsonTool(server, "architecture_drift", "Detect architectural violations and dependency cycles introduced or resolved by Git changes.", architectureDriftSchema, async (args) => {
    const mode = (args.mode as ArchitectureDriftInput["mode"] | undefined) ?? "working";
    const options = { maxEdges: args.maxEdges as number | undefined, configPath: args.configPath as string | undefined };
    const result = mode === "commit"
      ? await architectureDrift(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options })
      : mode === "range"
        ? await architectureDrift(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options })
        : await architectureDrift(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
    return projectMcpResponse(result as unknown as JsonObject, args.detail as McpDetail | undefined);
  });

  const changeGateSchema = z.object({
    ...changeSourceShape,
    maxDepth: z.number().int().min(0).max(10).optional(),
    maxTests: z.number().int().min(1).max(1_000).optional(),
    maxEdges: z.number().int().min(1).max(10_000).optional(),
  }).strict().superRefine(validateChangeSource);
  registerJsonTool(server, "change_gate", "Evaluate Git changes against the repository's deterministic CodeAtlas Change Gate policy.", changeGateSchema, async (args) => {
    const mode = (args.mode as ChangeGateInput["mode"] | undefined) ?? "working";
    const options = {
      maxDepth: args.maxDepth as number | undefined,
      maxTests: args.maxTests as number | undefined,
      maxEdges: args.maxEdges as number | undefined,
    };
    const result = mode === "commit"
      ? await changeGate(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options })
      : mode === "range"
        ? await changeGate(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options })
        : await changeGate(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
    return projectMcpResponse(result as unknown as JsonObject, args.detail as McpDetail | undefined);
  });

  registerJsonTool(server, "trace", "Follow a graph path between two known endpoints; use impact to inspect a broader blast radius.", z.object({
    ...commonInput,
    from: queryInput,
    to: queryInput,
    maxDepth: z.number().int().min(0).max(32).describe("Bound graph path traversal depth.").optional(),
    mode: z.enum(["directed", "explanatory"]).describe("directed follows edge direction; explanatory may traverse inverse edges to explain a relation.").optional(),
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => ({
    ...traceGraph(context.graph, args.from as string, args.to as string, {
      maxDepth: args.maxDepth as number | undefined,
      mode: args.mode as "directed" | "explanatory" | undefined,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    }),
    capabilityState: context.capabilityState,
    ...(context.framework?.reliability ? { reliability: context.framework.reliability } : {}),
  })));

  registerJsonTool(server, "inspect_retrieval", "Diagnose retrieval stages and ranking; use search_code for default matching-code retrieval.", z.object({
    ...commonInput,
    query: queryInput,
    includeSemantic: z.boolean().describe("Request semantic-stage diagnostics; this MCP server has no embedding provider wired, so semantic retrieval is not_configured.").optional().default(false),
    includeReranker: z.boolean().describe("Request reranker-stage diagnostics; this MCP server has no reranker provider wired, so reranking is unavailable.").optional().default(false),
    graphEnabled: z.boolean().describe("Enable or disable graph expansion during retrieval inspection.").optional(),
    tokenBudget: z.number().int().min(100).max(20_000).describe("Cap the estimated context tokens returned by inspection.").optional(),
  }).strict(), async (args) => {
    const repoPath = resolveRepo(args.repoPath as string | undefined);
    const providers = await optionalProviders(repoPath, args.includeSemantic === true || args.includeReranker === true);
    try {
      const inspection = await inspectRetrieval(args.query as string, {
        repoPath,
        topK: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
        graphEnabled: args.graphEnabled as boolean | undefined,
        tokenBudget: args.tokenBudget as number | undefined,
        providers: providers ? {
          embeddingProvider: args.includeSemantic === true ? providers.embeddingProvider : undefined,
          vectorStore: args.includeSemantic === true ? providers.vectorStore : undefined,
          rerankerProvider: args.includeReranker === true ? providers.rerankerProvider : undefined,
        } : undefined,
      });
      return projectRetrievalInspectionResponse(inspection, args.detail as McpDetail | undefined, (args.limit as number | undefined) ?? DEFAULT_LIMIT);
    } finally {
      await closeProviders(providers);
    }
  });

  registerJsonTool(server, "list_communities", "Discover graph communities and coupling metadata; use get_community to expand one known community.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
    const result = detectCommunities(context.graph, {
      maxResults: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
      includeSingletons: true,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    });
    return {
      communities: result.communities,
      coupling: result.coupling.slice(0, (args.limit as number | undefined) ?? DEFAULT_LIMIT),
      couplingTruncated: result.coupling.length > ((args.limit as number | undefined) ?? DEFAULT_LIMIT),
      totalCommunities: result.totalCommunities,
      largestCommunitySize: result.largestCommunitySize,
      crossCommunityEdgeCount: result.crossCommunityEdgeCount,
      truncated: result.truncated,
      mayBeIncomplete: result.mayBeIncomplete,
    };
  }));

  registerJsonTool(server, "get_community", "Expand one known graph community by stable identifier; use list_communities to discover identifiers.", z.object({
    repoPath: repoInput,
    id: queryInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
    const result = detectCommunities(context.graph, { maxResults: MAX_COMMUNITIES, includeSingletons: true, coverage: { mayBeIncomplete: context.mayBeIncomplete } });
    const community = getCommunityById(result, args.id as string);
    if (!community) throw new McpToolError("not_found", `Community not found: ${args.id}`);
    return { community, mayBeIncomplete: result.mayBeIncomplete };
  }));

  registerJsonTool(server, "important_symbols", "Rank structurally important symbols; use get_symbol to retrieve one known symbol.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => calculateImportance(context.graph, {
    limit: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
    coverage: { mayBeIncomplete: context.mayBeIncomplete },
  })));

  registerJsonTool(server, "architectural_bridges", "Find sparse links between graph communities; use list_communities to discover the groups.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
    const communities = detectCommunities(context.graph, { maxResults: MAX_COMMUNITIES, includeSingletons: true, coverage: { mayBeIncomplete: context.mayBeIncomplete } });
    return detectArchitecturalBridges(context.graph, communities, {
      limit: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    });
  }));

  registerJsonTool(server, "find_cycles", "Report bounded structural call, import, and inheritance cycles.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => detectStructuralCycles(context.graph, {
    maxResults: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
    coverage: { mayBeIncomplete: context.mayBeIncomplete },
  })));

  for (const [name, operation] of [["index_repository", indexRepository], ["sync_repository", syncRepository]] as const) {
    registerJsonTool(server, name, `${name === "index_repository" ? "Build" : "Synchronize"} the local generated index state; this does not modify source files or Git data.`, z.object({
      repoPath: repoInput,
      skipGit: z.boolean().describe("Skip read-only Git candidate discovery during indexing.").optional().default(false),
      includeSemantic: z.boolean().describe("Request semantic indexing; this MCP server has no embedding provider wired, so semantic is not-configured only when no active semantic capability exists; an active semantic capability makes the operation fail closed.").optional().default(false),
    }).strict(), async (args) => {
      const repoPath = resolveRepo(args.repoPath as string | undefined);
      return withWriteLock(repoPath, async () => {
        const providers = await optionalProviders(repoPath, args.includeSemantic === true);
        try {
          const outcome = await operation(repoPath, {
            skipGit: args.skipGit === true,
            includeSemantic: args.includeSemantic === true,
            semanticProviders: providers?.embeddingProvider ? {
              embeddingProvider: providers.embeddingProvider,
              vectorStore: providers.vectorStore,
            } : undefined,
          });
          if (outcome.kind === "failed") {
            throw new McpToolError("index_failed", outcome.failure.message, {
              activeGenerationId: outcome.activeGenerationId,
              failure: outcome.failure,
            });
          }
          return outcome;
        } finally {
          await closeProviders(providers);
        }
      });
    });
  }

  return server;
}

export async function runMcpServer(): Promise<void> {
  if (isInteractiveMcpSession()) {
    process.stderr.write(`${MCP_INTERACTIVE_NOTICE}\n`);
    await waitForInteractiveStop();
    return;
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    process.stderr.write(`CodeAtlas MCP transport error: ${error.message}\n`);
  };
  await server.connect(transport);
}

export function isInteractiveMcpSession(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

export const MCP_INTERACTIVE_NOTICE = [
  "CodeAtlas MCP Server",
  "✓ Ready",
  "",
  "Transport   stdio",
  "",
  "This command is intended to be launched by an MCP client",
  "such as Codex, OpenCode, or Claude Code.",
  "",
  "For manual testing use an MCP inspector.",
  "Press Ctrl+C to stop.",
].join("\n");

async function waitForInteractiveStop(): Promise<void> {
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const onSigint = () => {
      clearInterval(keepAlive);
      process.exitCode = 130;
      resolve();
    };
    process.once("SIGINT", onSigint);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
