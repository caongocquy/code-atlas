import fs from "node:fs/promises";
import path from "node:path";

import { parseCodeSymbols } from "./parsers/code-parser.js";
import { getRepoId, scanRepo } from "../repository/repository-files.js";
import { canonicalRepositoryPath } from "../repository/repository-identity.js";
import {
  extractImports,
  isRelativeImport,
  resolveImportCandidates,
} from "./imports.js";
import { createGraphNodeId } from "./node-id.js";
import type { CodeGraph, GraphNodeType } from "./types.js";
import { extractImportBindings } from "./import-bindings.js";
import { extractCalls, hasParserErrors, type CallReference } from "./calls.js";
import { resolveCallResults } from "./call-resolution.js";
import { resolveMemberCallResults } from "./member-resolution.js";
import { extractExtendsFactEvidence, resolveExtendsResults } from "./extends.js";
import { emptyResolutionCoverage, mergeResolutionCoverage, type GraphResolutionFile as LegacyGraphResolutionFile } from "./resolution.types.js";
import type { ProgressReporter } from "../progress/progress.types.js";
import type { ImportBinding } from "./import-bindings.js";
import { codeChunksFromFacts, type IndexedSourceUnit } from "../indexing/indexing.types.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
import { resolveSite, type ResolutionDecision } from "./resolver/resolver.js";
import type { GenerationResolverContext } from "./resolver/generation-context.js";
import { symbolIdentityKey, type ResolutionSiteIdentity, type SourceUnitIdentity, type SymbolIdentity } from "./resolver/identities.js";
import type { SemanticEvidenceBatch, ResolverTraceEvent } from "./resolver/types.js";

function toGraphNodeType(symbolType: string): GraphNodeType | undefined {
  switch (symbolType) {
    case "function":
    case "class":
    case "method":
    case "variable":
    case "interface":
    case "type":
    case "enum":
      return symbolType;

    default:
      return undefined;
  }
}

type QualifiedChunk = {
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
};

function canOwnSymbol(symbolType: string): boolean {
  return (
    symbolType === "class" ||
    symbolType === "function" ||
    symbolType === "method" ||
    symbolType === "variable"
  );
}

function findDirectOwner(
  chunk: QualifiedChunk,
  chunks: QualifiedChunk[],
): QualifiedChunk | undefined {
  const owners = chunks.filter(
    (candidate) =>
      candidate !== chunk &&
      canOwnSymbol(candidate.symbolType) &&
      candidate.startLine <= chunk.startLine &&
      candidate.endLine >= chunk.endLine &&
      (candidate.startLine < chunk.startLine ||
        (candidate.startLine === chunk.startLine &&
          (candidate.startColumn ?? 0) <= (chunk.startColumn ?? 0))) &&
      (candidate.endLine > chunk.endLine ||
        (candidate.endLine === chunk.endLine &&
          (candidate.endColumn ?? Number.MAX_SAFE_INTEGER) >=
            (chunk.endColumn ?? Number.MIN_SAFE_INTEGER))),
  );

  if (owners.length === 0) {
    return undefined;
  }

  //
  // The smallest containing symbol is the direct owner.
  //

  return owners.sort((a, b) => {
    const aSize = a.endLine - a.startLine;

    const bSize = b.endLine - b.startLine;

    return aSize - bSize;
  })[0];
}

function buildQualifiedName(
  chunk: QualifiedChunk,
  chunks: QualifiedChunk[],
  visited: Set<QualifiedChunk>,
): string {
  if (visited.has(chunk)) {
    return chunk.symbolName;
  }

  visited.add(chunk);

  const owner = findDirectOwner(chunk, chunks);

  if (!owner) {
    return chunk.symbolName;
  }

  const ownerName = buildQualifiedName(owner, chunks, visited);

  return `${ownerName}.${chunk.symbolName}`;
}

export function getQualifiedSymbolName(
  chunk: QualifiedChunk,
  chunks: QualifiedChunk[],
): string {
  return buildQualifiedName(chunk, chunks, new Set());
}

export type GraphBuildResult = {
  graph: CodeGraph;
  resolutionByFile: Map<string, LegacyGraphResolutionFile>;
};

