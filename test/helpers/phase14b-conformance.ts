import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import type { ResolverDiagnostic } from "../../src/core/diagnostics/coverage-diagnostics.types.js";
import { getLanguageFactExtractor } from "../../src/core/facts/language-fact-extractor.js";
import type { ParsedFactsBlob } from "../../src/core/facts/facts.types.js";
import { getSemanticAdapter } from "../../src/core/graph/resolver/adapter-registry.js";
import { isSymbolIdentityKey, symbolIdentityKey, type ResolutionSiteIdentity, type SymbolIdentity } from "../../src/core/graph/resolver/identities.js";
import type { ResolutionDecision } from "../../src/core/graph/resolver/resolver.js";
import type { LanguageId } from "../../src/core/graph/parsers/types.js";
import { compareEvidence, MAX_COMPACT_EVIDENCE, type CompactEvidence } from "../../src/core/graph/resolver/provenance.js";
import type { SemanticEvidenceBatch } from "../../src/core/graph/resolver/types.js";
import {
  factExtractorInput,
  parserFixtures,
  runFixtureThroughResolver,
  targetLanguages,
  type LanguageFixtureCase,
  type LanguageFixtureDefinition,
  type LanguageFixtureResult,
} from "./phase14b-language-fixtures.js";

export type Phase14bExpectedFixture = {
  normalizedEdges: readonly NormalizedEdge[];
  decisions: readonly Record<string, unknown>[];
  diagnostics: readonly Record<string, unknown>[];
  mayBeIncomplete: boolean;
};

export type FixtureResult = LanguageFixtureResult & {
  normalizedEdges: readonly unknown[];
  diagnostics: readonly ResolverDiagnostic[];
  counters: Readonly<Record<string, number>>;
  mayBeIncomplete: boolean;
  expected: Phase14bExpectedFixture;
};

export type ParallelFixtureResult = {
  language: LanguageId;
  startedAt: number;
  finishedAt: number;
  projection: {
    decisions: readonly Record<string, unknown>[];
    edges: readonly unknown[];
    diagnostics: readonly Record<string, unknown>[];
    mayBeIncomplete: boolean;
  };
};

type ParallelWorkerData = {
  kind: "phase14b-conformance";
  language: LanguageId;
  barrier: SharedArrayBuffer;
};

type ParallelWorkerMessage =
  | ({ kind: "result" } & ParallelFixtureResult)
  | { kind: "error"; message: string; stack?: string };

type FixtureMetadata = {
  language?: string;
  languages?: readonly string[];
  requiredFacts?: readonly string[];
  resolverCases?: Readonly<Record<string, string>>;
  parseStatus?: readonly string[];
  execution?: { sourceFallback?: boolean };
  imports?: readonly string[];
  ownership?: readonly string[];
  extensionOwnership?: string;
  uncertain?: readonly string[];
  unsupported?: readonly string[];
};

export type NormalizedEdge = {
  type: string;
  sourceLogicalIdentity: string;
  targetLogicalIdentity: string;
  strategy: string;
  confidence: "exact" | "strong";
  resolutionVersion: string;
  evidence: readonly CompactEvidence[];
};

function assertFixtureMetadata(name: string, metadata: FixtureMetadata): void {
  const language = metadata.language;
  const languages = metadata.languages ?? (language ? [language] : []);
  if (languages.length > 0 && !languages.includes(name)) throw new Error(`Phase14B expected fixture language mismatch for ${name}`);
  if (!metadata.requiredFacts?.length && !metadata.imports?.length && !metadata.ownership?.length && !metadata.extensionOwnership && !metadata.uncertain?.length && !metadata.unsupported?.length) throw new Error(`Phase14B expected fixture has no declared contract for ${name}`);
  if (metadata.execution?.sourceFallback === true) throw new Error(`Phase14B fixture enables source fallback for ${name}`);
  if (metadata.parseStatus && metadata.parseStatus.length === 0) throw new Error(`Phase14B expected fixture has no parse status for ${name}`);
}

