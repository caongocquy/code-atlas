import { symbolIdentityKey, type ResolutionSiteIdentity, type SymbolIdentity } from "./identities.js";
import type { ResolutionCandidate, ResolverInput } from "./decision.js";
import type {
  BindingEvidence,
  CapabilityLevel,
  LanguageSemanticAdapter,
  ResolutionStrategyId,
  SemanticCapability,
  TypeRef,
} from "./types.js";
import type { LookupResult } from "./type-environment.js";
import { scipBindingKey } from "./scip-evidence.js";

export const ORDERED_STRATEGIES: readonly ResolutionStrategyId[] = [
  "lexical-local", "imports-exports", "explicit-type", "constructor", "assignment", "parameter",
  "return", "alias", "inheritance", "receiver-member", "chained-call", "bounded-interprocedural",
];

const requiredCapability: Readonly<Record<ResolutionStrategyId, SemanticCapability>> = {
  scip: "directCall",
  "lexical-local": "localBinding",
  "imports-exports": "moduleImport",
  "explicit-type": "declaredType",
  constructor: "constructorType",
  assignment: "assignment",
  parameter: "parameterFlow",
  return: "returnFlow",
  alias: "localBinding",
  inheritance: "inheritance",
  "receiver-member": "receiverMember",
  "chained-call": "directCall",
  "bounded-interprocedural": "returnFlow",
};

function sameSourceUnit(left: { repositoryId: string; relativePath: string; language: string }, right: ResolutionSiteIdentity["sourceUnit"]): boolean {
  return left.repositoryId === right.repositoryId && left.relativePath === right.relativePath && left.language === right.language;
}

function known(type: TypeRef | undefined): SymbolIdentity | undefined {
  return type?.kind === "known" ? type.symbol : undefined;
}

function scopedEvidenceIds(input: ResolverInput, site: ResolutionSiteIdentity, ids: readonly string[]): readonly string[] {
  const available = new Set(Object.values(input.evidence).flatMap((values) => Array.isArray(values)
    ? values.filter((value): value is { evidenceId: string; sourceUnit: { repositoryId: string; relativePath: string; language: string } } => Boolean(value && typeof value === "object" && "evidenceId" in value && "sourceUnit" in value && sameSourceUnit(value.sourceUnit, site.sourceUnit))).map((value) => value.evidenceId)
    : []));
  return ids.filter((id) => available.has(id));
}

function typeEnvironmentResult(input: ResolverInput, site: ResolutionSiteIdentity, result: LookupResult<TypeRef>, strategy: ResolutionStrategyId, evidenceIds: readonly string[]): readonly ResolutionCandidate[] {
  if (result.status !== "found") return [];
  const supportingEvidenceIds = scopedEvidenceIds(input, site, [...evidenceIds, ...result.evidenceIds]);
  return result.values.flatMap((type) => {
    const target = known(type);
    return target ? [{ target, strategy, confidence: strategy === "explicit-type" ? "exact" as const : "strong" as const, evidenceIds: [...supportingEvidenceIds].sort() as never }] : [];
  });
}

function bindingCandidate(input: ResolverInput, site: ResolutionSiteIdentity, result: LookupResult<BindingEvidence>, strategy: ResolutionStrategyId, evidenceIds: readonly string[]): readonly ResolutionCandidate[] {
  if (result.status !== "found") return [];
  const supportingEvidenceIds = scopedEvidenceIds(input, site, [...evidenceIds, ...result.evidenceIds]);
  return result.values.flatMap((binding) => {
    const target = known(binding.declaredType);
    return target ? [{ target, strategy, confidence: "strong" as const, evidenceIds: [...supportingEvidenceIds].sort() as never }] : [];
  });
}

function mergeCandidates(values: readonly ResolutionCandidate[]): readonly ResolutionCandidate[] {
  const merged = new Map<string, ResolutionCandidate>();
  for (const candidate of values) {
    const key = symbolIdentityKey(candidate.target);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...candidate, evidenceIds: [...new Set(candidate.evidenceIds)].sort() });
      continue;
    }
    const confidence = current.confidence === "exact" || candidate.confidence === "exact"
      ? "exact"
      : current.confidence === "strong" || candidate.confidence === "strong" ? "strong" : "weak";
    merged.set(key, {
      ...current,
      confidence,
      evidenceIds: [...new Set([...current.evidenceIds, ...candidate.evidenceIds])].sort(),
    });
  }
  return [...merged.values()].sort((left, right) => symbolIdentityKey(left.target).localeCompare(symbolIdentityKey(right.target)));
}