export type GraphResolutionFile = {
  relativePath: string;
  decisions: readonly ResolutionDecision[];
  trace: readonly ResolverTraceEvent[];
};

export type FactsGraphBuildResult = Omit<GraphBuildResult, "resolutionByFile"> & {
  resolutionByFile: Map<string, GraphResolutionFile>;
};

const emptySemanticEvidence = (): SemanticEvidenceBatch => ({
  bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [],
  parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [],
  modules: [], calls: [], diagnostics: [],
});

function sourceUnitForFacts(repositoryId: string, relativePath: string, facts: ParsedFactsBlob) {
  return { repositoryId, relativePath, language: facts.language } as const;
}

function adapterContext(context: GenerationResolverContext, sourceUnit: ReturnType<typeof sourceUnitForFacts>) {
  return {
    generationId: context.generationId,
    repositoryIdentity: context.repositoryIdentity,
    sourceUnit,
    resolutionVersion: context.resolutionVersion,
  };
}

function factsSites(facts: ParsedFactsBlob, sourceUnit: ReturnType<typeof sourceUnitForFacts>): ResolutionSiteIdentity[] {
  const ids = [
    ...facts.references.map((item) => item.localId),
    ...facts.callSites.map((item) => item.localId),
    ...facts.inheritances.map((item) => item.localId),
    ...facts.implementations.map((item) => item.localId),
  ];
  return [...new Set(ids)].map((localId) => ({ sourceUnit, localId }));
}

type FactsNormalizationInput = ParsedFactsBlob | { facts: ParsedFactsBlob; sourceUnit: SourceUnitIdentity };

function isSourceUnitIdentity(value: unknown): value is SourceUnitIdentity {
  return Boolean(value && typeof value === "object" && "repositoryId" in value && "relativePath" in value && "language" in value);
}

function repairSourceUnitIdentities(value: unknown, sourceUnit: SourceUnitIdentity): unknown {
  if (Array.isArray(value)) return value.map((item) => repairSourceUnitIdentities(item, sourceUnit));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "sourceUnit" && isSourceUnitIdentity(item)
      ? sourceUnit
      : repairSourceUnitIdentities(item, sourceUnit),
  ]));
}

export function normalizeFacts(
  facts: readonly FactsNormalizationInput[],
  context: GenerationResolverContext,
): readonly SemanticEvidenceBatch[] {
  return facts.map((input) => {
    const blob = "facts" in input ? input.facts : input;
    const sourceUnit = "facts" in input
      ? input.sourceUnit
      : sourceUnitForFacts(context.repositoryIdentity.id, "", blob);
    const adapter = context.languageRegistry.find((candidate) => candidate.languages.includes(blob.language));
    if (adapter) return repairSourceUnitIdentities(adapter.normalizeFile(blob, adapterContext(context, sourceUnit)), sourceUnit) as SemanticEvidenceBatch;

    const site = factsSites(blob, sourceUnit);
    for (const item of site) context.diagnostics.add({ site: item, status: "unsupported", reason: "language_capability_unsupported" });
    return {
      ...emptySemanticEvidence(),
      diagnostics: [{
        code: "language_capability_unsupported",
        message: `No semantic adapter registered for ${blob.language}`,
        sourceUnit,
      }],
    };
  });
}

function factsEvidenceFor(
  facts: ParsedFactsBlob,
  evidence: readonly SemanticEvidenceBatch[],
  repositoryId: string,
  relativePath: string,
  index: number,
): SemanticEvidenceBatch {
  const sourceUnit = sourceUnitForFacts(repositoryId, relativePath, facts);
  const batch = evidence[index] ?? emptySemanticEvidence();
  return repairSourceUnitIdentities(batch, sourceUnit) as SemanticEvidenceBatch;
}

