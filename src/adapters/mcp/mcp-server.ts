import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import { canonicalRepositoryPath } from "../../core/repository/repository-identity.js";
import { loadIndexedGraphReadOnly, type IndexedGraph } from "../../core/graph/indexed-graph.service.js";
import { searchLexical } from "../../core/lexical/lexical-search.service.js";
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

const MAX_LIMIT = 1_000;
const MAX_CANDIDATES = 20;
const MAX_COMMUNITIES = 10_000;
const MAX_TEXT = 2_000;
const DEFAULT_LIMIT = 20;

const repoInput = z.string().min(1).optional();
const limitInput = z.number().int().min(1).max(MAX_LIMIT).optional();
const queryInput = z.string().min(1);
const commonInput = {
  repoPath: repoInput,
  limit: limitInput,
};

type JsonObject = Record<string, unknown>;

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
  const failure = error instanceof McpToolError
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
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
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
    version: process.env.npm_package_version ?? "1.0.0",
  });

  registerJsonTool(server, "repository_status", "Return repository identity and capability status.", z.object({
    repoPath: repoInput,
    includeOptionalCapabilities: z.boolean().optional().default(false),
  }).strict(), async (args) => {
    const repoPath = resolveRepo(args.repoPath as string | undefined);
    const providers = await optionalProviders(repoPath, args.includeOptionalCapabilities === true);
    try {
      return await getRepositoryStatus(repoPath, providers ? {
        embeddingProvider: providers.embeddingProvider,
        vectorStore: providers.vectorStore,
        rerankerProvider: providers.rerankerProvider,
      } : {});
    } finally {
      await closeProviders(providers);
    }
  });

  registerJsonTool(server, "search_code", "Search indexed code using lexical FTS5 or optional semantic fusion.", z.object({
    ...commonInput,
    query: queryInput,
    mode: z.enum(["lexical", "hybrid"]).optional().default("lexical"),
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

  registerJsonTool(server, "get_symbol", "Resolve a symbol or file in the indexed graph.", z.object({
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
    };
  }));

  const relationTools = [
    ["find_callers", findCallers, "Find callers of a resolved symbol."],
    ["find_callees", findCallees, "Find callees of a resolved symbol."],
    ["find_imports", findImports, "Find files imported by a symbol or file."],
    ["find_imported_by", findImportedBy, "Find files that import a symbol or file."],
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

  registerJsonTool(server, "impact", "Analyze the bounded callers, importers, and inheritance blast radius.", z.object({
    ...commonInput,
    query: queryInput,
    maxDepth: z.number().int().min(0).max(10).optional(),
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => ({
    ...analyzeImpact(context.graph, args.query as string, {
      maxDepth: args.maxDepth as number | undefined,
      maxResults: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    }),
    capabilityState: context.capabilityState,
  })));

  const changeSourceShape = {
    repoPath: repoInput,
    mode: z.enum(["working", "staged", "commit", "range"]).optional().default("working"),
    commit: z.string().min(1).optional(),
    base: z.string().min(1).optional(),
    head: z.string().min(1).optional(),
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
    maxDepth: z.number().int().min(0).max(10).optional(),
  }).strict().superRefine(validateChangeSource);
  registerJsonTool(server, "inspect_change", "Inspect Git changes and map changed symbols to their structural blast radius.", inspectChangeSchema, async (args) => {
    const mode = (args.mode as InspectChangeInput["mode"] | undefined) ?? "working";
    if (mode === "commit") return inspectChange(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, maxDepth: args.maxDepth as number | undefined });
    if (mode === "range") return inspectChange(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, maxDepth: args.maxDepth as number | undefined });
    return inspectChange(resolveRepo(args.repoPath as string | undefined), { mode, maxDepth: args.maxDepth as number | undefined });
  });

  const affectedTestsSchema = inspectChangeSchema.extend({
    maxTests: z.number().int().min(1).max(1_000).optional(),
  });
  registerJsonTool(server, "affected_tests", "Find tests structurally affected by Git changes and identify affected code with no indexed test evidence.", affectedTestsSchema, async (args) => {
    const mode = (args.mode as InspectChangeInput["mode"] | undefined) ?? "working";
    const options = { maxDepth: args.maxDepth as number | undefined, maxTests: args.maxTests as number | undefined };
    if (mode === "commit") return affectedTests(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options });
    if (mode === "range") return affectedTests(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options });
    return affectedTests(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
  });

  const explainIncompleteSchema = z.object({
    repoPath: repoInput,
    scope: z.enum(["repository", "change", "tests"]).optional().default("repository"),
    mode: z.enum(["working", "staged", "commit", "range"]).optional(),
    commit: z.string().min(1).optional(),
    base: z.string().min(1).optional(),
    head: z.string().min(1).optional(),
    maxDepth: z.number().int().min(0).max(10).optional(),
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
  registerJsonTool(server, "explain_incomplete", "Explain why CodeAtlas evidence may be incomplete and what should be verified directly.", explainIncompleteSchema, async (args) => explainIncomplete(resolveRepo(args.repoPath as string | undefined), {
    scope: args.scope as "repository" | "change" | "tests" | undefined,
    mode: args.mode as "working" | "staged" | "commit" | "range" | undefined,
    commit: args.commit as string | undefined,
    base: args.base as string | undefined,
    head: args.head as string | undefined,
    maxDepth: args.maxDepth as number | undefined,
  }));

  const graphDeltaSchema = z.object(changeSourceShape).strict().superRefine(validateChangeSource).extend({
    maxEdges: z.number().int().min(1).max(10_000).optional(),
  });
  registerJsonTool(server, "graph_delta", "Compare structural relationships before and after Git changes.", graphDeltaSchema, async (args) => {
    const mode = (args.mode as GraphDeltaInput["mode"] | undefined) ?? "working";
    const options = { maxEdges: args.maxEdges as number | undefined };
    if (mode === "commit") return graphDelta(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options });
    if (mode === "range") return graphDelta(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options });
    return graphDelta(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
  });

  const architectureDriftSchema = z.object({
    ...changeSourceShape,
    maxEdges: z.number().int().min(1).max(10_000).optional(),
    configPath: z.string().min(1).optional(),
  }).strict().superRefine(validateChangeSource);
  registerJsonTool(server, "architecture_drift", "Detect architectural violations and dependency cycles introduced or resolved by Git changes.", architectureDriftSchema, async (args) => {
    const mode = (args.mode as ArchitectureDriftInput["mode"] | undefined) ?? "working";
    const options = { maxEdges: args.maxEdges as number | undefined, configPath: args.configPath as string | undefined };
    if (mode === "commit") return architectureDrift(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options });
    if (mode === "range") return architectureDrift(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options });
    return architectureDrift(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
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
    if (mode === "commit") return changeGate(resolveRepo(args.repoPath as string | undefined), { mode, commit: args.commit as string, ...options });
    if (mode === "range") return changeGate(resolveRepo(args.repoPath as string | undefined), { mode, base: args.base as string, head: args.head as string, ...options });
    return changeGate(resolveRepo(args.repoPath as string | undefined), { mode, ...options });
  });

  registerJsonTool(server, "trace", "Return a bounded, directed or explanatory graph path.", z.object({
    ...commonInput,
    from: queryInput,
    to: queryInput,
    maxDepth: z.number().int().min(0).max(32).optional(),
    mode: z.enum(["directed", "explanatory"]).optional(),
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => ({
    ...traceGraph(context.graph, args.from as string, args.to as string, {
      maxDepth: args.maxDepth as number | undefined,
      mode: args.mode as "directed" | "explanatory" | undefined,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    }),
    capabilityState: context.capabilityState,
  })));

  registerJsonTool(server, "inspect_retrieval", "Inspect lexical, optional semantic, rerank, graph, and context stages.", z.object({
    ...commonInput,
    query: queryInput,
    includeSemantic: z.boolean().optional().default(false),
    includeReranker: z.boolean().optional().default(false),
    graphEnabled: z.boolean().optional(),
    tokenBudget: z.number().int().min(100).max(20_000).optional(),
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
      return compactInspection(inspection);
    } finally {
      await closeProviders(providers);
    }
  });

  registerJsonTool(server, "list_communities", "List deterministic graph communities and coupling metadata.", z.object({
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

  registerJsonTool(server, "get_community", "Return one graph community by stable identifier.", z.object({
    repoPath: repoInput,
    id: queryInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
    const result = detectCommunities(context.graph, { maxResults: MAX_COMMUNITIES, includeSingletons: true, coverage: { mayBeIncomplete: context.mayBeIncomplete } });
    const community = getCommunityById(result, args.id as string);
    if (!community) throw new McpToolError("not_found", `Community not found: ${args.id}`);
    return { community, mayBeIncomplete: result.mayBeIncomplete };
  }));

  registerJsonTool(server, "important_symbols", "Rank structurally important symbols with noise suppression signals.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => calculateImportance(context.graph, {
    limit: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
    coverage: { mayBeIncomplete: context.mayBeIncomplete },
  })));

  registerJsonTool(server, "architectural_bridges", "Find sparse cross-community architectural bridges.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => {
    const communities = detectCommunities(context.graph, { maxResults: MAX_COMMUNITIES, includeSingletons: true, coverage: { mayBeIncomplete: context.mayBeIncomplete } });
    return detectArchitecturalBridges(context.graph, communities, {
      limit: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
      coverage: { mayBeIncomplete: context.mayBeIncomplete },
    });
  }));

  registerJsonTool(server, "find_cycles", "Find bounded structural call, import, and inheritance cycles.", z.object({
    ...commonInput,
  }).strict(), async (args) => withGraph(resolveRepo(args.repoPath as string | undefined), async (context) => detectStructuralCycles(context.graph, {
    maxResults: (args.limit as number | undefined) ?? DEFAULT_LIMIT,
    coverage: { mayBeIncomplete: context.mayBeIncomplete },
  })));

  for (const [name, operation] of [["index_repository", indexRepository], ["sync_repository", syncRepository]] as const) {
    registerJsonTool(server, name, `Run the shared ${name === "index_repository" ? "full index" : "incremental sync"} pipeline.`, z.object({
      repoPath: repoInput,
      skipGit: z.boolean().optional().default(false),
      includeSemantic: z.boolean().optional().default(false),
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
