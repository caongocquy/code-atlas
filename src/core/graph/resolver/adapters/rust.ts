import type { FactLocalId, ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ExpressionIdentity, type ModuleIdentity, type ScopeIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

export const RUST_CAPABILITIES: SemanticCapabilities = { moduleImport: "full", localBinding: "full", directCall: "full", declaredType: "partial", constructorType: "full", receiverMember: "partial", assignment: "full", parameterFlow: "full", returnFlow: "partial", inheritance: "unsupported" };
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizeRustFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty(), unit = context.sourceUnit;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: `${unit.relativePath}:${kind}:${localId}` as never, sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map<string, typeof symbols extends Map<string, infer V> ? V[] : never>();
  for (const item of facts.symbols) { const symbol = symbols.get(item.localId); if (symbol) byName.set(item.name, [...(byName.get(item.name) ?? []), symbol]); }
  const scopes = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const scopeOf = (localId: string | undefined): ScopeIdentity => ({ sourceUnit: unit, localId: localId ?? "scope:1", parentLocalId: localId ? scopes.get(localId as FactLocalId)?.parentId : undefined });
  const typeOf = (value: string | undefined): TypeRef | undefined => {
    if (!value) return undefined;
    let normalized = value;
    if (normalized.startsWith("&")) normalized = normalized.slice(1).trimStart();
    if (normalized.startsWith("mut ")) normalized = normalized.slice(4);
    if (normalized.startsWith("*")) normalized = normalized.slice(1);
    const name = normalized.split("::").at(-1) ?? normalized;
    const candidate = byName.get(name);
    if (candidate?.length === 1) return { kind: "known", symbol: candidate[0]! };
    const alias = facts.aliases.find((item) => item.aliasName === name);
    return { kind: "named", name: alias?.targetName ?? name, qualification: alias ? [alias.targetName] : undefined };
  };
  const typeByBinding = new Map<string, TypeRef>();
  for (const item of facts.constructors) if (item.resultBindingId) { const type = typeOf(item.constructedTypeName); if (type) typeByBinding.set(item.resultBindingId, type); }
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) typeByBinding.set(item.ownerId, type); }
  for (const item of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", item.localId, item.range), kind: "binding", scope: scopeOf(item.ownerId), name: item.name, bindingId: item.localId, declaredType: typeByBinding.get(item.localId) }];
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, localName: item.localName, importedName: item.importedName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.aliases) result.aliases = [...result.aliases, { ...base("alias", item.localId, item.range), kind: "alias", alias: item.aliasName, targetName: item.targetName, target: typeOf(item.targetName) }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: [] }];
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) result.typeAnnotations = [...result.typeAnnotations, { ...base("type", item.localId, item.range), kind: "type_annotation", subjectLocalId: item.ownerId, type }]; }
  for (const item of facts.assignments) { const sourceType = item.sourceName ? typeByBinding.get(facts.bindingSeeds.find((binding) => binding.name === item.sourceName)?.localId ?? "") : undefined; result.assignments = [...result.assignments, { ...base("assignment", item.localId, item.range), kind: "assignment", targetBindingId: item.targetId, sourceExpression: item.sourceExpressionId ? { sourceUnit: unit, localId: item.sourceExpressionId } as ExpressionIdentity : undefined, sourceType }]; if (sourceType) typeByBinding.set(item.targetId, sourceType); }
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName }, resultBindingId: item.resultBindingId }];
  for (const item of facts.parameters) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }]; }
  for (const item of facts.returns) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable, type: typeOf(item.typeText) }]; }
  for (const item of facts.implementations) { const subject = symbols.get(item.subjectId); if (subject) result.implementations = [...result.implementations, { ...base("implementation", item.localId, item.range), kind: "implementation", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: "trait_impl" }]; }
  const expressions = new Map(facts.expressions.map((item) => [item.localId, item]));
  for (const item of facts.members) {
    const owner = item.ownerSymbolId ? symbols.get(item.ownerSymbolId) : undefined;
    if (owner) { const memberFact = facts.symbols.find((symbol) => symbol.name === item.memberName && (symbol.scopeId === facts.symbols.find((candidate) => candidate.localId === item.ownerSymbolId)?.scopeId || symbol.declaredQualifiedName?.startsWith(`${owner.qualifiedName}::`))); const member = memberFact ? symbols.get(memberFact.localId) : undefined; result.members = [...result.members, { ...base("member", item.localId, item.range), kind: "member", ownerType: { kind: "known", symbol: owner }, memberName: item.memberName, member: member ?? owner, access: item.access }]; continue; }
    const receiver = item.receiverId ? expressions.get(item.receiverId) : undefined;
    result.diagnostics = [...result.diagnostics, { ...base("member", item.localId, item.range), code: receiver?.text?.startsWith("*") ? "receiver_type_unknown" : "runtime_dispatch", message: `Rust member dispatch is not uniquely observed for ${item.memberName}`, sourceUnit: unit }];
  }
  for (const item of facts.callSites) {
    result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
    if (item.calleeText === "println" || item.calleeText === "vec") result.diagnostics = [...result.diagnostics, { ...base("call", item.localId, item.range), code: "language_capability_unsupported", message: `Rust macro invocation is unsupported: ${item.calleeText}`, sourceUnit: unit }];
    else if (item.calleeText.startsWith("*")) result.diagnostics = [...result.diagnostics, { ...base("call", item.localId, item.range), code: "runtime_dispatch", message: `Rust deref dispatch is unknown: ${item.calleeText}`, sourceUnit: unit }];
  }
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length) { result.diagnostics = [...result.diagnostics, { ...base("parse", "status", facts.containmentScopes[0]?.range ?? { startLine: 1, endLine: 1 }), code: "parse_uncertain", message: facts.parserDiagnostics.join(", ") || "Tree-sitter reported an uncertain Rust parse", sourceUnit: unit }, { ...base("parse", "unsupported", facts.containmentScopes[0]?.range ?? { startLine: 1, endLine: 1 }), code: "language_capability_unsupported", message: "Partial Rust facts are not authoritative", sourceUnit: unit }]; }
  return result;
}

export const rustSemanticAdapter: LanguageSemanticAdapter = { adapterId: "rust-phase14b", adapterVersion: 1, languages: ["rust"], capabilities: () => RUST_CAPABILITIES, normalizeFile: normalizeRustFacts };
