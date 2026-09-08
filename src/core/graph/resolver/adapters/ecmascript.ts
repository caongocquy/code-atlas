import type { ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ExpressionIdentity, type ModuleIdentity, type ScopeIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

const capabilities: SemanticCapabilities = {
  moduleImport: "full", localBinding: "full", directCall: "full", declaredType: "full", constructorType: "full",
  receiverMember: "full", assignment: "full", parameterFlow: "full", returnFlow: "full", inheritance: "full",
};
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizeEcmascriptFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty();
  const unit = context.sourceUnit;
  const evidenceId = (kind: string, localId: string) => `${unit.relativePath}:${kind}:${localId}` as never;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: evidenceId(kind, localId), sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map(facts.symbols.map((item) => [item.name, symbols.get(item.localId)!]));
  const typeOf = (text: string | undefined): TypeRef | undefined => {
    if (!text) return undefined;
    const clean = text.replace(/^[\s?]+|[\s?]+$/g, "");
    const known = byName.get(clean);
    return known ? { kind: "known", symbol: known } : { kind: "named", name: clean };
  };
  const scopeOf = (localId: string | undefined): ScopeIdentity => {
    const scope = facts.containmentScopes.find((item) => item.localId === localId);
    return { sourceUnit: unit, localId: localId ?? "scope:1", parentLocalId: scope?.parentId };
  };
  const bindingById = new Map(facts.bindingSeeds.map((item) => [item.localId, item]));
  const typeByBinding = new Map<string, TypeRef>();
  for (const annotation of facts.declaredTypeAnnotations) {
    const type = typeOf(annotation.text);
    if (type && bindingById.has(annotation.ownerId)) typeByBinding.set(annotation.ownerId, type);
  }
  for (const constructor of facts.constructors) {
    if (constructor.resultBindingId) {
      typeByBinding.set(constructor.resultBindingId, typeOf(constructor.constructedTypeName) ?? { kind: "named", name: constructor.constructedTypeName });
    }
  }
  for (const item of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", item.localId, item.range), kind: "binding", scope: scopeOf(item.ownerId), name: item.name, bindingId: item.localId }];
  for (const item of facts.declaredTypeAnnotations) {
    const annotation = typeOf(item.text); if (!annotation) continue;
    result.typeAnnotations = [...result.typeAnnotations, { ...base("type", item.localId, item.range), kind: "type_annotation", subjectLocalId: item.ownerId, type: annotation }];
    const binding = bindingById.get(item.ownerId); if (binding) {
      const current = result.bindings.find((candidate) => candidate.bindingId === binding.localId);
      if (current) result.bindings = result.bindings.map((candidate) => candidate.bindingId === binding.localId ? { ...candidate, declaredType: annotation } : candidate);
    }
  }
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, localName: item.localName, importedName: item.importedName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.exports) result.exports = [...result.exports, { ...base("export", item.localId, item.range), kind: "export", exportedName: item.exportedName ?? "*", localName: item.localName }];
  for (const item of facts.assignments) {
    const sourceExpression: ExpressionIdentity | undefined = item.sourceExpressionId ? { sourceUnit: unit, localId: item.sourceExpressionId } : undefined;
    const sourceBinding = item.sourceName ? facts.bindingSeeds.find((binding) => binding.name === item.sourceName) : undefined;
    const sourceType = sourceBinding ? typeByBinding.get(sourceBinding.localId) : undefined;
    if (sourceType) typeByBinding.set(item.targetId, sourceType);
    result.assignments = [...result.assignments, { ...base("assignment", item.localId, item.range), kind: "assignment", targetBindingId: item.targetId, sourceExpression, sourceType }];
  }
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName }, resultBindingId: item.resultBindingId }];
  for (const item of facts.parameters) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable: symbols.get(item.ownerSymbolId)!, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }];
  for (const item of facts.returns) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable: symbols.get(item.ownerSymbolId)!, expression: item.expressionId ? { sourceUnit: unit, localId: item.expressionId } : undefined }];
  const expressions = new Map(facts.expressions.map((item) => [item.localId, item]));
  for (const item of facts.members) {
    const receiver = item.receiverId ? expressions.get(item.receiverId) : undefined;
    const receiverBinding = receiver ? facts.bindingSeeds.find((binding) => binding.name === receiver.text) : undefined;
    const ownerType = receiverBinding ? typeByBinding.get(receiverBinding.localId) : undefined;
    const owner = facts.symbols.find((symbol) => symbol.kind === "class" && symbol.range.startLine <= item.range.startLine && symbol.range.endLine >= item.range.endLine);
    const member = facts.symbols.find((symbol) => symbol.name === item.memberName && symbol.kind === "method");
    if ((ownerType || owner) && member) result.members = [...result.members, { ...base("member", item.localId, item.range), kind: "member", ownerType: ownerType ?? { kind: "known", symbol: symbols.get(owner!.localId)! }, memberName: item.memberName, member: symbols.get(member.localId)!, access: item.access }];
  }
  for (const item of facts.inheritances) { const subject = symbols.get(item.subjectId); if (subject) result.inheritance = [...result.inheritance, { ...base("inheritance", item.localId, item.range), kind: "inheritance", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  for (const item of facts.implementations) { const subject = symbols.get(item.subjectId); if (subject) result.implementations = [...result.implementations, { ...base("implementation", item.localId, item.range), kind: "implementation", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  for (const item of facts.aliases) result.aliases = [...result.aliases, { ...base("alias", item.localId, item.range), kind: "alias", alias: item.aliasName, targetName: item.targetName, target: typeOf(item.targetName) }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: facts.exports.flatMap((entry) => entry.exportedName ? [entry.exportedName] : []) }];
  for (const item of facts.callSites) result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
  return result;
}

export const ecmascriptSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "ecmascript-phase14b", adapterVersion: 1, languages: ["javascript", "typescript", "tsx"], capabilities: () => capabilities, normalizeFile: normalizeEcmascriptFacts,
};