export async function loadPhase14bExpectedFixture(name: string): Promise<Phase14bExpectedFixture> {
  if (!(targetLanguages as readonly string[]).includes(name)) throw new Error(`unknown Phase14B conformance fixture: ${name}`);
  const metadataUrl = new URL(`../fixtures/phase14b/${name}/expected.json`, import.meta.url);
  const metadata = JSON.parse(await readFile(metadataUrl, "utf8")) as FixtureMetadata & Partial<Phase14bExpectedFixture>;
  assertFixtureMetadata(name, metadata);
  if (!Array.isArray(metadata.normalizedEdges) || !Array.isArray(metadata.decisions) || !Array.isArray(metadata.diagnostics) || typeof metadata.mayBeIncomplete !== "boolean") {
    throw new Error(`malformed Phase14B conformance expectation for ${name}`);
  }
  for (const edge of metadata.normalizedEdges) validateExpectedEdge(edge, name);
  for (const decision of metadata.decisions) {
    const status = decision && typeof decision === "object" ? decision.status : undefined;
    if (!decision || typeof decision !== "object" || !["resolved", "ambiguous", "unknown", "unsupported", "budget_exhausted"].includes(status as string) || decision.language !== name || typeof decision.edgeKind !== "string" || typeof decision.resolutionVersion !== "string" || (status === "resolved" && (typeof decision.strategy !== "string" || (decision.confidence !== "exact" && decision.confidence !== "strong") || typeof decision.targetLogicalIdentity !== "string" || !isSymbolIdentityKey(decision.targetLogicalIdentity))) || (status !== "resolved" && typeof decision.reason !== "string")) {
      throw new Error(`malformed Phase14B decision expectation for ${name}`);
    }
  }
  for (const diagnostic of metadata.diagnostics) {
    if (!diagnostic || typeof diagnostic !== "object" || !["resolved", "ambiguous", "unknown", "unsupported", "budgetExhausted", "weakEvidenceDropped", "candidateOverflow"].includes(diagnostic.kind as string) || diagnostic.language !== name || typeof diagnostic.file !== "string" || !Number.isInteger(diagnostic.count) || diagnostic.count < 1) {
      throw new Error(`malformed Phase14B diagnostic expectation for ${name}`);
    }
  }
  return { normalizedEdges: metadata.normalizedEdges, decisions: metadata.decisions, diagnostics: metadata.diagnostics, mayBeIncomplete: metadata.mayBeIncomplete };
}

function validateExpectedEdge(value: unknown, name: string): asserts value is NormalizedEdge {
  if (!value || typeof value !== "object") throw new Error(`malformed Phase14B edge expectation for ${name}`);
  const edge = value as Partial<NormalizedEdge>;
  if (!["calls", "references", "extends", "implements"].includes(edge.type as string) || typeof edge.sourceLogicalIdentity !== "string" || !isSymbolIdentityKey(edge.sourceLogicalIdentity) || typeof edge.targetLogicalIdentity !== "string" || !isSymbolIdentityKey(edge.targetLogicalIdentity) || typeof edge.strategy !== "string" || (edge.confidence !== "exact" && edge.confidence !== "strong") || typeof edge.resolutionVersion !== "string" || !Array.isArray(edge.evidence) || edge.evidence.length === 0 || edge.evidence.length > MAX_COMPACT_EVIDENCE) {
    throw new Error(`malformed Phase14B edge expectation for ${name}`);
  }
  for (const evidence of edge.evidence) {
    if (!evidence || typeof evidence !== "object" || typeof evidence.kind !== "string" || typeof evidence.sourceUnit !== "string" || typeof evidence.evidenceId !== "string" || !Number.isInteger(evidence.startLine) || !Number.isInteger(evidence.endLine)) {
      throw new Error(`malformed Phase14B edge evidence expectation for ${name}`);
    }
  }
}

function conformanceSource(language: LanguageId): string {
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
      return "class Service { refresh() {} } const local = new Service(); local.refresh();\n";
    case "python":
      return "class Service:\n    total: int = 0\n    def read(self) -> int:\n        return self.total\n\ndef use(item: Service) -> Service:\n    local = Service()\n    local.read()\n    return item\n";
    case "rust":
      return "struct Thing;\nimpl Thing { fn get(&self) {} }\nfn main() { let item = Thing; item.get(); }\n";
    case "swift":
      return "class Widget { func run() {} }\nfunc use() { let widget = Widget(); widget.run() }\n";
    case "dart":
      return "class Worker { void run() {} }\nvoid main() { final worker = Worker(); worker.run(); }\n";
    case "c":
      return "int add(int value) { return value; }\nint main(void) { return add(1); }\n";
    case "cpp":
      return "int add(int value) { return value; }\nint main() { return add(1); }\n";
    case "java":
    case "kotlin":
    case "go":
      return parserFixtures[language].cases[0]!.source;
  }
}

