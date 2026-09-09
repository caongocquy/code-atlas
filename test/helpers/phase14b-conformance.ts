import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { ResolverDiagnostic } from "../../src/core/diagnostics/coverage-diagnostics.types.js";
import { getLanguageFactExtractor } from "../../src/core/facts/language-fact-extractor.js";
import type { ParsedFactsBlob } from "../../src/core/facts/facts.types.js";
import { getSemanticAdapter } from "../../src/core/graph/resolver/adapter-registry.js";
import { symbolIdentityKey, type ResolutionSiteIdentity, type SymbolIdentity } from "../../src/core/graph/resolver/identities.js";
import type { ResolutionDecision } from "../../src/core/graph/resolver/resolver.js";
import type { LanguageId } from "../../src/core/graph/parsers/types.js";
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
  normalizedEdges: readonly unknown[];
  decisions: readonly unknown[];
};

export type FixtureResult = LanguageFixtureResult & {
  normalizedEdges: readonly unknown[];
  diagnostics: readonly ResolverDiagnostic[];
  counters: Readonly<Record<string, number>>;
  mayBeIncomplete: boolean;
  expected: Phase14bExpectedFixture;
};

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

type ConformanceExpectation = {
  statuses: readonly ResolutionDecision["status"][];
  edgeKinds: readonly string[];
};

const expectedByLanguage: Readonly<Record<LanguageId, ConformanceExpectation>> = {
  typescript: { statuses: ["resolved"], edgeKinds: [] },
  tsx: { statuses: ["resolved"], edgeKinds: [] },
  javascript: { statuses: ["resolved"], edgeKinds: [] },
  python: { statuses: ["resolved"], edgeKinds: [] },
  java: { statuses: ["resolved"], edgeKinds: [] },
  kotlin: { statuses: ["unknown", "unknown", "ambiguous"], edgeKinds: [] },
  go: { statuses: ["resolved", "ambiguous"], edgeKinds: ["calls"] },
  rust: { statuses: ["unknown"], edgeKinds: [] },
  swift: { statuses: ["resolved"], edgeKinds: [] },
  dart: { statuses: ["resolved"], edgeKinds: [] },
  c: { statuses: ["resolved"], edgeKinds: ["calls"] },
  cpp: { statuses: ["resolved"], edgeKinds: ["calls"] },
};

function metadataName(name: string): string {
  return name === "typescript" || name === "tsx" || name === "javascript" ? "ecmascript" : name;
}

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
  const metadataUrl = new URL(`../fixtures/phase14b/${metadataName(name)}/expected.json`, import.meta.url);
  const metadata = JSON.parse(await readFile(metadataUrl, "utf8")) as FixtureMetadata;
  assertFixtureMetadata(name, metadata);
  const expectation = expectedByLanguage[name as LanguageId];
  if (!expectation) throw new Error(`missing conformance expectation for ${name}`);
  return {
    normalizedEdges: expectation.edgeKinds.map((type) => ({ type })),
    decisions: expectation.statuses.map((status) => ({ status })),
  };
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
      return "fn target() -> i32 { 1 }\nfn main() { target(); }\n";
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
  const semantic = language === "java"
    ? facts.members.find((item) => item.memberName === "value") ?? facts.members[0]
    : language === "typescript" || language === "tsx" || language === "javascript" || language === "python" || language === "swift" || language === "dart"
      ? facts.members[0] ?? facts.callSites.find((item) => !item.calleeText.includes("new "))
      : facts.callSites[0] ?? facts.members[0] ?? facts.inheritances[0] ?? facts.implementations[0] ?? facts.references[0];
  return semantic ? [{ sourceUnit: sourceUnitIdentity, localId: semantic.localId }] : [];
}

function sourceIdentityForSite(facts: ParsedFactsBlob, site: ResolutionSiteIdentity): SymbolIdentity | undefined {
  const localId = facts.callSites.find((item) => item.localId === site.localId)?.callerId
    ?? facts.inheritances.find((item) => item.localId === site.localId)?.subjectId
    ?? facts.implementations.find((item) => item.localId === site.localId)?.subjectId
    ?? facts.members.find((item) => item.localId === site.localId)?.ownerSymbolId
    ?? facts.references.find((item) => item.localId === site.localId)?.ownerId;
  const symbol = facts.symbols.find((item) => item.localId === localId);
  return symbol ? {
    repositoryId: site.sourceUnit.repositoryId,
    relativePath: site.sourceUnit.relativePath,
    language: site.sourceUnit.language,
    kind: symbol.kind,
    qualifiedName: symbol.declaredQualifiedName ?? symbol.name,
    discriminator: symbol.localId,
  } : undefined;
}

