import type { FactLocalId, ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ModuleIdentity, type ScopeIdentity, type SymbolIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

export const DART_CAPABILITIES: SemanticCapabilities = { moduleImport: "partial", localBinding: "full", directCall: "partial", declaredType: "full", constructorType: "full", receiverMember: "partial", assignment: "partial", parameterFlow: "partial", returnFlow: "partial", inheritance: "full" };
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizeDartFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty(), unit = context.sourceUnit;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: `${unit.relativePath}:${kind}:${localId}` as never, sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map<string, SymbolIdentity[]>(); for (const item of facts.symbols) { const value = symbols.get(item.localId); if (value) byName.set(item.name, [...(byName.get(item.name) ?? []), value]); }
  const scopes = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const scopeOf = (localId: string | undefined): ScopeIdentity => ({ sourceUnit: unit, localId: localId ?? "scope:1", parentLocalId: localId ? scopes.get(localId as FactLocalId)?.parentId : undefined });
  const typeOf = (value: string | undefined): TypeRef | undefined => { if (!value) return undefined; const name = value.replaceAll("?", "").trim().split(".").at(-1)!; const candidates = byName.get(name); return candidates?.length === 1 ? { kind: "known", symbol: candidates[0]! } : { kind: "named", name }; };
  const typeByBinding = new Map<string, TypeRef>();
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) typeByBinding.set(item.ownerId, type); }
  for (const item of facts.constructors) if (item.resultBindingId) { const type = typeOf(item.constructedTypeName); if (type) typeByBinding.set(item.resultBindingId, type); }
  for (const item of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", item.localId, item.range), kind: "binding", scope: scopeOf(item.ownerId), name: item.name, bindingId: item.localId, declaredType: typeByBinding.get(item.localId) }];
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, localName: item.localName, importedName: item.importedName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: [] }];
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) result.typeAnnotations = [...result.typeAnnotations, { ...base("type", item.localId, item.range), kind: "type_annotation", subjectLocalId: item.ownerId, type }]; }
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName }, resultBindingId: item.resultBindingId }];
  for (const item of facts.assignments) {
    if (!facts.bindingSeeds.some((binding) => binding.localId === item.targetId)) {
      result.diagnostics = [...result.diagnostics, { ...base("assignment", item.localId, item.range), code: "assignment_target_member_unsupported", message: `Dart assignment target ${item.targetId} is not a binding seed`, siteLocalId: item.localId }];
      continue;
    }
    const sourceExpression = item.sourceExpressionId ? { sourceUnit: unit, localId: item.sourceExpressionId } : undefined;
    result.assignments = [...result.assignments, { ...base("assignment", item.localId, item.range), kind: "assignment", targetBindingId: item.targetId, sourceExpression, sourceType: item.sourceName ? typeOf(item.sourceName) : undefined }];
  }
  for (const item of facts.parameters) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }]; }
  for (const item of facts.returns) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable, type: typeOf(item.typeText) }]; }
  for (const item of facts.inheritances) { const subject = symbols.get(item.subjectId); if (subject) result.inheritance = [...result.inheritance, { ...base("inheritance", item.localId, item.range), kind: "inheritance", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  for (const item of facts.implementations) { const subject = symbols.get(item.subjectId); if (subject) result.implementations = [...result.implementations, { ...base("implementation", item.localId, item.range), kind: "implementation", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  const expressionById = new Map(facts.expressions.map((item) => [item.localId, item]));
  const bindingByName = new Map(facts.bindingSeeds.map((item) => [item.name, item]));
  for (const item of facts.members) {
    const ownerFact = item.ownerSymbolId ? facts.symbols.find((candidate) => candidate.localId === item.ownerSymbolId) : undefined;
    const receiver = item.receiverId ? expressionById.get(item.receiverId) : undefined;
    const binding = receiver ? bindingByName.get(receiver.text ?? "") : undefined;
    const extensionOwner = ownerFact ? facts.implementations.find((relation) => relation.subjectId === ownerFact.localId && relation.relationKind === "extension") : undefined;
    const ownerType = extensionOwner ? typeOf(extensionOwner.targetName) : ownerFact ? typeOf(ownerFact.name) : binding ? typeByBinding.get(binding.localId) : undefined;
    if (!ownerType) { if (item.receiverId) result.diagnostics = [...result.diagnostics, { ...base("member", item.localId, item.range), code: "dynamic_expression", message: `Dart receiver type is dynamic or unknown for ${item.memberName}` }]; continue; }
    const ownerName = ownerType.kind === "known" ? ownerType.symbol.qualifiedName.split(".").at(-1) : ownerType.kind === "named" ? ownerType.name : undefined;
    if (!ownerName) continue;
    const relations = facts.implementations.filter((relation) => relation.subjectId === facts.symbols.find((symbol) => symbol.name === ownerName)?.localId && relation.relationKind === "mixin");
    const extensionMembers = facts.members
      .filter((member) => member.memberName === item.memberName && member.access === "extension")
      .flatMap((member) => {
        const extension = member.ownerSymbolId ? facts.symbols.find((symbol) => symbol.localId === member.ownerSymbolId) : undefined;
        const relation = extension && facts.implementations.find((candidate) => candidate.subjectId === extension.localId && candidate.relationKind === "extension" && candidate.targetName === ownerName);
        if (!extension || !relation) return [];
        return facts.symbols.filter((symbol) => symbol.name === member.memberName && symbol.declaredQualifiedName === `${extension.declaredQualifiedName}.${member.memberName}`).map((symbol) => symbol.localId);
      });
    const directCandidates = facts.symbols.filter((candidate) => candidate.name === item.memberName && candidate.declaredQualifiedName?.startsWith(`${ownerName}.`));
    const candidates = directCandidates.length > 0
      ? directCandidates
      : facts.symbols.filter((candidate) => candidate.name === item.memberName && (relations.some((relation) => candidate.declaredQualifiedName?.startsWith(`${relation.targetName}.`)) || extensionMembers.includes(candidate.localId)));
    if (candidates.length > 1) { result.diagnostics = [...result.diagnostics, { ...base("mixin", item.localId, item.range), code: "mixin_selection_ambiguity", message: `Dart mixin selection is not statically unique for ${item.memberName}`, siteLocalId: item.localId, candidates: candidates.map((candidate) => symbols.get(candidate.localId)!).filter((candidate): candidate is SymbolIdentity => Boolean(candidate)) }]; }
    else if (candidates.length === 1) result.members = [...result.members, { ...base("member", item.localId, item.range), kind: "member", ownerType, memberName: item.memberName, member: symbols.get(candidates[0]!.localId)!, access: item.access }];
  }
  for (const item of facts.callSites) result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
  if (facts.imports.some((item) => item.moduleSpecifier.startsWith("package:flutter/"))) result.diagnostics = [...result.diagnostics, { ...base("framework", "flutter", facts.imports[0]!.range), code: "flutter_semantics_excluded", message: "Flutter framework behavior is intentionally outside the Dart semantic floor" }];
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length) result.diagnostics = [...result.diagnostics, { ...base("parse", "status", facts.containmentScopes[0]?.range ?? { startLine: 1, endLine: 1 }), code: "parse_uncertain", message: facts.parserDiagnostics.join(", ") || "Tree-sitter reported an uncertain Dart parse" }, { ...base("parse", "unsupported", facts.containmentScopes[0]?.range ?? { startLine: 1, endLine: 1 }), code: "language_capability_unsupported", message: "Partial Dart facts are not authoritative" }];
  return result;
}

export const dartSemanticAdapter: LanguageSemanticAdapter = { adapterId: "dart-phase14b", adapterVersion: 1, languages: ["dart"], capabilities: () => DART_CAPABILITIES, normalizeFile: normalizeDartFacts };