function conformanceCase(language: LanguageId): LanguageFixtureCase {
  if (language === "java" || language === "kotlin" || language === "go") return parserFixtures[language].cases[0]!;
  const extension: Readonly<Record<LanguageId, string>> = {
    typescript: ".ts", tsx: ".tsx", javascript: ".js", python: ".py", java: ".java", kotlin: ".kt",
    go: ".go", rust: ".rs", swift: ".swift", dart: ".dart", c: ".c", cpp: ".cpp",
  };
  return { language, filePath: `phase14b/conformance/main${extension[language]}`, source: conformanceSource(language), };
}

function sourceUnit(language: LanguageId, filePath: string) {
  return { repositoryId: "phase14b-fixtures", relativePath: filePath, language } as const;
}

function siteFor(language: LanguageId, facts: ParsedFactsBlob, filePath: string): readonly ResolutionSiteIdentity[] {
  const sourceUnitIdentity = sourceUnit(language, filePath);
  if (language === "go") {
    const sites = ["s.Read", "r.Dispatch"].flatMap((callee) => {
      const item = facts.callSites.find((candidate) => candidate.calleeText === callee);
      return item ? [{ sourceUnit: sourceUnitIdentity, localId: item.localId }] : [];
    });
    if (sites.length === 2) return sites;
  }
  if (language === "kotlin") {
    const inheritance = facts.inheritances.find((item) => item.relationKind === "extends");
    const extension = facts.implementations.find((item) => item.relationKind === "extension");
    const overload = facts.callSites.find((item) => item.calleeText.includes(".run"));
    return [inheritance && { sourceUnit: sourceUnitIdentity, localId: inheritance.localId }, extension && { sourceUnit: sourceUnitIdentity, localId: extension.localId }, overload && { sourceUnit: sourceUnitIdentity, localId: overload.localId }].filter((item): item is ResolutionSiteIdentity => Boolean(item));
  }
  if (language === "rust") {
    const member = facts.members.find((item) => item.ownerSymbolId);
    return member ? [{ sourceUnit: sourceUnitIdentity, localId: member.localId }] : [];
  }
  const semantic = language === "java"
    ? facts.members.find((item) => item.memberName === "value") ?? facts.members[0]
    : language === "typescript" || language === "tsx" || language === "javascript" || language === "python" || language === "swift" || language === "dart"
      ? facts.members[0] ?? facts.callSites.find((item) => !item.calleeText.includes("new "))
      : facts.callSites[0] ?? facts.members[0] ?? facts.inheritances[0] ?? facts.implementations[0] ?? facts.references[0];
  return semantic ? [{ sourceUnit: sourceUnitIdentity, localId: semantic.localId }] : [];
}

function sourceIdentityForSite(facts: ParsedFactsBlob, site: ResolutionSiteIdentity, evidence?: SemanticEvidenceBatch): SymbolIdentity | undefined {
  const localId = facts.callSites.find((item) => item.localId === site.localId)?.callerId
    ?? facts.inheritances.find((item) => item.localId === site.localId)?.subjectId
    ?? facts.implementations.find((item) => item.localId === site.localId)?.subjectId
    ?? facts.members.find((item) => item.localId === site.localId)?.ownerSymbolId
    ?? facts.references.find((item) => item.localId === site.localId)?.ownerId;
  const symbol = facts.symbols.find((item) => item.localId === localId);
  if (symbol) return {
    repositoryId: site.sourceUnit.repositoryId,
    relativePath: site.sourceUnit.relativePath,
    language: site.sourceUnit.language,
    kind: symbol.kind,
    qualifiedName: symbol.declaredQualifiedName ?? symbol.name,
    discriminator: symbol.localId,
  };
  const memberEvidence = evidence?.members.find((item) => item.evidenceId.endsWith(`member:${site.localId}`));
  return memberEvidence?.ownerType.kind === "known" ? memberEvidence.ownerType.symbol : undefined;
}

function evidenceCount(batch: LanguageFixtureResult["resolverState"]["evidence"][number]): number {
  return Object.values(batch).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);
}

