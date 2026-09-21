import type Parser from "tree-sitter";
import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type { AliasFact, AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact, DeclaredTypeAnnotationFact, ExpressionFact, FactLocalId, ImportFact, ImplementationFact, InheritanceFact, MemberFact, ModuleFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact, ReferenceFact, ReturnFact, SourceRangeFact } from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";
import { createObjectiveSyntaxCollector } from "../objective-syntax.types.js";

const id = (kind: string, n: number) => `${kind}:${n}` as FactLocalId;
const range = (node: Parser.SyntaxNode): SourceRangeFact => ({ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: node.startPosition.column, endColumn: node.endPosition.column });
const field = (node: Parser.SyntaxNode | undefined, name: string) => node?.childForFieldName(name) ?? undefined;
const text = (node: Parser.SyntaxNode | undefined) => node?.text;
const named = (node: Parser.SyntaxNode | undefined, types: readonly string[]) => node?.namedChildren.find((child) => types.includes(child.type));

export function extractJavaFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "java") return { kind: "infrastructure_failure", error: new Error(`Extractor java received ${input.language} input`) };
  return extractJavaTreeFacts(parseSource(input.source, input.filePath, "java"), input);
}

function extractJavaTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error("Unable to parse java source") };
    const symbols: ParsedSymbolFact[] = [], scopes: ContainmentScopeFact[] = [], imports: ImportFact[] = [], references: ReferenceFact[] = [], calls: CallSiteFact[] = [];
    const bindings: BindingSeedFact[] = [], types: DeclaredTypeAnnotationFact[] = [], expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [], inheritances: InheritanceFact[] = [], implementations: ImplementationFact[] = [], aliases: AliasFact[] = [], modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [], classStack: ParsedSymbolFact[] = [], callableStack: ParsedSymbolFact[] = [];
    const syntax = createObjectiveSyntaxCollector();
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const symbol = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string): ParsedSymbolFact => { const value = { localId: next("symbol"), name, kind, range: range(node), scopeId: scopeStack.at(-1), declaredQualifiedName: name }; symbols.push(value); return value; };
    const expression = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => { const value = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) }; expressions.push(value); syntax.linkFact(node, value.localId); return value; };
    const bind = (node: Parser.SyntaxNode, name: string, bindingKind: string, ownerId = scopeStack.at(-1)): BindingSeedFact => { const value = { localId: next("binding"), name, bindingKind, ownerId, range: range(node) }; bindings.push(value); return value; };
    const typeAnnotation = (ownerId: FactLocalId, node: Parser.SyntaxNode | undefined): void => { if (node) types.push({ localId: next("type"), ownerId, text: node.text, range: range(node) }); };
    const visit = (node: Parser.SyntaxNode): void => {
      const isType = node.type === "class_declaration" || node.type === "interface_declaration";
      const isCallable = node.type === "method_declaration" || node.type === "constructor_declaration";
      const isScope = node.type === "program" || isType || isCallable || node.type === "block" || node.type === "constructor_body";
      const syntaxNode = syntax.observe(node, callableStack.at(-1)?.localId ?? classStack.at(-1)?.localId, scopeStack.at(-1));
      if (isScope) { const scope = { localId: next("scope"), kind: node.type, name: text(field(node, "name")), parentId: scopeStack.at(-1), range: range(node) }; scopes.push(scope); scopeStack.push(scope.localId); }
      let declared: ParsedSymbolFact | undefined;
      if (node.type === "package_declaration") { const value = named(node, ["scoped_identifier", "identifier"]); if (value) modules.push({ localId: next("module"), name: value.text, moduleKind: "package", exported: true, range: range(node) }); }
      if (node.type === "import_declaration") { const value = node.namedChildren[0]; if (value) imports.push({ localId: next("import"), moduleSpecifier: value.text, importedName: value.text.split(".").at(-1), localName: value.text.split(".").at(-1), kind: "named", range: range(node) }); }
      if (isType) {
        const name = text(field(node, "name"));
        if (name) { declared = symbol(node, node.type === "interface_declaration" ? "interface" : "class", name); classStack.push(declared); }
        const superclass = field(node, "superclass")?.namedChildren[0];
        if (declared && superclass) inheritances.push({ localId: next("inheritance"), subjectId: declared.localId, targetName: superclass.text, relationKind: "extends", range: range(superclass) });
        for (const target of field(node, "interfaces")?.namedChildren.flatMap((item) => item.namedChildren.length ? item.namedChildren : [item]) ?? []) if (declared) implementations.push({ localId: next("implementation"), subjectId: declared.localId, targetName: target.text, relationKind: "implements", range: range(target) });
      } else if (isCallable) {
        const name = text(field(node, "name"));
        if (name) { declared = symbol(node, node.type === "constructor_declaration" ? "method" : "method", name); callableStack.push(declared); if (node.type === "method_declaration") typeAnnotation(declared.localId, field(node, "type")); }
      }
      if (declared && syntaxNode) syntaxNode.ownerSymbolId = declared.localId;
      if (node.type === "field_declaration") {
        const value = field(node, "declarator"), name = text(field(value, "name")), owner = classStack.at(-1);
        if (name && owner) { const member = symbol(value ?? node, "variable", name); member.scopeId = owner.scopeId; bind(value ?? node, name, "field", owner.scopeId); typeAnnotation(member.localId, field(node, "type")); syntax.linkOwner(node, member.localId); }
      }
      if (node.type === "formal_parameter") { const name = text(field(node, "name")), owner = callableStack.at(-1); if (name && owner) { const binding = bind(node, name, "parameter"); const parameterId = next("parameter"); parameters.push({ localId: parameterId, ownerSymbolId: owner.localId, name, bindingId: binding.localId, typeText: text(field(node, "type")), index: parameters.filter((item) => item.ownerSymbolId === owner.localId).length, range: range(node) }); syntax.linkFact(node, parameterId); typeAnnotation(binding.localId, field(node, "type")); } }
      if (node.type === "method_invocation") { const name = text(field(node, "name")) ?? node.text; calls.push({ localId: next("call"), calleeText: name, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) }); }
      if (node.type === "object_creation_expression") { const type = field(node, "type"); if (type) constructors.push({ localId: next("constructor"), ownerSymbolId: callableStack.at(-1)?.localId, constructedTypeName: type.text, range: range(node) }); }
      if (node.type === "field_access") { const object = field(node, "object"), memberName = text(field(node, "field")); if (object && memberName) { const receiver = expression(object, object.type === "this" ? "identifier" : "member"); members.push({ localId: next("member"), receiverId: receiver.localId, memberName, memberKind: "field", access: "instance", range: range(node) }); } }
      if (node.type === "method_invocation" && field(node, "object") && field(node, "name")) { const receiver = expression(field(node, "object")!, "identifier"); members.push({ localId: next("member"), receiverId: receiver.localId, memberName: field(node, "name")!.text, memberKind: "method", access: "instance", range: range(node) }); }
      if (node.type === "return_statement") { const owner = callableStack.at(-1); if (owner) returns.push({ localId: next("return"), ownerSymbolId: owner.localId, expressionId: node.namedChildren[0] ? expression(node.namedChildren[0], "other").localId : undefined, typeText: types.find((item) => item.ownerId === owner.localId)?.text, range: range(node) }); }
      if (node.type === "assignment_expression") { const left = field(node, "left"), right = field(node, "right"); if (left && right) assignments.push({ localId: next("assignment"), targetId: next("binding"), sourceExpressionId: expression(right, "other").localId, assignmentKind: "reassignment", range: range(node) }); }
      if (node.type === "identifier" && node.parent && ["method_invocation", "field_access"].includes(node.parent.type) === false) { const reference = { localId: next("reference"), name: node.text, scopeId: scopeStack.at(-1), range: range(node) }; references.push(reference); syntax.linkFact(node, reference.localId); }
      for (const child of node.namedChildren) visit(child);
      if (isCallable && declared) callableStack.pop();
      if (isType && declared) classStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    const diagnostics: string[] = [], collect = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) diagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const child of node.children) collect(child); };
    collect(parsed.tree.rootNode);
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    const parseStatus = diagnostics.length ? "deterministic_partial" : "complete";
    const facts: ParsedFactsBlob = { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: "java", parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus, parserDiagnostics: [...new Set(diagnostics)], symbols, containmentScopes: scopes, imports, exports: [], references, callSites: calls, bindingSeeds: bindings, declaredTypeAnnotations: types, expressions, members, assignments, parameters, returns, constructors, inheritances, implementations, aliases, modules, namespaces: [], frameworkSyntax: syntax.finish(parseStatus === "complete", parsed.tree.rootNode) };
    return { kind: "facts", facts };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export const javaFactExtractor: LanguageFactExtractor = { language: "java", extract: extractJavaFacts };