function evidenceCount(batch: LanguageFixtureResult["resolverState"]["evidence"][number]): number {
  return Object.values(batch).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);
}

function diagnosticKind(code: string): ResolverDiagnostic["kind"] {
  if (code.includes("unsupported") || code.includes("compiler") || code.includes("framework") || code.includes("preprocessor")) return "unsupported";
  if (code.includes("ambigu")) return "ambiguous";
  return "unknown";
}

function normalizeDecision(decision: ResolutionDecision): Record<string, unknown> {
  return { status: decision.status };
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
  const fixture: LanguageFixtureDefinition = { name: `conformance-${name}`, cases: [item], sites, expectedDecisionStatuses: expectedByLanguage[language].statuses };
  const result = await runFixtureThroughResolver(fixture, [outcome.facts], adapter, options.memoMode, options.parallel);
  const expected = await loadPhase14bExpectedFixture(name);
  if (result.decisions.length !== expected.decisions.length) throw new Error(`fixture ${name} produced ${result.decisions.length} decisions; expected ${expected.decisions.length}`);
  for (const decision of result.decisions) {
    if (decision.status === "resolved" && (!decision.strategy || !decision.confidence || !decision.target)) throw new Error(`resolved ${name} decision lacks complete provenance fields`);
  }
  const diagnostics = result.decisions.map((decision) => resolverDiagnostic(decision, item.filePath)).concat(
    result.resolverState.evidence.flatMap((batch) => batch.diagnostics.map((diagnostic) => ({
      kind: diagnosticKind(diagnostic.code), language, file: item.filePath, count: 1, reason: diagnostic.message,
    }))),
  );
  const normalizedEdges = result.decisions.flatMap((decision, index) => {
    if (decision.status !== "resolved" || !decision.edgeKind || decision.edgeKind === "references") return [];
    const source = sourceIdentityForSite(outcome.facts, sites[index]!);
    if (!source) throw new Error(`resolved ${name} decision has no logical source identity`);
    const evidenceKinds = result.resolverState.evidence.flatMap((batch) => Object.keys(batch).filter((key) => key !== "diagnostics")).slice(0, 8);
    return [{ type: decision.edgeKind, sourceLogicalIdentity: symbolIdentityKey(source), targetLogicalIdentity: symbolIdentityKey(decision.target), strategy: decision.strategy, confidence: decision.confidence, evidenceKinds }];
  });
  const counters: Record<string, number> = {
    filesParsed: result.normalizedFacts.length,
    symbols: result.normalizedFacts.reduce((count, facts) => count + facts.symbols.length, 0),
    evidence: result.resolverState.evidence.reduce((count, batch) => count + evidenceCount(batch), 0),
    decisions: result.decisions.length,
    resolved: result.decisions.filter((decision) => decision.status === "resolved").length,
    diagnostics: diagnostics.length,
    memoHits: result.resolverState.memoHitCount,
  };
  return {
    ...result,
    decisions: result.decisions,
    normalizedEdges,
    diagnostics,
    counters,
    mayBeIncomplete: diagnostics.some((diagnostic) => diagnostic.kind !== "resolved") || result.normalizedFacts.some((facts) => facts.parseStatus !== "complete" || facts.parserDiagnostics.length > 0),
    expected: {
      normalizedEdges: expected.normalizedEdges,
      decisions: result.decisions.map(normalizeDecision),
    },
  };
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
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phase14b-smoke", version: "1" } } })}\n`);
    const response = await readJsonLine(child.stdout);
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("MCP initialize response has no result object");
    const protocolVersion = (result as Record<string, unknown>).protocolVersion;
    const serverInfo = (result as Record<string, unknown>).serverInfo;
    const serverName = serverInfo && typeof serverInfo === "object" && !Array.isArray(serverInfo) ? (serverInfo as Record<string, unknown>).name : undefined;
    if (typeof protocolVersion !== "string" || typeof serverName !== "string") throw new Error("MCP initialize response is missing protocolVersion/serverInfo.name");
    return { protocolVersion, serverName };
  } finally {
    child.kill();
  }
}