function diagnosticKind(code: string): ResolverDiagnostic["kind"] {
  if (code.includes("unsupported") || code.includes("compiler") || code.includes("framework") || code.includes("preprocessor")) return "unsupported";
  if (code.includes("ambigu")) return "ambiguous";
  return "unknown";
}

export function normalizeDecision(decision: ResolutionDecision): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    status: decision.status,
    language: decision.language,
    sourceUnit: decision.sourceUnit,
    edgeKind: decision.edgeKind,
    strategy: "strategy" in decision ? decision.strategy : undefined,
    confidence: "confidence" in decision ? decision.confidence : undefined,
    targetLogicalIdentity: "target" in decision ? symbolIdentityKey(decision.target) : undefined,
    candidateLogicalIdentities: "candidates" in decision ? decision.candidates.map((candidate) => symbolIdentityKey(candidate)) : undefined,
    reason: "reason" in decision ? decision.reason : undefined,
    attemptedStrategies: decision.attemptedStrategies,
    evidenceIds: decision.evidenceIds,
    resolutionVersion: decision.resolutionVersion,
  }).filter(([, value]) => value !== undefined));
}

function resolverDiagnostic(decision: ResolutionDecision, file: string): ResolverDiagnostic {
  const kind: ResolverDiagnostic["kind"] = decision.status === "budget_exhausted"
    ? "budgetExhausted"
    : decision.status === "weak_evidence_dropped"
      ? "weakEvidenceDropped"
      : decision.status === "candidate_overflow"
        ? "candidateOverflow"
        : decision.status;
  return {
    kind,
    language: decision.language,
    file,
    strategy: decision.strategy,
    edgeKind: decision.edgeKind === "references" ? undefined : decision.edgeKind,
    count: 1,
    reason: "reason" in decision ? decision.reason : undefined,
  };
}

export function normalizeDiagnostic(diagnostic: ResolverDiagnostic): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    kind: diagnostic.kind,
    language: diagnostic.language,
    file: diagnostic.file,
    strategy: diagnostic.strategy,
    edgeKind: diagnostic.edgeKind,
    count: diagnostic.count,
    reason: diagnostic.reason,
  }).filter(([, value]) => value !== undefined));
}

function fixtureProjection(result: FixtureResult): ParallelFixtureResult["projection"] {
  return {
    decisions: result.decisions.map(normalizeDecision),
    edges: result.normalizedEdges,
    diagnostics: result.diagnostics.map(normalizeDiagnostic),
    mayBeIncomplete: result.mayBeIncomplete,
  };
}

function compactEvidence(
  decision: ResolutionDecision,
  evidence: LanguageFixtureResult["resolverState"]["evidence"],
): readonly CompactEvidence[] {
  const ids = new Set(decision.evidenceIds);
  return evidence.flatMap((batch) => Object.values(batch).flatMap((items) => Array.isArray(items) ? items : []))
    .filter((item): item is { kind: string; evidenceId: string; sourceUnit: { repositoryId: string; relativePath: string; language: string }; range: { startLine: number; endLine: number } } => Boolean(item && typeof item === "object" && "evidenceId" in item && ids.has(item.evidenceId as never)))
    .map((item) => ({
      kind: item.kind,
      sourceUnit: `${item.sourceUnit.repositoryId}:${item.sourceUnit.relativePath}:${item.sourceUnit.language}`,
      startLine: item.range.startLine,
      endLine: item.range.endLine,
      evidenceId: item.evidenceId,
    }))
    .sort(compareEvidence)
    .slice(0, MAX_COMPACT_EVIDENCE);
}

const warmResolverStates = new Map<string, LanguageFixtureResult["resolverState"]>();