export function resolveIndexedUnits(input: {
  allUnits: readonly IndexedSourceUnit[];
  resolvePaths: ReadonlySet<string>;
  evidence: readonly SemanticEvidenceBatch[];
  context: GenerationResolverContext;
  reporter?: ProgressReporter;
}): Map<string, GraphResolutionFile> {
  const result = new Map<string, GraphResolutionFile>();
  for (let index = 0; index < input.allUnits.length; index += 1) {
    const unit = input.allUnits[index];
    if (!unit) continue;
    if (!input.resolvePaths.has(unit.relativePath)) continue;
    const sourceUnit = sourceUnitForFacts(input.context.repositoryIdentity.id, unit.relativePath, unit.facts);
    const evidence = factsEvidenceFor(unit.facts, input.evidence, input.context.repositoryIdentity.id, unit.relativePath, index);
    const decisions: ResolutionDecision[] = [];
    const sites = factsSites(unit.facts, sourceUnit);
    const siteIds = new Set(sites.map((site) => site.localId));
    const existingTrace = input.context.diagnostics.snapshot().filter((event) => siteIds.has(event.site.localId));
    const before = input.context.diagnostics.snapshot().length;
    const adapterRegistered = input.context.languageRegistry.some((adapter) => adapter.languages.includes(unit.facts.language));
    if (!adapterRegistered) {
      for (const site of sites) {
        if (!input.context.diagnostics.snapshot().some((event) => event.site.localId === site.localId && event.status === "unsupported")) {
          input.context.diagnostics.add({ site, status: "unsupported", reason: "language_capability_unsupported" });
        }
        const edgeKind = unit.facts.implementations.some((item) => item.localId === site.localId) ? "implements"
          : unit.facts.inheritances.some((item) => item.localId === site.localId) ? "extends"
            : unit.facts.callSites.some((item) => item.localId === site.localId) ? "calls" : "references";
        decisions.push({ site, language: unit.facts.language, sourceUnit, edgeKind, evidenceIds: [], attemptedStrategies: [], resolutionVersion: input.context.resolutionVersion, status: "unsupported", reason: "language_capability_unsupported" });
      }
    } else {
      for (const site of sites) {
        decisions.push(resolveSite({ facts: unit.facts, evidence, environment: input.context.typeEnvironment, context: input.context }, site));
      }
    }
    result.set(unit.relativePath, canonicalResolution({
      relativePath: unit.relativePath,
      decisions,
      trace: [...existingTrace, ...input.context.diagnostics.snapshot().slice(before)],
    }));
    input.reporter?.setProgress(index + 1, input.allUnits.length);
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalUnits(units: readonly IndexedSourceUnit[]): IndexedSourceUnit[] {
  const ordered = [...units].sort((left, right) => left.relativePath.localeCompare(right.relativePath)
    || canonicalJson(left.facts).localeCompare(canonicalJson(right.facts)));
  return ordered.filter((unit, index) => index === 0 || unit.relativePath !== ordered[index - 1]?.relativePath);
}

function canonicalResolution(value: GraphResolutionFile): GraphResolutionFile {
  const decisions = [...new Map(value.decisions.map((item) => [canonicalJson(item), item])).values()]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const trace = [...new Map(value.trace.map((item) => [canonicalJson(item), item])).values()]
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return { relativePath: value.relativePath, decisions, trace };
}

function factSymbolIdentity(repositoryId: string, relativePath: string, language: ParsedFactsBlob["language"], fact: ParsedFactsBlob["symbols"][number]): SymbolIdentity {
  return {
    repositoryId,
    relativePath,
    language,
    kind: fact.kind,
    qualifiedName: fact.declaredQualifiedName ?? fact.name,
    discriminator: fact.localId,
  };
}

export function assembleFactsGraph(
  repoPath: string,
  units: readonly IndexedSourceUnit[],
  resolutionByFile: ReadonlyMap<string, GraphResolutionFile>,
  reporter?: ProgressReporter,
  repositoryId?: string,
): CodeGraph {
  const repoId = repositoryId ?? getRepoId(canonicalRepositoryPath(path.resolve(repoPath)));
  const graph: CodeGraph = { nodes: [], edges: [] };
  const canonical = canonicalUnits(units);
  const files = new Set(canonical.map((unit) => unit.relativePath));
  const fileIds = new Map<string, string>();
  const symbols = new Map<string, string>();

  for (const unit of canonical) {
    const fileId = createGraphNodeId(repoId, unit.relativePath, "file", unit.relativePath);
    fileIds.set(unit.relativePath, fileId);
    graph.nodes.push({ id: fileId, type: "file", name: unit.relativePath, file: unit.relativePath });
  }
  for (let index = 0; index < canonical.length; index += 1) {
    const unit = canonical[index];
    if (!unit) continue;
    const fileId = fileIds.get(unit.relativePath);
    if (!fileId) continue;
    const orderedSymbols = [...unit.facts.symbols].sort((left, right) => symbolIdentityKey(factSymbolIdentity(repoId, unit.relativePath, unit.facts.language, left)).localeCompare(symbolIdentityKey(factSymbolIdentity(repoId, unit.relativePath, unit.facts.language, right))));
    for (const fact of orderedSymbols) {
      const type = toGraphNodeType(fact.kind);
      if (!type) continue;
      const identity = factSymbolIdentity(repoId, unit.relativePath, unit.facts.language, fact);
      const id = createGraphNodeId(repoId, unit.relativePath, type, identity.qualifiedName);
      if (!symbols.has(symbolIdentityKey(identity)) && !graph.nodes.some((node) => node.id === id)) {
        symbols.set(symbolIdentityKey(identity), id);
        graph.nodes.push({ id, type, name: fact.name, qualifiedName: identity.qualifiedName, file: unit.relativePath, startLine: fact.range.startLine, endLine: fact.range.endLine });
        graph.edges.push({ from: fileId, to: id, type: "contains" });
      }
    }
    reporter?.setProgress(index + 1, canonical.length);
  }
  for (const unit of canonical) {
    const from = fileIds.get(unit.relativePath);
    if (!from) continue;
    const imports = [...unit.facts.imports].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    for (const item of imports) {
      if (!isRelativeImport(item.moduleSpecifier)) continue;
      const targetFile = resolveImportCandidates(unit.relativePath, item.moduleSpecifier).find((candidate) => files.has(candidate));
      const to = targetFile ? fileIds.get(targetFile) : undefined;
      if (to) graph.edges.push({ from, to, type: "imports" });
    }
  }
  for (const unit of canonical) {
    const resolution = [...resolutionByFile.values()]
      .filter((item) => item.relativePath === unit.relativePath)
      .map(canonicalResolution)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))[0];
    if (!resolution) continue;
    for (const decision of resolution.decisions) {
      if (decision.status !== "resolved") continue;
      const fact = unit.facts.symbols.find((item) => item.localId === (unit.facts.callSites.find((site) => site.localId === decision.site.localId)?.callerId
        ?? unit.facts.inheritances.find((site) => site.localId === decision.site.localId)?.subjectId
        ?? unit.facts.implementations.find((site) => site.localId === decision.site.localId)?.subjectId
        ?? unit.facts.references.find((site) => site.localId === decision.site.localId)?.ownerId));
      if (!fact) continue;
      const sourceId = symbols.get(symbolIdentityKey(factSymbolIdentity(repoId, unit.relativePath, unit.facts.language, fact)));
      const targetId = symbols.get(symbolIdentityKey(decision.target));
      if (!sourceId || !targetId) continue;
      const type = decision.edgeKind;
      if (!graph.edges.some((edge) => edge.from === sourceId && edge.to === targetId && edge.type === type)) graph.edges.push({ from: sourceId, to: targetId, type });
    }
  }
  graph.nodes = [...new Map(graph.nodes.map((node) => [node.id, node])).values()].sort((left, right) => left.id.localeCompare(right.id));
  graph.edges = [...new Map(graph.edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()]
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.type.localeCompare(right.type));
  return graph;
}

