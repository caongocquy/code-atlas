import type { BudgetLedger } from "./budgets.js";
import { symbolIdentityKey, type ExpressionIdentity, type ModuleIdentity, type ScopeIdentity, type SymbolIdentity } from "./identities.js";
import type { MemoEntry, ResolverMemo } from "./memo.js";
import type {
  BindingEvidence,
  BudgetReason,
  EvidenceId,
  InheritanceEvidence,
  MemberEvidence,
  ReturnEvidence,
  SemanticEvidenceBatch,
  TypeEnvironmentInput,
  TypeRef,
  UnknownReason,
  UnsupportedReason,
} from "./types.js";

export type LookupResult<T> =
  | { status: "found"; values: readonly T[]; evidenceIds: readonly EvidenceId[] }
  | { status: "unknown"; reason: UnknownReason; evidenceIds: readonly EvidenceId[] }
  | { status: "unsupported"; reason: UnsupportedReason; evidenceIds: readonly EvidenceId[] }
  | { status: "budget_exhausted"; reason: BudgetReason; evidenceIds: readonly EvidenceId[] };

export type { TypeEnvironmentInput } from "./types.js";

export type TypeEnvironment = {
  lookupBinding(scope: ScopeIdentity, name: string): LookupResult<BindingEvidence>;
  inferType(expression: ExpressionIdentity): LookupResult<TypeRef>;
  resolveMember(receiverType: TypeRef, member: string): LookupResult<SymbolIdentity>;
  resolveReturn(callable: SymbolIdentity): LookupResult<TypeRef>;
  resolveInheritance(type: TypeRef): LookupResult<TypeRef>;
  resolveImport(module: ModuleIdentity): LookupResult<SymbolIdentity>;
};

const evidenceIds = (values: readonly { evidenceId: EvidenceId }[]): readonly EvidenceId[] =>
  [...new Set(values.map((value) => value.evidenceId))].sort();

const sortedEvidenceIds = (values: readonly EvidenceId[]): readonly EvidenceId[] =>
  [...new Set(values)].sort();

const bindingParents = new WeakMap<object, ReadonlyMap<string, string | undefined>>();

function canonicalValueKey(value: unknown): string {
  if (typeof value === "object" && value !== null && "evidenceId" in value) return String(value.evidenceId);
  if (typeof value === "object" && value !== null && "repositoryId" in value && "qualifiedName" in value) {
    return symbolIdentityKey(value as SymbolIdentity);
  }
  return JSON.stringify(value);
}

function unsupportedReason(evidence: readonly SemanticEvidenceBatch[]): UnsupportedReason | undefined {
  const codes: readonly UnsupportedReason[] = [
    "language_capability_unsupported",
    "compiler_semantics_required",
    "framework_semantics_required",
    "preprocessor_semantics_required",
  ];
  return evidence.flatMap((batch) => batch.diagnostics).map((diagnostic) => diagnostic.code).find((code): code is UnsupportedReason => codes.includes(code as UnsupportedReason));
}

function unknown<T>(reason: UnknownReason, values: readonly { evidenceId: EvidenceId }[] = []): LookupResult<T> {
  return { status: "unknown", reason, evidenceIds: evidenceIds(values) };
}

function unsupported<T>(reason: UnsupportedReason, values: readonly { evidenceId: EvidenceId }[] = []): LookupResult<T> {
  return { status: "unsupported", reason, evidenceIds: evidenceIds(values) };
}

function exhausted<T>(reason: BudgetReason, values: readonly { evidenceId: EvidenceId }[] = []): LookupResult<T> {
  return { status: "budget_exhausted", reason, evidenceIds: evidenceIds(values) };
}

function found<T>(values: readonly T[], source: readonly { evidenceId: EvidenceId }[]): LookupResult<T> {
  return {
    status: "found",
    values: [...values].sort((left, right) => canonicalValueKey(left).localeCompare(canonicalValueKey(right))),
    evidenceIds: evidenceIds(source),
  };
}

function scopeKey(scope: ScopeIdentity): string {
  return JSON.stringify([scope.sourceUnit.repositoryId, scope.sourceUnit.relativePath, scope.sourceUnit.language, scope.localId]);
}

function sameModule(left: ModuleIdentity | undefined, right: ModuleIdentity): boolean {
  return left?.repositoryId === right.repositoryId && left.normalizedName === right.normalizedName && (!right.relativePath || left.relativePath === right.relativePath);
}

function sameType(left: TypeRef, right: TypeRef): boolean {
  if (left.kind === "known" && right.kind === "known") return symbolIdentityKey(left.symbol) === symbolIdentityKey(right.symbol);
  if (left.kind === "named" && right.kind === "named") return left.name === right.name && (!right.module || sameModule(left.module, right.module));
  return false;
}