export async function runPhase14bFixture(
  name: string,
  options: { memoMode?: "cold" | "warm"; parallel?: boolean } = {},
): Promise<FixtureResult> {
  const language = name as LanguageId;
  if (!(targetLanguages as readonly string[]).includes(name)) throw new Error(`unknown Phase14B conformance fixture: ${name}`);
  const extractor = getLanguageFactExtractor(language);
  const adapter = getSemanticAdapter(language);
  if (!extractor) throw new Error(`missing fact extractor for ${language}`);
  if (!adapter) throw new Error(`missing semantic adapter for ${language}`);
  const item = conformanceCase(language);
  const outcome = extractor.extract(factExtractorInput(item));
  if (outcome.kind !== "facts") throw new Error(`fact extraction failed for ${item.filePath}: ${outcome.kind}`);
  const sites = siteFor(language, outcome.facts, item.filePath);
  const expected = await loadPhase14bExpectedFixture(name);
  const fixture: LanguageFixtureDefinition = { name: `conformance-${name}`, cases: [item], sites, expectedDecisionStatuses: expected.decisions.map((decision) => decision.status as ResolutionDecision["status"]) };
  const resolverState = options.memoMode === "warm" ? warmResolverStates.get(name) : undefined;
  const result = await runFixtureThroughResolver(fixture, [outcome.facts], adapter, options.memoMode, options.parallel, resolverState);
  for (const decision of result.decisions) {
    if (decision.status === "resolved" && (!decision.strategy || !decision.confidence || !decision.target)) throw new Error(`resolved ${name} decision lacks complete provenance fields`);
  }
  const diagnostics = result.decisions.map((decision) => resolverDiagnostic(decision, item.filePath)).concat(
    result.resolverState.evidence.flatMap((batch) => batch.diagnostics.map((diagnostic) => ({
      kind: diagnosticKind(diagnostic.code), language, file: item.filePath, count: 1, reason: diagnostic.message,
    }))),
  );
  const normalizedEdges = result.decisions.flatMap((decision, index) => {
    if (decision.status !== "resolved" || !decision.edgeKind) return [];
    const source = sourceIdentityForSite(outcome.facts, sites[index]!, result.resolverState.evidence[index]);
    if (!source) throw new Error(`resolved ${name} decision has no logical source identity`);
    return [{ type: decision.edgeKind, sourceLogicalIdentity: symbolIdentityKey(source), targetLogicalIdentity: symbolIdentityKey(decision.target), strategy: decision.strategy, confidence: decision.confidence, resolutionVersion: decision.resolutionVersion, evidence: compactEvidence(decision, result.resolverState.evidence) }];
  });
  if (normalizedEdges.some((edge) => edge.evidence.length === 0)) throw new Error(`accepted Phase14B edge has no declared evidence for ${name}`);
  const counters: Record<string, number> = {
    filesParsed: result.normalizedFacts.length,
    symbols: result.normalizedFacts.reduce((count, facts) => count + facts.symbols.length, 0),
    evidence: result.resolverState.evidence.reduce((count, batch) => count + evidenceCount(batch), 0),
    decisions: result.decisions.length,
    resolved: result.decisions.filter((decision) => decision.status === "resolved").length,
    diagnostics: diagnostics.length,
    memoHits: result.resolverState.memoHitCount,
  };
  if (options.memoMode !== "warm") warmResolverStates.set(name, result.resolverState);
  const normalizedDecisions = result.decisions.map(normalizeDecision);
  const normalizedDiagnostics = diagnostics.map(normalizeDiagnostic);
  const mayBeIncomplete = diagnostics.some((diagnostic) => diagnostic.kind !== "resolved") || result.normalizedFacts.some((facts) => facts.parseStatus !== "complete" || facts.parserDiagnostics.length > 0);
  if (JSON.stringify(normalizedDecisions) !== JSON.stringify(expected.decisions) || JSON.stringify(normalizedEdges) !== JSON.stringify(expected.normalizedEdges) || JSON.stringify(normalizedDiagnostics) !== JSON.stringify(expected.diagnostics)) {
    throw new Error(`Phase14B expected oracle mismatch for ${name}: ${JSON.stringify({ decisions: normalizedDecisions, normalizedEdges, diagnostics: normalizedDiagnostics, mayBeIncomplete })}`);
  }
  if (mayBeIncomplete !== expected.mayBeIncomplete) throw new Error(`Phase14B incompleteness oracle mismatch for ${name}`);
  return {
    ...result,
    decisions: result.decisions,
    normalizedEdges,
    diagnostics,
    counters,
    mayBeIncomplete,
    expected,
  };
}