export function factsImportBindings(unit: IndexedSourceUnit, fileSet: Set<string>): ImportBinding[] {
  return unit.facts.bindingSeeds
    .filter((binding) => binding.bindingKind === "import" && binding.sourceModule && binding.importedName)
    .map((binding) => ({
      localName: binding.name,
      importedName: binding.importedName!,
      source: binding.sourceModule!,
      targetFile: resolveImportCandidates(unit.relativePath, binding.sourceModule!).find((candidate) => fileSet.has(candidate)),
    }));
}

export function factsCalls(unit: IndexedSourceUnit, chunks: ReturnType<typeof codeChunksFromFacts>): CallReference[] {
  const symbolsById = new Map(unit.facts.symbols.map((symbol) => [symbol.localId, symbol]));
  return unit.facts.callSites.map((call) => {
    const caller = call.callerId ? symbolsById.get(call.callerId) : undefined;
    const qualifiedName = caller ? getQualifiedSymbolName(chunks.find((chunk) => chunk.symbolName === caller.name && chunk.startLine === caller.range.startLine) ?? {
      symbolName: caller.name,
      symbolType: caller.kind,
      startLine: caller.range.startLine,
      endLine: caller.range.endLine,
    }, chunks) : undefined;
    const callerType = caller && (caller.kind === "function" || caller.kind === "method" || caller.kind === "variable") ? caller.kind : undefined;
    return {
      calleeName: call.calleeText.replace(/\([^()]*\)\s*$/, ""),
      callerName: caller?.name,
      callerQualifiedName: qualifiedName,
      callerType,
      callerClassName: qualifiedName?.split(".").slice(0, -1).join(".") || undefined,
      line: call.range.startLine,
    };
  });
}

