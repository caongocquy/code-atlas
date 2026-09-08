import type { FactLocalId, ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ExpressionIdentity, type ModuleIdentity, type ScopeIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

export const GO_CAPABILITIES: SemanticCapabilities = { moduleImport: "full", localBinding: "full", directCall: "full", declaredType: "full", constructorType: "full", receiverMember: "full", assignment: "partial", parameterFlow: "full", returnFlow: "partial", inheritance: "unsupported" };
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizeGoFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty(), unit = context.sourceUnit;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: `${unit.relativePath}:${kind}:${localId}` as never, sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map(facts.symbols.map((item) => [item.name, symbols.get(item.localId)!]));
  const scopes = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const parent = (id: string | undefined): FactLocalId | undefined => id ? scopes.get(id as FactLocalId)?.parentId : undefined;
  const scopeOf = (id: string | undefined): ScopeIdentity => ({ sourceUnit: unit, localId: id ?? "scope:1", parentLocalId: parent(id) });
  const typeOf = (value: string | undefined): TypeRef | undefined => {
    if (!value) return undefined;
    const name = value.replace("*", "");
    const symbol = byName.get(name);
    return symbol ? { kind: "known", symbol } : { kind: "named", name };
  };
  const typeByBinding = new Map<string, TypeRef>();
  for (const annotation of facts.declaredTypeAnnotations) { const type = typeOf(annotation.text); if (type) typeByBinding.set(annotation.ownerId, type); }
  for (const binding of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", binding.localId, binding.range), kind: "binding", scope: scopeOf(binding.ownerId), name: binding.name, bindingId: binding.localId, declaredType: typeByBinding.get(binding.localId) }];
  for (const annotation of facts.declaredTypeAnnotations) { const type = typeOf(annotation.text); if (type) result.typeAnnotations = [...result.typeAnnotations, { ...base("type", annotation.localId, annotation.range), kind: "type_annotation", subjectLocalId: annotation.ownerId, type }]; }
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, localName: item.localName, importedName: item.importedName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: [] }];
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName } }];
  for (const item of facts.parameters) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }]; }
  for (const item of facts.returns) {
    const callable = symbols.get(item.ownerSymbolId);
    if (callable) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable, expression: item.expressionId ? { sourceUnit: unit, localId: item.expressionId } : undefined }];
  }
  const binding = (name: string | undefined, scopeId: string | undefined) => {
    const candidates = facts.bindingSeeds.filter((item) => item.name === name);
    let scope = scopeId;
    while (scope) { const found = candidates.find((item) => item.ownerId === scope); if (found) return found; scope = parent(scope); }
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const interfaces = facts.symbols.filter((item) => item.kind === "interface");
  for (const call of facts.members.filter((item) => item.receiverId)) {
    const receiver = facts.expressions.find((item) => item.localId === call.receiverId);
    const receiverBinding = binding(receiver?.text, receiver?.ownerScopeId);
    const ownerType = receiverBinding ? typeByBinding.get(receiverBinding.localId) : undefined;
    if (!ownerType) { result.diagnostics = [...result.diagnostics, { ...base("member", call.localId, call.range), code: "receiver_type_unknown", message: `Cannot resolve receiver for ${call.memberName}` }]; continue; }
    const owner = ownerType.kind === "known" ? facts.symbols.find((item) => symbols.get(item.localId) === ownerType.symbol) : undefined;
    const iface = owner && interfaces.some((item) => item.localId === owner.localId) ? owner : undefined;
    if (iface) {
      const implementations = facts.implementations.filter((item) => item.targetName === iface.name && facts.symbols.find((symbol) => symbol.localId === item.subjectId));
      const candidates = implementations.flatMap((item) => { const subject = facts.symbols.find((symbol) => symbol.localId === item.subjectId); return subject ? facts.symbols.filter((symbol) => symbol.kind === "method" && symbol.name === call.memberName && facts.parameters.some((parameter) => parameter.ownerSymbolId === symbol.localId && parameter.typeText?.replace("*", "") === subject.name)) : []; });
      if (candidates.length > 1) { result.members = [...result.members, ...candidates.map((candidate) => ({ ...base("member", call.localId, call.range), kind: "member" as const, ownerType, memberName: call.memberName, member: symbols.get(candidate.localId)!, access: call.access }))]; result.diagnostics = [...result.diagnostics, { ...base("member", call.localId, call.range), code: "interface_dispatch_ambiguous", message: `Interface dispatch for ${call.memberName} has multiple observed method-set owners` }]; }
      else result.diagnostics = [...result.diagnostics, { ...base("member", call.localId, call.range), code: "interface_dispatch_unknown", message: `Interface dispatch for ${call.memberName} is not uniquely observed` }];
    } else {
      const target = owner ? facts.symbols.find((symbol) => symbol.kind === "method" && symbol.name === call.memberName && facts.parameters.some((parameter) => parameter.ownerSymbolId === symbol.localId && parameter.typeText?.replace("*", "") === owner.name)) : undefined;
      if (target) result.members = [...result.members, { ...base("member", call.localId, call.range), kind: "member", ownerType, memberName: call.memberName, member: symbols.get(target.localId)!, access: call.access }];
      else result.diagnostics = [...result.diagnostics, { ...base("member", call.localId, call.range), code: "receiver_type_unknown", message: `Cannot resolve receiver for ${call.memberName}` }];
    }
  }
  for (const item of facts.callSites) result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length) { result.diagnostics = [...result.diagnostics, { sourceUnit: unit, code: "parse_uncertain", message: facts.parserDiagnostics.join(", ") || "Tree-sitter reported an uncertain Go parse" }, { sourceUnit: unit, code: "language_capability_unsupported", message: "Partial Go facts are not authoritative" }]; }
  return result;
}

export const goSemanticAdapter: LanguageSemanticAdapter = { adapterId: "go-phase14b", adapterVersion: 1, languages: ["go"], capabilities: () => GO_CAPABILITIES, normalizeFile: normalizeGoFacts };