export async function runConcurrentPhase14bFixtures(languages: readonly [LanguageId, LanguageId]): Promise<readonly ParallelFixtureResult[]> {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = languages.map((language) => new Worker(new URL("./phase14b-conformance.ts", import.meta.url), {
    type: "module",
    execArgv: process.execArgv,
    workerData: { kind: "phase14b-conformance", language, barrier } satisfies ParallelWorkerData,
  }));
  try {
    return await Promise.all(workers.map(waitForParallelWorker));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function waitForParallelWorker(worker: Worker): Promise<ParallelFixtureResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error("Phase14B conformance worker timed out"));
    }, 30_000);
    worker.once("message", (message: ParallelWorkerMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message.kind === "error") {
        const error = new Error(message.message);
        error.stack = message.stack ?? error.stack;
        reject(error);
      } else {
        resolve(message);
      }
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled || code === 0) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Phase14B conformance worker exited with code ${code}`));
    });
  });
}

function monotonicMillis(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function runParallelWorker(data: ParallelWorkerData): Promise<void> {
  const barrier = new Int32Array(data.barrier);
  const count = Atomics.add(barrier, 0, 1) + 1;
  Atomics.notify(barrier, 0);
  if (count < 2) {
    const deadline = monotonicMillis() + 5_000;
    while (Atomics.load(barrier, 0) < 2) {
      const remaining = deadline - monotonicMillis();
      if (remaining <= 0) throw new Error("Phase14B conformance workers did not reach their barrier");
      Atomics.wait(barrier, 0, 1, remaining);
    }
  }
  const startedAt = monotonicMillis();
  const result = await runPhase14bFixture(data.language, { memoMode: "cold", parallel: false });
  const message: ParallelWorkerMessage = { kind: "result", language: data.language, startedAt, finishedAt: monotonicMillis(), projection: fixtureProjection(result) };
  parentPort?.postMessage(message);
}

if (!isMainThread && parentPort && workerData && typeof workerData === "object" && (workerData as Partial<ParallelWorkerData>).kind === "phase14b-conformance") {
  void runParallelWorker(workerData as ParallelWorkerData).catch((error: unknown) => {
    const message: ParallelWorkerMessage = { kind: "error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
    parentPort.postMessage(message);
  });
}

export async function readJsonLine(stream: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      const value: unknown = JSON.parse(buffer.slice(0, newline));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP response is not a JSON object");
      return value as Record<string, unknown>;
    }
  }
  throw new Error("MCP process ended before emitting a JSON line");
}

export async function runPackedMcpInitialize(cliPath: string): Promise<{ protocolVersion: string; serverName: string }> {
  if (!cliPath) throw new Error("packed CLI path is required");
  const child = spawn(process.execPath, [cliPath, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  if (!child.stdin || !child.stdout) throw new Error("MCP child process streams are unavailable");
  let processError: Error | undefined;
  let failure: Error | undefined;
  let responseValue: { protocolVersion: string; serverName: string } | undefined;
  child.once("error", (error) => { processError = error; });
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phase14b-smoke", version: "1" } } })}\n`);
    child.stdin.end();
    const response = await readJsonLine(child.stdout);
    if (response.jsonrpc !== "2.0" || response.id !== 1) throw new Error("MCP initialize response has invalid JSON-RPC envelope");
    if ("error" in response) throw new Error(`MCP initialize returned an error: ${JSON.stringify(response.error)}`);
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("MCP initialize response has no result object");
    const protocolVersion = (result as Record<string, unknown>).protocolVersion;
    const serverInfo = (result as Record<string, unknown>).serverInfo;
    const serverName = serverInfo && typeof serverInfo === "object" && !Array.isArray(serverInfo) ? (serverInfo as Record<string, unknown>).name : undefined;
    if (typeof protocolVersion !== "string" || typeof serverName !== "string") throw new Error("MCP initialize response is missing protocolVersion/serverInfo.name");
    responseValue = { protocolVersion, serverName };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (!child.killed && child.exitCode === null) child.kill();
    const outcome = await waitForChildClose(child, 2_000);
    if (!failure && processError) failure = processError;
    if (!failure && outcome.code !== null && outcome.code !== 0) failure = new Error(`MCP child exited with code ${outcome.code}`);
    if (!failure && outcome.error) failure = outcome.error;
  }
  if (failure) throw failure;
  if (!responseValue) throw new Error("MCP initialize did not produce a response");
  return responseValue;
}

function waitForChildClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      resolve({ code: null, signal: "SIGTERM", error: new Error(`MCP child did not close within ${timeoutMs}ms`) });
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: child.exitCode, signal: child.signalCode, error }); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}
