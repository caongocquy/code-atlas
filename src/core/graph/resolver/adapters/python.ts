import type { FactLocalId, ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ExpressionIdentity, type ModuleIdentity, type ScopeIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

const PYTHON_CAPABILITIES: SemanticCapabilities = {
  moduleImport: "full", localBinding: "full", directCall: "full", declaredType: "full", constructorType: "full",
  receiverMember: "full", assignment: "full", parameterFlow: "full", returnFlow: "full", inheritance: "full",
};
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizePythonFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty(), unit = context.sourceUnit;
  const evidenceId = (kind: string, localId: string) => `${unit.relativePath}:${kind}:${localId}` as never;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: evidenceId(kind, localId), sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map(facts.symbols.map((item) => [item.name, symbols.get(item.localId)!]));
  const scopes = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const scopeOf = (localId: string | undefined): ScopeIdentity => ({ sourceUnit: unit, localId: localId ?? "scope:1", parentLocalId: localId ? scopes.get(localId as FactLocalId)?.parentId : undefined });
  const parentScope = (localId: string | undefined): FactLocalId | undefined => localId ? scopes.get(localId as FactLocalId)?.parentId : undefined;
  const findBinding = (name: string | undefined, scopeId: string | undefined) => {
    const candidates = facts.bindingSeeds.filter((item) => item.name === name);
    let scope = scopeId;
    while (scope) { const match = candidates.find((item) => item.ownerId === scope); if (match) return match; scope = parentScope(scope); }
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const typeOf = (text: string | undefined): TypeRef | undefined => text ? (byName.get(text) ? { kind: "known", symbol: byName.get(text)! } : { kind: "named", name: text }) : undefined;
  const typeByBinding = new Map<string, TypeRef>();
  for (const annotation of facts.declaredTypeAnnotations) { const type = typeOf(annotation.text); if (type && facts.bindingSeeds.some((item) => item.localId === annotation.ownerId)) typeByBinding.set(annotation.ownerId, type); }
  for (const constructor of facts.constructors) if (constructor.resultBindingId) typeByBinding.set(constructor.resultBindingId, typeOf(constructor.constructedTypeName) ?? { kind: "named", name: constructor.constructedTypeName });
  for (const item of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", item.localId, item.range), kind: "binding", scope: scopeOf(item.ownerId), name: item.name, bindingId: item.localId }];
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) { result.typeAnnotations = [...result.typeAnnotations, { ...base("type", item.localId, item.range), kind: "type_annotation", subjectLocalId: item.ownerId, type }]; result.bindings = result.bindings.map((binding) => binding.bindingId === item.ownerId ? { ...binding, declaredType: type } : binding); } }
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, localName: item.localName, importedName: item.importedName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.assignments) { const expression: ExpressionIdentity | undefined = item.sourceExpressionId ? { sourceUnit: unit, localId: item.sourceExpressionId } : undefined; const source = findBinding(item.sourceName, undefined); const sourceType = source ? typeByBinding.get(source.localId) : undefined; if (sourceType) typeByBinding.set(item.targetId, sourceType); result.assignments = [...result.assignments, { ...base("assignment", item.localId, item.range), kind: "assignment", targetBindingId: item.targetId, sourceExpression: expression, sourceType }]; }
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName }, resultBindingId: item.resultBindingId }];
  for (const item of facts.parameters) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }]; }
  for (const item of facts.returns) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable, expression: item.expressionId ? { sourceUnit: unit, localId: item.expressionId } : undefined, type: typeOf(facts.declaredTypeAnnotations.find((annotation) => annotation.ownerId === item.ownerSymbolId)?.text) }]; }
  const expressions = new Map(facts.expressions.map((item) => [item.localId, item]));
  for (const item of facts.members) {
    const receiver = item.receiverId ? expressions.get(item.receiverId) : undefined;
    let ownerType: TypeRef | undefined;
    const receiverBinding = receiver ? findBinding(receiver.text, receiver.ownerScopeId) : undefined;
    ownerType = receiverBinding ? typeByBinding.get(receiverBinding.localId) : undefined;
    if (!ownerType && receiver?.text === "self") {
      let scope = receiver.ownerScopeId;
      while (scope && scopes.get(scope)?.kind !== "class_definition") scope = parentScope(scope);
      const classScope = scope ? scopes.get(scope) : undefined;
      const classSymbol = classScope?.name ? facts.symbols.find((symbol) => symbol.kind === "class" && symbol.name === classScope.name) : undefined;
      if (classSymbol) ownerType = { kind: "known", symbol: symbols.get(classSymbol.localId)! };
    }
    const ownerSymbol = ownerType?.kind === "known" ? facts.symbols.find((symbol) => symbols.get(symbol.localId) === ownerType?.symbol) : undefined;
    const classScopeId = ownerSymbol?.scopeId;
    const member = classScopeId ? facts.symbols.find((symbol) => symbol.name === item.memberName && symbol.scopeId === classScopeId) : undefined;
    if (ownerType && member) result.members = [...result.members, { ...base("member", item.localId, item.range), kind: "member", ownerType, memberName: item.memberName, member: symbols.get(member.localId)!, access: item.access }];
    else result.diagnostics = [...result.diagnostics, { sourceUnit: unit, range: item.range, code: "receiver_type_unknown", message: `Cannot resolve receiver for ${item.memberName}` }];
  }
  for (const item of facts.inheritances) { const subject = symbols.get(item.subjectId); if (subject) result.inheritance = [...result.inheritance, { ...base("inheritance", item.localId, item.range), kind: "inheritance", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  for (const item of facts.aliases) result.aliases = [...result.aliases, { ...base("alias", item.localId, item.range), kind: "alias", alias: item.aliasName, targetName: item.targetName, target: typeOf(item.targetName) }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: [] }];
  for (const item of facts.callSites) result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
  for (const item of facts.callSites) if (["eval", "exec", "compile", "__import__", "setattr", "delattr", "globals", "locals"].includes(item.calleeText)) result.diagnostics = [...result.diagnostics, { sourceUnit: unit, range: item.range, code: "compiler_semantics_required", message: `Runtime-dependent Python construct: ${item.calleeText}` }];
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length) { const message = facts.parserDiagnostics.join(", ") || "Tree-sitter reported an uncertain parse"; result.diagnostics = [...result.diagnostics, { sourceUnit: unit, code: "parse_uncertain", message }, { sourceUnit: unit, code: "language_capability_unsupported", message: "Partial Python facts are not authoritative" }]; }
  return result;
}

export const pythonSemanticAdapter: LanguageSemanticAdapter = { adapterId: "python-phase14b", adapterVersion: 1, languages: ["python"], capabilities: () => PYTHON_CAPABILITIES, normalizeFile: normalizePythonFacts };