async function buildCodeGraphWithResolutionFromFactsLegacy(
  repoPath: string,
  units: readonly IndexedSourceUnit[],
  reporter?: ProgressReporter,
  repositoryId?: string,
): Promise<GraphBuildResult> {
  const absoluteRepoPath = canonicalRepositoryPath(path.resolve(repoPath));
  const repoId = repositoryId ?? getRepoId(absoluteRepoPath);
  const relativeFiles = units.map((unit) => unit.relativePath);
  const fileSet = new Set(relativeFiles);
  const graph: CodeGraph = { nodes: [], edges: [] };
  const resolutionByFile = new Map<string, LegacyGraphResolutionFile>();
  const fileNodeIds = new Map<string, string>();

  for (const relativePath of relativeFiles) {
    const id = createGraphNodeId(repoId, relativePath, "file", relativePath);
    fileNodeIds.set(relativePath, id);
    graph.nodes.push({ id, type: "file", name: relativePath, file: relativePath });
  }

  const chunksByFile = new Map<string, ReturnType<typeof codeChunksFromFacts>>();
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    if (!unit) continue;
    const fileNodeId = fileNodeIds.get(unit.relativePath);
    if (!fileNodeId) continue;
    const chunks = codeChunksFromFacts(unit);
    chunksByFile.set(unit.relativePath, chunks);
    for (const chunk of chunks) {
      const nodeType = toGraphNodeType(chunk.symbolType);
      if (!nodeType) continue;
      const qualifiedName = getQualifiedSymbolName(chunk, chunks);
      const symbolNodeId = createGraphNodeId(repoId, unit.relativePath, nodeType, qualifiedName);
      graph.nodes.push({ id: symbolNodeId, type: nodeType, name: chunk.symbolName, qualifiedName, file: unit.relativePath, startLine: chunk.startLine, endLine: chunk.endLine });
      graph.edges.push({ from: fileNodeId, to: symbolNodeId, type: "contains" });
    }
    reporter?.setProgress(index + 1, units.length);
  }

  for (const unit of units) {
    const importerNodeId = fileNodeIds.get(unit.relativePath);
    if (!importerNodeId) continue;
    const seenImportSpecifiers = new Set<string>();
    for (const importReference of unit.facts.imports) {
      if (seenImportSpecifiers.has(importReference.moduleSpecifier)) continue;
      seenImportSpecifiers.add(importReference.moduleSpecifier);
      if (!isRelativeImport(importReference.moduleSpecifier)) continue;
      const targetFile = resolveImportCandidates(unit.relativePath, importReference.moduleSpecifier).find((candidate) => fileSet.has(candidate));
      const targetNodeId = targetFile ? fileNodeIds.get(targetFile) : undefined;
      if (targetNodeId) graph.edges.push({ from: importerNodeId, to: targetNodeId, type: "imports" });
    }
  }

  for (const unit of units) {
    const chunks = chunksByFile.get(unit.relativePath) ?? [];
    const bindings = factsImportBindings(unit, fileSet);
    const calls = factsCalls(unit, chunks);
    const callResults = resolveCallResults(graph, unit.relativePath, calls, bindings);
    const memberResults = calls.some((call) => call.calleeName.includes("."))
      ? resolveMemberCallResults(graph, unit.relativePath, unit.source, calls, bindings, true)
      : { edges: [], results: [], coverage: emptyResolutionCoverage() };
    const extendsResults = /\bextends\b/.test(unit.source)
      ? resolveExtendsResults(graph, unit.relativePath, unit.source, bindings, extractExtendsFactEvidence(unit.source))
      : { edges: [], results: [], coverage: emptyResolutionCoverage() };
    graph.edges.push(...callResults.edges, ...memberResults.edges, ...extendsResults.edges);
    const coverage = mergeResolutionCoverage(mergeResolutionCoverage(callResults.coverage, memberResults.coverage), extendsResults.coverage);
    coverage.parserErrors = unit.facts.parseStatus === "deterministic_partial" ? 1 : 0;
    coverage.mayBeIncomplete = coverage.parserErrors > 0 || coverage.unsupportedDynamic > 0 || coverage.unresolvedCalls > 0 || coverage.ambiguousCalls > 0 || coverage.unresolvedExtends > 0 || coverage.ambiguousExtends > 0;
    resolutionByFile.set(unit.relativePath, {
      coverage,
      diagnostics: [...callResults.results, ...memberResults.results, ...extendsResults.results]
        .filter((result): result is Exclude<typeof result, { kind: "resolved" }> => result.kind !== "resolved"),
    });
  }

  return { graph, resolutionByFile };
}

