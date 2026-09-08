import type { FactLocalId, ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ModuleIdentity, type ScopeIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

export const SWIFT_CAPABILITIES: SemanticCapabilities = {
  moduleImport: "full", localBinding: "full", directCall: "full", declaredType: "full", constructorType: "full",
  receiverMember: "partial", assignment: "partial", parameterFlow: "full", returnFlow: "partial", inheritance: "partial",
};
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizeSwiftFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty();
  const unit = context.sourceUnit;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: `${unit.relativePath}:${kind}:${localId}` as never, sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map<string, typeof symbols extends Map<string, infer V> ? V[] : never>();
  for (const item of facts.symbols) { const symbol = symbols.get(item.localId); if (symbol) byName.set(item.name, [...(byName.get(item.name) ?? []), symbol]); }
  const scopes = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const scopeOf = (localId: string | undefined): ScopeIdentity => ({ sourceUnit: unit, localId: localId ?? "scope:1", parentLocalId: localId ? scopes.get(localId as FactLocalId)?.parentId : undefined });
  const typeOf = (value: string | undefined): TypeRef | undefined => {
    if (!value) return undefined;
    const name = value.replace(/^\s*:/, "").replace(/\?$/, "").trim().split(".").at(-1) ?? value;
    const candidate = byName.get(name);
    return candidate?.length === 1 ? { kind: "known", symbol: candidate[0]! } : { kind: "named", name };
  };
  const typeByBinding = new Map<string, TypeRef>();
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) typeByBinding.set(item.ownerId, type); }
  for (const item of facts.constructors) if (item.resultBindingId) { const type = typeOf(item.constructedTypeName); if (type) typeByBinding.set(item.resultBindingId, type); }
  for (const item of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", item.localId, item.range), kind: "binding", scope: scopeOf(item.ownerId), name: item.name, bindingId: item.localId, declaredType: typeByBinding.get(item.localId) }];
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, localName: item.localName, importedName: item.importedName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: [] }];
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) result.typeAnnotations = [...result.typeAnnotations, { ...base("type", item.localId, item.range), kind: "type_annotation", subjectLocalId: item.ownerId, type }]; }
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName }, resultBindingId: item.resultBindingId }];
  for (const item of facts.parameters) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }]; }
  for (const item of facts.returns) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable, type: typeOf(item.typeText) }]; }
  for (const item of facts.implementations) { const subject = symbols.get(item.subjectId); if (subject) result.implementations = [...result.implementations, { ...base("implementation", item.localId, item.range), kind: "implementation", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  for (const item of facts.members) {
    const ownerFact = item.ownerSymbolId ? facts.symbols.find((candidate) => candidate.localId === item.ownerSymbolId) : undefined;
    const ownerType = ownerFact ? typeOf(ownerFact.name) : undefined;
    const memberFact = facts.symbols.find((candidate) => candidate.name === item.memberName && candidate.declaredQualifiedName?.endsWith(`.${item.memberName}`))
      ?? facts.symbols.find((candidate) => candidate.name === item.memberName);
    const member = memberFact ? symbols.get(memberFact.localId) : undefined;
    if (item.receiverId) {
      if (ownerType && member) result.members = [...result.members, { ...base("member", item.localId, item.range), kind: "member", ownerType, memberName: item.memberName, member, access: item.access }];
      result.diagnostics = [...result.diagnostics, { ...base("member", item.localId, item.range), code: "swift_protocol_witness", message: `Swift protocol witness dispatch is not statically unique for ${item.memberName}` }];
      result.diagnostics = [...result.diagnostics, { ...base("member", item.localId, item.range), code: "language_capability_unsupported", message: `Swift witness/overload dispatch is not compiler-resolved for ${item.memberName}` }];
    } else if (ownerType && member) result.members = [...result.members, { ...base("member", item.localId, item.range), kind: "member", ownerType, memberName: item.memberName, member, access: item.access }];
  }
  for (const item of facts.callSites) result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length) result.diagnostics = [...result.diagnostics, { ...base("parse", "status", facts.containmentScopes[0]?.range ?? { startLine: 1, endLine: 1 }), code: "parse_uncertain", message: facts.parserDiagnostics.join(", ") || "Tree-sitter reported an uncertain Swift parse" }, { ...base("parse", "unsupported", facts.containmentScopes[0]?.range ?? { startLine: 1, endLine: 1 }), code: "language_capability_unsupported", message: "Partial Swift facts are not authoritative" }];
  return result;
}

export const swiftSemanticAdapter: LanguageSemanticAdapter = { adapterId: "swift-phase14b", adapterVersion: 1, languages: ["swift"], capabilities: () => SWIFT_CAPABILITIES, normalizeFile: normalizeSwiftFacts };