function adapterFor(input: ResolverInput): LanguageSemanticAdapter | undefined {
  return input.context.languageRegistry.find((adapter) => adapter.languages.includes(input.facts.language));
}

function capabilityAvailable(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): boolean {
  const adapter = adapterFor(input);
  if (!adapter) return true;
  const capability = requiredCapability[strategy];
  const level: CapabilityLevel | undefined = adapter.capabilities(input.facts.language)[capability];
  if (level === "full" || level === "partial") return true;
  input.context.diagnostics.add({ site, status: "unsupported", strategy, reason: `capability:${capability}` });
  return false;
}

function memoKey(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): string {
  return `resolution:${input.context.generationId}:${JSON.stringify([site.sourceUnit.repositoryId, site.sourceUnit.relativePath, site.sourceUnit.language, site.localId, strategy])}`;
}

function cached(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] | undefined {
  const entry = input.context.memo.get(memoKey(input, site, strategy));
  if (!entry || entry.kind !== "symbols") return undefined;
  const values = entry.values
    .filter((target) => target.repositoryId === site.sourceUnit.repositoryId)
    .map((target) => ({ target, strategy, confidence: strategy === "explicit-type" ? "exact" as const : "strong" as const, evidenceIds: entry.evidenceIds }));
  return values.length > 0 ? values : undefined;
}

function cache(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId, candidates: readonly ResolutionCandidate[]): void {
  const merged = mergeCandidates(candidates);
  if (merged.length === 0) return;
  input.context.memo.set(memoKey(input, site, strategy), {
    kind: "symbols",
    values: merged.map((candidate) => candidate.target),
    evidenceIds: [...new Set(merged.flatMap((candidate) => candidate.evidenceIds))].sort(),
  });
}

function siteNames(input: ResolverInput, site: ResolutionSiteIdentity): readonly string[] {
  return [
    ...input.facts.references.filter((fact) => fact.localId === site.localId).map((fact) => fact.name),
    ...input.facts.callSites.filter((fact) => fact.localId === site.localId).map((fact) => fact.calleeText),
  ];
}

function resolveLexical(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  const names = siteNames(input, site);
  const bindings = input.evidence.bindings.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && (
    item.bindingId === site.localId || item.scope.localId === site.localId || names.includes(item.name)
  ));
  return mergeCandidates(bindings.flatMap((binding) => bindingCandidate(
    input, site, input.environment.lookupBinding(binding.scope, binding.name), strategy, [binding.evidenceId],
  )));
}

function resolveTypes(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId, ids: readonly string[]): readonly ResolutionCandidate[] {
  if (ids.length === 0) return [];
  const result = input.environment.inferType({ sourceUnit: site.sourceUnit, localId: site.localId });
  return mergeCandidates(typeEnvironmentResult(input, site, result, strategy, ids));
}

function resolveMembers(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  const facts = input.facts.members.filter((item) => item.localId === site.localId);
  const names = new Set(facts.map((item) => item.memberName));
  const members = input.evidence.members.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit)
    && names.has(item.memberName)
    && item.evidenceId.endsWith(`member:${site.localId}`));
  return mergeCandidates(members.flatMap((item) => {
    const result = input.environment.resolveMember(item.ownerType, item.memberName);
    if (result.status !== "found") return [];
    return result.values.map((target) => ({ target, strategy, confidence: "strong" as const, evidenceIds: [...scopedEvidenceIds(input, site, [item.evidenceId, ...result.evidenceIds])].sort() as never }));
  }));
}

function resolveImports(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  const fact = input.facts.imports.find((item) => item.localId === site.localId);
  if (!fact) return [];
  const imports = input.evidence.imports.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.specifier === fact.moduleSpecifier);
  return mergeCandidates(imports.flatMap((item) => item.module ? (() => {
    const result = input.environment.resolveImport(item.module);
    return result.status === "found" ? result.values.map((target) => ({ target, strategy, confidence: "strong" as const, evidenceIds: [...scopedEvidenceIds(input, site, [item.evidenceId, ...result.evidenceIds])].sort() as never })) : [];
  })() : []));
}