export function buildCodeGraphWithResolutionFromFacts(
  repoPath: string,
  units: readonly IndexedSourceUnit[],
  reporter: ProgressReporter | undefined,
  repositoryId: string | undefined,
  resolutionPaths: readonly string[] | undefined,
  context: GenerationResolverContext,
): Promise<FactsGraphBuildResult>;
export function buildCodeGraphWithResolutionFromFacts(
  repoPath: string,
  units: IndexedSourceUnit[],
  reporter?: ProgressReporter,
  repositoryId?: string,
): Promise<GraphBuildResult>;
export async function buildCodeGraphWithResolutionFromFacts(
  repoPath: string,
  units: readonly IndexedSourceUnit[],
  reporter?: ProgressReporter,
  repositoryId?: string,
  resolutionPaths?: readonly string[],
  context?: GenerationResolverContext,
): Promise<GraphBuildResult | FactsGraphBuildResult> {
  if (!context) return buildCodeGraphWithResolutionFromFactsLegacy(repoPath, units, reporter, repositoryId);
  const canonical = canonicalUnits(units);
  const evidence = normalizeFacts(canonical.map((unit) => ({
    facts: unit.facts,
    sourceUnit: sourceUnitForFacts(context.repositoryIdentity.id, unit.relativePath, unit.facts),
  })), context);
  const resolutionByFile = resolveIndexedUnits({
    allUnits: canonical,
    resolvePaths: new Set(resolutionPaths ?? canonical.map((unit) => unit.relativePath)),
    evidence,
    context,
    reporter,
  });
  const graph = assembleFactsGraph(repoPath, canonical, resolutionByFile, reporter, repositoryId);
  return { graph, resolutionByFile };
}

