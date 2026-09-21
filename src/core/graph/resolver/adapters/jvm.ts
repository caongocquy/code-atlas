import type { FactLocalId, ParsedFactsBlob, SourceRangeFact } from "../../../facts/facts.types.js";
import { symbolIdentity, type ExpressionIdentity, type ModuleIdentity, type ScopeIdentity } from "../identities.js";
import type { AdapterContext, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch, TypeRef } from "../types.js";

export const JAVA_CAPABILITIES: SemanticCapabilities = { moduleImport: "full", localBinding: "full", directCall: "full", declaredType: "full", constructorType: "full", receiverMember: "full", assignment: "full", parameterFlow: "full", returnFlow: "full", inheritance: "full" };
export const KOTLIN_CAPABILITIES: SemanticCapabilities = { moduleImport: "full", localBinding: "full", directCall: "partial", declaredType: "full", constructorType: "partial", receiverMember: "partial", assignment: "partial", parameterFlow: "full", returnFlow: "partial", inheritance: "partial" };
const empty = (): SemanticEvidenceBatch => ({ bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [] });

export function normalizeJvmFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch {
  const result = empty(), unit = context.sourceUnit;
  const base = (kind: string, localId: string, range: SourceRangeFact) => ({ evidenceId: `${unit.relativePath}:${kind}:${localId}` as never, sourceUnit: unit, range });
  const symbols = new Map(facts.symbols.map((item) => [item.localId, symbolIdentity({ repositoryId: context.repositoryIdentity.id, relativePath: unit.relativePath, language: unit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId })]));
  const byName = new Map(facts.symbols.map((item) => [item.name, symbols.get(item.localId)!]));
  const scopes = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const parent = (id: string | undefined): FactLocalId | undefined => id ? scopes.get(id as FactLocalId)?.parentId : undefined;
  const enclosingType = (symbol: typeof facts.symbols[number]) => { let current = symbol.scopeId; while (current) { const scope = scopes.get(current); if (!scope) break; if (["class_declaration", "object_declaration"].includes(scope.kind)) return facts.symbols.find((item) => item.scopeId === scope.localId && ["class", "interface"].includes(item.kind)); current = scope.parentId; } return undefined; };
  const scopeOf = (id: string | undefined): ScopeIdentity => ({ sourceUnit: unit, localId: id ?? "scope:1", parentLocalId: parent(id) });
  const typeOf = (value: string | undefined): TypeRef | undefined => {
    if (!value) return undefined;
    const raw = value.trim();
    const name = raw.replaceAll("?", "");
    if (raw !== name) return { kind: "named", name: raw };
    const qualified = facts.symbols.find((item) => item.name.endsWith(`.${name}`));
    const known = byName.get(name) ?? (qualified ? symbols.get(qualified.localId) : undefined);
    return known ? { kind: "known", symbol: known } : { kind: "named", name };
  };
  const typeByBinding = new Map<string, TypeRef>();
  const bindingById = new Map(facts.bindingSeeds.map((item) => [item.localId, item]));
  for (const annotation of facts.declaredTypeAnnotations) { const type = typeOf(annotation.text); if (type && bindingById.has(annotation.ownerId)) typeByBinding.set(annotation.ownerId, type); }
  for (const item of facts.constructors) if (item.resultBindingId) typeByBinding.set(item.resultBindingId, typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName });
  const findBinding = (name: string | undefined, start: string | undefined) => { const candidates = facts.bindingSeeds.filter((item) => item.name === name); let current = start; while (current) { const found = candidates.find((item) => item.ownerId === current); if (found) return found; current = parent(current); } return candidates.length === 1 ? candidates[0] : undefined; };
  for (const item of facts.bindingSeeds) result.bindings = [...result.bindings, { ...base("binding", item.localId, item.range), kind: "binding", scope: scopeOf(item.ownerId), name: item.name, bindingId: item.localId, declaredType: typeByBinding.get(item.localId) }];
  for (const item of facts.declaredTypeAnnotations) { const type = typeOf(item.text); if (type) { result.typeAnnotations = [...result.typeAnnotations, { ...base("type", item.localId, item.range), kind: "type_annotation", subjectLocalId: item.ownerId, type }]; result.bindings = result.bindings.map((binding) => binding.bindingId === item.ownerId ? { ...binding, declaredType: type } : binding); } }
  for (const item of facts.imports) result.imports = [...result.imports, { ...base("import", item.localId, item.range), kind: "import", specifier: item.moduleSpecifier, importedName: item.importedName, localName: item.localName, module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.moduleSpecifier } satisfies ModuleIdentity }];
  for (const item of facts.assignments) { const source: ExpressionIdentity | undefined = item.sourceExpressionId ? { sourceUnit: unit, localId: item.sourceExpressionId } : undefined; const sourceBinding = findBinding(item.sourceName, undefined); const sourceType = sourceBinding ? typeByBinding.get(sourceBinding.localId) : undefined; if (sourceType) typeByBinding.set(item.targetId, sourceType); result.assignments = [...result.assignments, { ...base("assignment", item.localId, item.range), kind: "assignment", targetBindingId: item.targetId, sourceExpression: source, sourceType }]; }
  for (const item of facts.constructors) result.constructors = [...result.constructors, { ...base("constructor", item.localId, item.range), kind: "constructor", constructedType: typeOf(item.constructedTypeName) ?? { kind: "named", name: item.constructedTypeName }, resultBindingId: item.resultBindingId }];
  for (const item of facts.parameters) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.parameters = [...result.parameters, { ...base("parameter", item.localId, item.range), kind: "parameter", callable, index: item.index, bindingId: item.bindingId ?? item.localId, type: typeOf(item.typeText) }]; }
  for (const item of facts.returns) { const callable = symbols.get(item.ownerSymbolId); if (callable) result.returns = [...result.returns, { ...base("return", item.localId, item.range), kind: "return", callable, expression: item.expressionId ? { sourceUnit: unit, localId: item.expressionId } : undefined, type: typeOf(item.typeText) }]; }
  const expressions = new Map(facts.expressions.map((item) => [item.localId, item]));
  for (const item of facts.members) {
    const receiver = item.receiverId ? expressions.get(item.receiverId) : undefined;
    let ownerType: TypeRef | undefined;
    const receiverText = receiver?.text;
    const receiverBinding = receiver ? findBinding(receiver.text, receiver.ownerScopeId) : undefined;
    if (receiverBinding) ownerType = typeByBinding.get(receiverBinding.localId);
    if (!ownerType && receiverText?.endsWith("()")) ownerType = typeOf(receiverText.slice(0, -2));
    if (!ownerType && receiver?.text === "this") { let current = receiver.ownerScopeId; while (current && scopes.get(current)?.kind !== "class_declaration" && scopes.get(current)?.kind !== "class_body") current = parent(current); const owner = facts.symbols.find((symbol) => (symbol.kind === "class" || symbol.kind === "interface") && symbol.scopeId === current); if (owner) ownerType = { kind: "known", symbol: symbols.get(owner.localId)! }; }
    const owner = ownerType?.kind === "known" ? facts.symbols.find((symbol) => symbols.get(symbol.localId) === ownerType.symbol) : undefined;
    const memberName = item.memberName.startsWith(".") ? item.memberName.slice(1) : item.memberName;
    const members = owner && unit.language === "kotlin"
      ? facts.symbols.filter((symbol) => symbol.kind === "method" && symbol.name === memberName && enclosingType(symbol)?.localId === owner.localId)
      : owner ? facts.symbols.filter((symbol) => symbol.name === memberName && symbol.scopeId === owner.scopeId) : [];
    if (ownerType && members.length > 0) result.members = [...result.members, ...members.map((member) => ({ ...base("member", item.localId, item.range), kind: "member" as const, ownerType, memberName, member: symbols.get(member.localId)!, access: item.access }))];
    else result.diagnostics = [...result.diagnostics, { ...base("member", item.localId, item.range), code: "receiver_type_unknown", message: `Cannot resolve receiver for ${item.memberName}` }];
  }
  for (const item of facts.inheritances) { const subject = symbols.get(item.subjectId); if (subject) result.inheritance = [...result.inheritance, { ...base("inheritance", item.localId, item.range), kind: "inheritance", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; }
  for (const item of facts.implementations) { const subject = symbols.get(item.subjectId); if (subject) result.implementations = [...result.implementations, { ...base("implementation", item.localId, item.range), kind: "implementation", subject, target: typeOf(item.targetName) ?? { kind: "named", name: item.targetName }, relation: item.relationKind }]; if (item.relationKind === "extension") result.diagnostics = [...result.diagnostics, { ...base("implementation", item.localId, item.range), code: "extension_dispatch_unsupported", message: "Kotlin extension dispatch requires compiler semantics" }]; }
  for (const item of facts.aliases) result.aliases = [...result.aliases, { ...base("alias", item.localId, item.range), kind: "alias", alias: item.aliasName, targetName: item.targetName, target: typeOf(item.targetName) }];
  for (const item of facts.modules) result.modules = [...result.modules, { ...base("module", item.localId, item.range), kind: "module", module: { repositoryId: context.repositoryIdentity.id, normalizedName: item.name, relativePath: unit.relativePath }, exportedNames: [] }];
  for (const item of facts.callSites) result.calls = [...result.calls, { ...base("call", item.localId, item.range), kind: "call", site: { sourceUnit: unit, localId: item.localId }, calleeName: item.calleeText, arguments: [] }];
  const methodNames = facts.symbols.filter((item) => item.kind === "method").map((item) => item.name);
  for (const name of new Set(methodNames)) if (methodNames.filter((item) => item === name).length > 1) result.diagnostics = [...result.diagnostics, { ...base("overload", name, facts.symbols.find((item) => item.name === name)!.range), code: "overload_ambiguity", message: `Overload set requires declared argument types: ${name}` }, { ...base("dispatch", name, facts.symbols.find((item) => item.name === name)!.range), code: "compiler_dispatch_unknown", message: `Compiler dispatch is underdetermined: ${name}` }];
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length) result.diagnostics = [...result.diagnostics, { sourceUnit: unit, code: "parse_uncertain", message: facts.parserDiagnostics.join(", ") || "Tree-sitter reported an uncertain parse" }, { sourceUnit: unit, code: "language_capability_unsupported", message: "Partial JVM facts are not authoritative" }];
  return result;
}

export const jvmSemanticAdapter: LanguageSemanticAdapter = { adapterId: "jvm-phase14b", adapterVersion: 1, languages: ["java", "kotlin"], capabilities: (language) => language === "java" ? JAVA_CAPABILITIES : KOTLIN_CAPABILITIES, normalizeFile: normalizeJvmFacts };