function qualifiedTypeName(type: TypeRef): string | undefined {
  if (type.kind === "named") return [...(type.qualification ?? []), type.name].join(".");
  if (type.kind === "known") return type.symbol.qualifiedName;
  return undefined;
}

export function indexBindings(evidence: readonly SemanticEvidenceBatch[]): ReadonlyMap<string, readonly BindingEvidence[]> {
  const index = new Map<string, BindingEvidence[]>();
  const parents = new Map<string, string | undefined>();
  for (const batch of evidence) {
    for (const binding of batch.bindings) {
      const key = scopeKey(binding.scope);
      const values = index.get(key) ?? [];
      values.push(binding);
      index.set(key, values);
      parents.set(key, binding.scope.parentLocalId);
    }
  }
  const result = new Map([...index].map(([key, values]) => [key, [...values].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))]));
  bindingParents.set(result, parents);
  return result;
}

export function lookupInnermost(index: ReadonlyMap<string, readonly BindingEvidence[]>, scope: ScopeIdentity, name: string, budget: BudgetLedger): LookupResult<BindingEvidence> {
  let current: ScopeIdentity | undefined = scope;
  const considered: BindingEvidence[] = [];
  const visited = new Set<string>();
  while (current && !visited.has(scopeKey(current))) {
    visited.add(scopeKey(current));
    if (!budget.consume("bindingHops")) return exhausted("binding_hop_limit", considered);
    const candidates = (index.get(scopeKey(current)) ?? []).filter((binding) => binding.name === name);
    considered.push(...candidates);
    if (candidates.length > 0) return found(candidates, candidates);
    const parentLocalId: string | undefined = current.parentLocalId ?? bindingParents.get(index)?.get(scopeKey(current));
    current = parentLocalId ? { sourceUnit: current.sourceUnit, localId: parentLocalId } : undefined;
  }
  return unknown("insufficient_evidence", considered);
}

function expressionMemoKey(expression: ExpressionIdentity): string {
  return `expression:${JSON.stringify([expression.sourceUnit.repositoryId, expression.sourceUnit.relativePath, expression.sourceUnit.language, expression.localId])}`;
}

function generationScopedMemo(generationId: string, memo: ResolverMemo): ResolverMemo {
  const prefix = `generation:${generationId}:`;
  return {
    get: (key) => memo.get(`${prefix}${key}`),
    set: (key, value) => memo.set(`${prefix}${key}`, value),
    size: () => memo.size(),
  };
}

function sameSourceUnit(left: ExpressionIdentity["sourceUnit"], right: ExpressionIdentity["sourceUnit"]): boolean {
  return left.repositoryId === right.repositoryId && left.relativePath === right.relativePath && left.language === right.language;
}

function memoResult(entry: MemoEntry): LookupResult<TypeRef> | undefined {
  if (entry.kind === "types") {
    return {
      status: "found",
      values: [...entry.values].sort((left, right) => canonicalValueKey(left).localeCompare(canonicalValueKey(right))),
      evidenceIds: sortedEvidenceIds(entry.evidenceIds),
    };
  }
  if (entry.kind === "unknown") return { status: "unknown", reason: entry.reason, evidenceIds: sortedEvidenceIds(entry.evidenceIds) };
  return undefined;
}

export function inferFromEvidence(evidence: readonly SemanticEvidenceBatch[], expression: ExpressionIdentity, budget: BudgetLedger, memo: ResolverMemo): LookupResult<TypeRef> {
  const key = expressionMemoKey(expression);
  const cached = memo.get(key);
  if (cached) return memoResult(cached) ?? unknown("insufficient_evidence");
  if (!budget.consume("expressionNodes")) return exhausted("expression_node_limit");

  const annotations = evidence.flatMap((batch) => batch.typeAnnotations).filter((item) => sameSourceUnit(item.sourceUnit, expression.sourceUnit) && item.subjectLocalId === expression.localId);
  const assignments = evidence.flatMap((batch) => batch.assignments).filter((item) => item.sourceExpression && sameSourceUnit(item.sourceExpression.sourceUnit, expression.sourceUnit) && item.sourceExpression.localId === expression.localId && item.sourceType);
  const values = [...annotations.map((item) => item.type), ...assignments.flatMap((item) => item.sourceType ? [item.sourceType] : [])];
  const sources = [...annotations, ...assignments];
  if (values.length === 0) {
    const result = unsupportedReason(evidence) ? unsupported<TypeRef>(unsupportedReason(evidence)!, sources) : unknown<TypeRef>("insufficient_evidence", sources);
    if (result.status === "unknown") memo.set(key, { kind: "unknown", reason: result.reason, evidenceIds: result.evidenceIds, stable: true });
    return result;
  }
  const resultValues = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  const result = found(resultValues, sources);
  if (result.status !== "found") return result;
  memo.set(key, { kind: "types", values: result.values, evidenceIds: result.evidenceIds });
  return result;
}