function resolveReturns(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  const returnFact = input.facts.returns.find((fact) => fact.localId === site.localId);
  const callFacts = input.facts.callSites.filter((fact) => fact.localId === site.localId);
  const callEvidence = input.evidence.calls.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.site.localId === site.localId);
  const calleeNames = new Set([
    ...callFacts.map((fact) => fact.calleeText),
    ...callEvidence.map((item) => item.calleeName),
  ]);
  const returns = input.evidence.returns.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && (
    returnFact?.ownerSymbolId === item.callable.discriminator
    || calleeNames.has(item.callable.qualifiedName)
    || [...calleeNames].some((name) => item.callable.qualifiedName.endsWith(`.${name}`))
  ));
  const callEvidenceIds = callEvidence.map((item) => item.evidenceId);
  return mergeCandidates(returns.flatMap((item) => typeEnvironmentResult(
    input,
    site,
    input.environment.resolveReturn(item.callable),
    strategy,
    [item.evidenceId, ...callEvidenceIds],
  )));
}

function resolveInheritance(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  const fact = [...input.facts.inheritances, ...input.facts.implementations].find((item) => item.localId === site.localId);
  if (!fact) return [];
  const items = [...input.evidence.inheritance, ...input.evidence.implementations].filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.relation === fact.relationKind && ((item.target.kind === "named" && item.target.name === fact.targetName) || (item.target.kind === "known" && item.target.symbol.qualifiedName === fact.targetName)));
  return mergeCandidates(items.flatMap((item) => {
    if (item.target.kind === "known") return [{ target: item.target.symbol, strategy, confidence: "strong" as const, evidenceIds: [item.evidenceId] as never }];
    const result = input.environment.resolveInheritance({ kind: "known", symbol: item.subject });
    return typeEnvironmentResult(input, site, result, strategy, [item.evidenceId]);
  }));
}

function candidates(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  if (strategy === "scip") {
    return (input.context.scipEvidenceBySite?.get(scipBindingKey(site.sourceUnit, site.localId)) ?? [])
      .map((binding) => ({ target: binding.target, strategy, confidence: "exact", evidenceIds: [binding.evidenceId] }));
  }
  if (!capabilityAvailable(input, site, strategy)) return [];
  const memoized = cached(input, site, strategy);
  if (memoized) return memoized;
  if (!input.context.budget.consume("candidateExpansions")) return [];

  let result: readonly ResolutionCandidate[];
  switch (strategy) {
    case "lexical-local": result = resolveLexical(input, site, strategy); break;
    case "imports-exports": result = resolveImports(input, site, strategy); break;
    case "explicit-type": result = resolveTypes(input, site, strategy, input.evidence.typeAnnotations.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.subjectLocalId === site.localId).map((item) => item.evidenceId)); break;
    case "constructor": result = resolveTypes(input, site, strategy, input.evidence.constructors.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.resultBindingId === site.localId).map((item) => item.evidenceId)); break;
    case "assignment": result = resolveTypes(input, site, strategy, input.evidence.assignments.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.targetBindingId === site.localId).map((item) => item.evidenceId)); break;
    case "parameter": result = resolveTypes(input, site, strategy, input.evidence.parameters.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && item.bindingId === site.localId).map((item) => item.evidenceId)); break;
    case "return": result = resolveReturns(input, site, strategy); break;
    case "alias": result = resolveTypes(input, site, strategy, input.evidence.aliases.filter((item) => sameSourceUnit(item.sourceUnit, site.sourceUnit) && input.facts.aliases.some((fact) => fact.localId === site.localId && fact.aliasName === item.alias)).map((item) => item.evidenceId)); break;
    case "inheritance": result = resolveInheritance(input, site, strategy); break;
    case "receiver-member": result = resolveMembers(input, site, strategy); break;
    case "chained-call":
    case "bounded-interprocedural": result = []; break;
  }
  const scoped = mergeCandidates(result).filter((candidate) => candidate.target.repositoryId === site.sourceUnit.repositoryId);
  cache(input, site, strategy, scoped);
  return scoped;
}

export function resolveStrategy(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  return candidates(input, site, strategy);
}
