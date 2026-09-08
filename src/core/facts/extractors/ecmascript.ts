import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type { LanguageId } from "../../graph/parsers/types.js";
import type {
  AliasFact, AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact,
  DeclaredTypeAnnotationFact, ExportFact, ExpressionFact, FactLocalId, ImportFact, ImplementationFact,
  InheritanceFact, MemberFact, ModuleFact, NamespaceFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact,
  ReferenceFact, ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";

const id = (kind: string, number: number) => `${kind}:${number}` as FactLocalId;
const range = (node: Parser.SyntaxNode): SourceRangeFact => ({
  startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
  startColumn: node.startPosition.column, endColumn: node.endPosition.column,
});
const nameOf = (node: Parser.SyntaxNode | null | undefined): string | undefined =>
  node?.childForFieldName("name")?.text ?? node?.namedChildren.find((child) => ["identifier", "type_identifier", "property_identifier"].includes(child.type))?.text;
const typeText = (node: Parser.SyntaxNode | null | undefined): string | undefined =>
  node?.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? node?.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");

function extractEcmascriptTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error(`Unable to parse ${input.language} source`) };
    const symbols: ParsedSymbolFact[] = [], scopes: ContainmentScopeFact[] = [], imports: ImportFact[] = [], exports: ExportFact[] = [];
    const references: ReferenceFact[] = [], calls: CallSiteFact[] = [], bindings: BindingSeedFact[] = [], types: DeclaredTypeAnnotationFact[] = [];
    const expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [], parameters: ParameterFact[] = [];
    const returns: ReturnFact[] = [], constructors: ConstructorFact[] = [], inheritances: InheritanceFact[] = [], implementations: ImplementationFact[] = [];
    const aliases: AliasFact[] = [], modules: ModuleFact[] = [], namespaces: NamespaceFact[] = [];
    const scopeStack: FactLocalId[] = [];
    let n = 0;
    const next = (kind: string) => id(kind, ++n);
    const symbolFor = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string): ParsedSymbolFact => {
      const symbol = { localId: next("symbol"), name, kind, range: range(node), scopeId: scopeStack.at(-1), declaredQualifiedName: name };
      symbols.push(symbol); return symbol;
    };
    const expressionFor = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"], text = node.text): ExpressionFact => {
      const expression = { localId: next("expression"), kind, text, ownerScopeId: scopeStack.at(-1), range: range(node) };
      expressions.push(expression); return expression;
    };
    const symbolByName = (name: string | undefined) => symbols.find((item) => item.name === name);
    const visit = (node: Parser.SyntaxNode): void => {
      const scopeNode = ["program", "class_declaration", "function_declaration", "function_expression", "arrow_function", "method_definition"].includes(node.type);
      if (scopeNode) {
        const scope = { localId: next("scope"), kind: node.type, name: nameOf(node), parentId: scopeStack.at(-1), range: range(node) };
        scopes.push(scope); scopeStack.push(scope.localId);
      }
      const current = scopeStack.at(-1);
      const nodeName = nameOf(node);
      if (["class_declaration", "function_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "enum_declaration"].includes(node.type) && nodeName) {
        const kind = node.type === "class_declaration" ? "class" : node.type === "function_declaration" ? "function" : node.type === "method_definition" ? "method" : node.type === "interface_declaration" ? "interface" : "type";
        const symbol = symbolFor(node, kind, nodeName);
        const declared = typeText(node);
        if (declared) types.push({ localId: next("type"), ownerId: symbol.localId, text: declared, range: range(node.childForFieldName("return_type") ?? node) });
        if (node.type === "type_alias_declaration") {
          const target = node.childForFieldName("value")?.text;
          if (target) aliases.push({ localId: next("alias"), aliasName: nodeName, targetName: target, aliasKind: "type", range: range(node) });
        }
        const heritage = node.childForFieldName("heritage") ?? node.namedChildren.find((child) => child.type === "class_heritage");
        if (heritage) for (const clause of heritage.namedChildren) {
          const target = clause.namedChildren.at(-1)?.text; if (!target) continue;
          const fact = { localId: next(clause.type === "implements_clause" ? "implementation" : "inheritance"), subjectId: symbol.localId, targetName: target, relationKind: clause.type === "implements_clause" ? "implements" as const : "extends" as const, range: range(clause) };
          (clause.type === "implements_clause" ? implementations : inheritances).push(fact as ImplementationFact & InheritanceFact);
        }
      }
      if (node.type === "import_statement") {
        const specifier = node.namedChildren.find((child) => ["string", "string_fragment"].includes(child.type));
        const moduleSpecifier = specifier?.text.replace(/^['"]|['"]$/g, "");
        if (moduleSpecifier) {
          const imported = node.namedChildren.filter((child) => ["identifier", "import_specifier", "namespace_import"].includes(child.type));
          if (imported.length === 0) imports.push({ localId: next("import"), moduleSpecifier, kind: "side-effect", range: range(node) });
          for (const item of imported) {
            const localName = item.type === "import_specifier" ? item.namedChildren.at(-1)?.text : item.namedChildren.at(-1)?.text ?? item.text;
            if (!localName) continue;
            const importedName = item.type === "import_specifier" ? item.namedChildren[0]?.text : item.type === "namespace_import" ? "*" : "default";
            imports.push({ localId: next("import"), moduleSpecifier, importedName, localName, kind: item.type, range: range(item) });
            bindings.push({ localId: next("binding"), name: localName, bindingKind: "import", sourceModule: moduleSpecifier, importedName, ownerId: current, range: range(item) });
          }
        }
      }
      if (node.type === "export_statement") exports.push({ localId: next("export"), exportedName: nameOf(node.childForFieldName("declaration")), moduleSpecifier: node.namedChildren.find((child) => child.type === "string")?.text.replace(/^['"]|['"]$/g, ""), kind: "named", range: range(node) });
      if (["lexical_declaration", "variable_declaration"].includes(node.type)) for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const target = declarator.childForFieldName("name"), value = declarator.childForFieldName("value"); if (!target) continue;
        const binding = { localId: next("binding"), name: target.text, bindingKind: "local", ownerId: current, range: range(target) }; bindings.push(binding);
        const annotation = declarator.namedChildren.find((child) => child.type === "type_annotation");
        if (annotation) types.push({ localId: next("type"), ownerId: binding.localId, text: annotation.text.replace(/^:\s*/, ""), range: range(annotation) });
        if (value) {
          const expression = expressionFor(value, value.type === "new_expression" ? "construct" : value.type === "call_expression" ? "call" : value.type === "member_expression" ? "member" : value.type === "identifier" ? "identifier" : "other");
          assignments.push({ localId: next("assignment"), targetId: binding.localId, sourceExpressionId: expression.localId, sourceName: value.type === "identifier" ? value.text : undefined, assignmentKind: value.type === "identifier" ? "alias" : "declaration", range: range(declarator) });
          if (value.type === "new_expression") constructors.push({ localId: next("constructor"), constructedTypeName: value.namedChildren[0]?.text ?? value.text.replace(/^new\s+/, "").replace(/\(.*$/, ""), callExpressionId: expression.localId, resultBindingId: binding.localId, range: range(value) });
        }
      }
      if (["required_parameter", "optional_parameter", "formal_parameter", "parameter"].includes(node.type)) {
        const parameterName = node.childForFieldName("pattern")?.text ?? node.childForFieldName("name")?.text ?? node.namedChildren.find((child) => child.type === "identifier")?.text;
        if (parameterName) { const parameter = { localId: next("parameter"), ownerSymbolId: symbolForOwner(node)?.localId ?? ("symbol:0" as FactLocalId), name: parameterName, bindingId: next("binding"), typeText: typeText(node), index: parameters.length, range: range(node) }; parameters.push(parameter); bindings.push({ localId: parameter.bindingId!, name: parameterName, bindingKind: "parameter", ownerId: current, range: range(node) }); if (parameter.typeText) types.push({ localId: next("type"), ownerId: parameter.bindingId!, text: parameter.typeText, range: range(node) }); }
      }
      if (node.type === "call_expression") { const callee = node.childForFieldName("function"); calls.push({ localId: next("call"), calleeText: callee?.text ?? node.text, scopeId: current, range: range(node) }); if (callee?.type === "member_expression") { const object = callee.childForFieldName("object"), property = callee.childForFieldName("property"); if (object && property) { const expression = expressionFor(object, "identifier"); members.push({ localId: calls.at(-1)!.localId.replace("call", "member") as FactLocalId, receiverId: expression.localId, memberName: property.text, memberKind: "method", access: "instance", range: range(callee) }); } } }
      if (node.type === "return_statement") { const value = node.namedChildren[0]; const owner = symbolForOwner(node); returns.push({ localId: next("return"), ownerSymbolId: owner?.localId ?? ("symbol:0" as FactLocalId), expressionId: value ? expressionFor(value, "identifier").localId : undefined, range: range(node) }); }
      if (node.type === "identifier" && node.parent && !["variable_declarator", "required_parameter", "optional_parameter", "formal_parameter", "type_annotation", "type_identifier"].includes(node.parent.type)) references.push({ localId: next("reference"), name: node.text, scopeId: current, range: range(node) });
      for (const child of node.namedChildren) visit(child);
      if (scopeNode) scopeStack.pop();
    };
    function symbolForOwner(node: Parser.SyntaxNode): ParsedSymbolFact | undefined { return symbols.filter((item) => item.range.startLine <= node.startPosition.row + 1 && item.range.endLine >= node.endPosition.row + 1).sort((a, b) => (a.range.endLine - a.range.startLine) - (b.range.endLine - b.range.startLine))[0]; }
    visit(parsed.tree.rootNode);
    for (const symbol of symbols) if (!symbol.scopeId) symbol.scopeId = scopes.find((scope) => scope.name === symbol.name)?.parentId;
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: exports.length > 0, range: range(parsed.tree.rootNode) });
    const diagnostics = parsed.tree.rootNode.descendantsOfType("ERROR").map((node) => `parse_error@${node.startPosition.row + 1}:${node.startPosition.column}`);
    const facts: ParsedFactsBlob = { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: input.language, parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: parsed.tree.rootNode.hasError ? "deterministic_partial" : "complete", parserDiagnostics: [...new Set(diagnostics)], symbols, containmentScopes: scopes, imports, exports, references, callSites: calls, bindingSeeds: bindings, declaredTypeAnnotations: types, expressions, members, assignments, parameters, returns, constructors, inheritances, implementations, aliases, modules, namespaces };
    return { kind: "facts", facts };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export function extractEcmascriptFacts(input: LanguageFactExtractorInput): FactExtractionOutcome { return extractEcmascriptTreeFacts(parseSource(input.source, input.filePath, input.language), input); }
export const javascriptFactExtractor: LanguageFactExtractor = { language: "javascript", extract: extractEcmascriptFacts };
export const typescriptFactExtractor: LanguageFactExtractor = { language: "typescript", extract: extractEcmascriptFacts };
export const tsxFactExtractor: LanguageFactExtractor = { language: "tsx", extract: extractEcmascriptFacts };