export function lookupMembers(evidence: readonly SemanticEvidenceBatch[], owner: TypeRef, member: string, budget: BudgetLedger): LookupResult<SymbolIdentity> {
  if (owner.kind === "union" || owner.kind === "unknown") return unknown("receiver_type_unknown");
  const candidates = evidence.flatMap((batch) => batch.members).filter((item) => item.memberName === member && sameType(item.ownerType, owner)).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (candidates.length === 0) return unsupportedReason(evidence) ? unsupported(unsupportedReason(evidence)!) : unknown("insufficient_evidence");
  const accepted: MemberEvidence[] = [];
  for (const candidate of candidates) {
    if (!budget.consume("memberCandidates")) return exhausted("member_candidate_limit", accepted);
    accepted.push(candidate);
  }
  return found(accepted.map((item) => item.member), accepted);
}

export function lookupReturns(evidence: readonly SemanticEvidenceBatch[], callable: SymbolIdentity, budget: BudgetLedger): LookupResult<TypeRef> {
  const candidates = evidence.flatMap((batch) => batch.returns).filter((item) => symbolIdentityKey(item.callable) === symbolIdentityKey(callable) && item.type).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (candidates.length === 0) return unknown("insufficient_evidence");
  const accepted: ReturnEvidence[] = [];
  for (const candidate of candidates) {
    if (!budget.consume("returnDepth")) return exhausted("return_depth_limit", accepted);
    accepted.push(candidate);
  }
  return found(accepted.flatMap((item) => item.type ? [item.type] : []), accepted);
}

export function lookupInheritance(evidence: readonly SemanticEvidenceBatch[], type: TypeRef, budget: BudgetLedger): LookupResult<TypeRef> {
  const name = qualifiedTypeName(type);
  const candidates = evidence.flatMap((batch) => batch.inheritance).filter((item) => name && item.subject.qualifiedName === name).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (candidates.length === 0) return unknown("insufficient_evidence");
  const accepted: InheritanceEvidence[] = [];
  for (const candidate of candidates) {
    if (!budget.consume("inheritanceDepth")) return exhausted("inheritance_depth_limit", accepted);
    accepted.push(candidate);
  }
  return found(accepted.map((item) => item.target), accepted);
}

export function lookupImports(evidence: readonly SemanticEvidenceBatch[], module: ModuleIdentity, _budget: BudgetLedger): LookupResult<SymbolIdentity> {
  const candidates = evidence.flatMap((batch) => batch.imports).filter((item) => sameModule(item.module, module) || item.specifier === module.normalizedName || item.resolvedPath === module.relativePath).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (candidates.length === 0) return unsupportedReason(evidence) ? unsupported(unsupportedReason(evidence)!) : unknown("unresolved_import");
  for (const candidate of candidates) {
    if (!_budget.consume("candidateExpansions")) return exhausted("candidate_expansion_limit", candidates.slice(0, candidates.indexOf(candidate)));
  }
  return unknown("unresolved_import", candidates);
}

export function createTypeEnvironment(input: TypeEnvironmentInput): TypeEnvironment {
  const bindings = indexBindings(input.evidence);
  const memo = generationScopedMemo(input.generationId, input.memo);
  return {
    lookupBinding: (scope, name) => lookupInnermost(bindings, scope, name, input.budget),
    inferType: (expression) => inferFromEvidence(input.evidence, expression, input.budget, memo),
    resolveMember: (owner, member) => lookupMembers(input.evidence, owner, member, input.budget),
    resolveReturn: (callable) => lookupReturns(input.evidence, callable, input.budget),
    resolveInheritance: (type) => lookupInheritance(input.evidence, type, input.budget),
    resolveImport: (module) => {
      const result = lookupImports(input.evidence, module, input.budget);
      if (result.status !== "unknown") return result;
      const imports = input.evidence.flatMap((batch) => batch.imports).filter((item) =>
        result.evidenceIds.includes(item.evidenceId) && (item.localName || item.importedName));
      const symbols = input.symbols.filter((candidate) => imports.some((item) =>
        candidate.qualifiedName === (item.importedName ?? item.localName) || candidate.relativePath === item.resolvedPath));
      return symbols.length > 0 ? found(symbols, imports) : result;
    },
  };
}