export async function buildCodeGraphWithResolution(
  repoPath: string,
  reporter?: ProgressReporter,
  repositoryId?: string,
  sourceFiles?: string[],
): Promise<GraphBuildResult> {
  const absoluteRepoPath = canonicalRepositoryPath(path.resolve(repoPath));

  const repoId = repositoryId ?? getRepoId(absoluteRepoPath);

  const files = sourceFiles ?? await scanRepo(absoluteRepoPath);

  const relativeFiles = files.map((filePath) =>
    path.relative(absoluteRepoPath, filePath),
  );

  const fileSet = new Set(relativeFiles);

  const graph: CodeGraph = {
    nodes: [],
    edges: [],
  };
  const resolutionByFile = new Map<string, LegacyGraphResolutionFile>();

  const fileNodeIds = new Map<string, string>();

  //
  // Pass 1:
  // Build file nodes.
  //

  for (const relativePath of relativeFiles) {
    const fileNodeId = createGraphNodeId(
      repoId,
      relativePath,
      "file",
      relativePath,
    );

    fileNodeIds.set(relativePath, fileNodeId);

    graph.nodes.push({
      id: fileNodeId,
      type: "file",
      name: relativePath,
      file: relativePath,
    });
  }

  //
  // Pass 2:
  // Build symbol nodes + contains edges.
  //

  for (let index = 0; index < files.length; index += 1) {
    const filePath = files[index];

    if (!filePath) {
      continue;
    }

    const relativePath = path.relative(absoluteRepoPath, filePath);

    const fileNodeId = fileNodeIds.get(relativePath);

    if (!fileNodeId) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");

    const chunks = parseCodeSymbols(source, relativePath);

    for (const chunk of chunks) {
      const nodeType = toGraphNodeType(chunk.symbolType);

      if (!nodeType) {
        continue;
      }

      const qualifiedName = getQualifiedSymbolName(chunk, chunks);

      const symbolNodeId = createGraphNodeId(
        repoId,
        relativePath,
        nodeType,
        qualifiedName,
      );

      graph.nodes.push({
        id: symbolNodeId,
        type: nodeType,
        name: chunk.symbolName,
        qualifiedName,
        file: relativePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });

      graph.edges.push({
        from: fileNodeId,
        to: symbolNodeId,
        type: "contains",
      });
    }

    reporter?.setProgress(index + 1, files.length);
  }

  //
  // Pass 3:
  // Build import edges.
  //

  for (const filePath of files) {
    const relativePath = path.relative(absoluteRepoPath, filePath);

    const importerNodeId = fileNodeIds.get(relativePath);

    if (!importerNodeId) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");

    const imports = extractImports(source);

    for (const importReference of imports) {
      if (!isRelativeImport(importReference.source)) {
        continue;
      }

      const candidates = resolveImportCandidates(
        relativePath,
        importReference.source,
      );

      const targetFile = candidates.find((candidate) => fileSet.has(candidate));

      if (!targetFile) {
        continue;
      }

      const targetNodeId = fileNodeIds.get(targetFile);

      if (!targetNodeId) {
        continue;
      }

      graph.edges.push({
        from: importerNodeId,
        to: targetNodeId,
        type: "imports",
      });
    }
  }
  //
  // Pass 4:
  // Build call edges.
  //

  for (const filePath of files) {
    const relativePath = path.relative(absoluteRepoPath, filePath);

    const source = await fs.readFile(filePath, "utf8");

    const bindings = extractImportBindings(source, relativePath, fileSet);

    const calls = extractCalls(source, relativePath);

    const callResults = resolveCallResults(graph, relativePath, calls, bindings);
    const memberResults = resolveMemberCallResults(
      graph,
      relativePath,
      source,
      calls,
      bindings,
    );

    const extendsResults = resolveExtendsResults(graph, relativePath, source, bindings);
    graph.edges.push(...callResults.edges, ...memberResults.edges, ...extendsResults.edges);
    const coverage = mergeResolutionCoverage(
      mergeResolutionCoverage(callResults.coverage, memberResults.coverage),
      extendsResults.coverage,
    );
    coverage.parserErrors = hasParserErrors(source, relativePath) ? 1 : 0;
    coverage.mayBeIncomplete = coverage.parserErrors > 0 || coverage.unsupportedDynamic > 0 || coverage.unresolvedCalls > 0 || coverage.ambiguousCalls > 0 || coverage.unresolvedExtends > 0 || coverage.ambiguousExtends > 0;
    resolutionByFile.set(relativePath, {
      coverage,
      diagnostics: [...callResults.results, ...memberResults.results, ...extendsResults.results]
        .filter((result): result is Exclude<typeof result, { kind: "resolved" }> => result.kind !== "resolved"),
    });
  }
  return { graph, resolutionByFile };
}

export async function buildCodeGraph(
  repoPath: string,
  reporter?: ProgressReporter,
  repositoryId?: string,
  sourceFiles?: string[],
): Promise<CodeGraph> {
  return (await buildCodeGraphWithResolution(repoPath, reporter, repositoryId, sourceFiles)).graph;
}
