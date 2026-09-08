import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type {
  AliasFact, AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact,
  DeclaredTypeAnnotationFact, ExportFact, ExpressionFact, FactLocalId, ImportFact, ImplementationFact,
  InheritanceFact, MemberFact, ModuleFact, NamespaceFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact,
  ReferenceFact, ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const id = (kind: string, number: number) => `${kind}:${number}` as FactLocalId;
const range = (node: Parser.SyntaxNode): SourceRangeFact => ({
  startLine: node.startPosition.row + 1,
  endLine: node.endPosition.row + 1,
  startColumn: node.startPosition.column,
  endColumn: node.endPosition.column,
});
const nameOf = (node: Parser.SyntaxNode | null | undefined): string | undefined =>
  node?.childForFieldName("name")?.text
  ?? node?.namedChildren.find((child) => ["identifier", "type_identifier", "property_identifier"].includes(child.type))?.text;
const unquote = (text: string): string => text.length >= 2 ? text.slice(1, -1) : text;
const typeText = (node: Parser.SyntaxNode | null | undefined): string | undefined =>
  node?.childForFieldName("type")?.text?.replace(/^:\s*/, "")
  ?? node?.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");

function extractEcmascriptTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error(`Unable to parse ${input.language} source`) };
    const symbols: ParsedSymbolFact[] = [], containmentScopes: ContainmentScopeFact[] = [];
    const imports: ImportFact[] = [], exports: ExportFact[] = [], references: ReferenceFact[] = [], callSites: CallSiteFact[] = [];
    const bindingSeeds: BindingSeedFact[] = [], declaredTypeAnnotations: DeclaredTypeAnnotationFact[] = [];
    const expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [];
    const inheritances: InheritanceFact[] = [], implementations: ImplementationFact[] = [], aliases: AliasFact[] = [];
    const modules: ModuleFact[] = [], namespaces: NamespaceFact[] = [];
    const scopeStack: FactLocalId[] = [], callableStack: ParsedSymbolFact[] = [];
    const expressionIds = new WeakMap<Parser.SyntaxNode, FactLocalId>();
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const symbolFor = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string): ParsedSymbolFact => {
      const symbol = { localId: next("symbol"), name, kind, range: range(node), scopeId: scopeStack.at(-1), declaredQualifiedName: name };
      symbols.push(symbol);
      return symbol;
    };
    const expressionFor = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => {
      const previous = expressionIds.get(node);
      if (previous) return expressions.find((item) => item.localId === previous)!;
      const expression = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) };
      expressions.push(expression);
      expressionIds.set(node, expression.localId);
      return expression;
    };
    const processImport = (node: Parser.SyntaxNode): void => {
      const specifier = node.namedChildren.find((child) => child.type === "string");
      const moduleSpecifier = specifier ? unquote(specifier.text) : undefined;
      if (!moduleSpecifier) return;
      const clause = node.namedChildren.find((child) => child.type === "import_clause");
      const named = clause?.namedChildren.find((child) => child.type === "named_imports");
      const namedSpecifiers = named?.namedChildren.filter((child) => child.type === "import_specifier") ?? [];
      for (const item of namedSpecifiers) {
        const names = item.namedChildren.map((child) => child.text);
        const importedName = names[0], localName = names.at(-1);
        if (!importedName || !localName) continue;
        imports.push({ localId: next("import"), moduleSpecifier, importedName, localName, kind: "named", range: range(item) });
        bindingSeeds.push({ localId: next("binding"), name: localName, bindingKind: "import", sourceModule: moduleSpecifier, importedName, ownerId: scopeStack.at(-1), range: range(item) });
      }
      const namespace = clause?.namedChildren.find((child) => child.type === "namespace_import");
      const namespaceName = namespace?.namedChildren[0]?.text;
      if (namespaceName) {
        imports.push({ localId: next("import"), moduleSpecifier, importedName: "*", localName: namespaceName, kind: "namespace", range: range(namespace) });
        bindingSeeds.push({ localId: next("binding"), name: namespaceName, bindingKind: "import", sourceModule: moduleSpecifier, importedName: "*", ownerId: scopeStack.at(-1), range: range(namespace) });
      }
      const defaultName = clause?.namedChildren.find((child) => child.type === "identifier")?.text;
      if (defaultName) {
        imports.push({ localId: next("import"), moduleSpecifier, importedName: "default", localName: defaultName, kind: "default", range: range(clause!) });
        bindingSeeds.push({ localId: next("binding"), name: defaultName, bindingKind: "import", sourceModule: moduleSpecifier, importedName: "default", ownerId: scopeStack.at(-1), range: range(clause!) });
      }
      if (namedSpecifiers.length === 0 && !namespaceName && !defaultName) imports.push({ localId: next("import"), moduleSpecifier, kind: "side-effect", range: range(node) });
    };
    const processExport = (node: Parser.SyntaxNode): void => {
      const moduleSpecifier = node.namedChildren.find((child) => child.type === "string");
      const clause = node.namedChildren.find((child) => child.type === "export_clause");
      const specifiers = clause?.namedChildren.filter((child) => child.type === "export_specifier") ?? [];
      for (const item of specifiers) {
        const names = item.namedChildren.map((child) => child.text);
        const localName = names[0], exportedName = names.at(-1);
        if (localName && exportedName) exports.push({ localId: next("export"), exportedName, localName, moduleSpecifier: moduleSpecifier ? unquote(moduleSpecifier.text) : undefined, kind: "named", range: range(item) });
      }
      if (specifiers.length > 0) return;
      const namespace = node.namedChildren.find((child) => child.type === "namespace_export");
      if (namespace) { exports.push({ localId: next("export"), exportedName: "*", moduleSpecifier: moduleSpecifier ? unquote(moduleSpecifier.text) : undefined, kind: "star", range: range(namespace) }); return; }
      const declaration = node.childForFieldName("declaration");
      const declaredName = nameOf(declaration);
      if (declaredName) exports.push({ localId: next("export"), exportedName: declaredName, localName: declaredName, kind: "declaration", range: range(node) });
    };
    const visit = (node: Parser.SyntaxNode): void => {
      const isCallable = ["function_declaration", "function_expression", "arrow_function", "method_definition"].includes(node.type);
      const isScope = ["program", "class_declaration", "function_declaration", "function_expression", "arrow_function", "method_definition"].includes(node.type);
      if (isScope) {
        const scope = { localId: next("scope"), kind: node.type, name: nameOf(node), parentId: scopeStack.at(-1), range: range(node) };
        containmentScopes.push(scope); scopeStack.push(scope.localId);
      }
      let callable: ParsedSymbolFact | undefined;
      const nodeName = nameOf(node);
      if (["class_declaration", "function_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "enum_declaration"].includes(node.type) && nodeName) {
        const kind = node.type === "class_declaration" ? "class" : node.type === "function_declaration" ? "function" : node.type === "method_definition" ? "method" : node.type === "interface_declaration" ? "interface" : "type";
        callable = symbolFor(node, kind, nodeName);
        if (node.type === "type_alias_declaration") {
          const target = node.childForFieldName("value")?.text;
          if (target) aliases.push({ localId: next("alias"), aliasName: nodeName, targetName: target, aliasKind: "type", range: range(node) });
        }
        const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "");
        if (returnType) declaredTypeAnnotations.push({ localId: next("type"), ownerId: callable.localId, text: returnType, range: range(node.childForFieldName("return_type")!) });
        const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
        if (heritage) for (const clause of heritage.namedChildren) {
          const target = clause.namedChildren.at(-1)?.text;
          if (!target) continue;
          if (clause.type === "implements_clause") implementations.push({ localId: next("implementation"), subjectId: callable.localId, targetName: target, relationKind: "implements", range: range(clause) });
          else inheritances.push({ localId: next("inheritance"), subjectId: callable.localId, targetName: target, relationKind: "extends", range: range(clause) });
        }
      }
      if (node.type === "method_signature" && nodeName) symbolFor(node, "method", nodeName);
      if (isCallable && !callable) {
        const localId = `symbol:${node.type}:${node.startIndex}` as FactLocalId;
        callable = { localId, name: `${node.type}@${node.startIndex}`, kind: "function", range: range(node), scopeId: scopeStack.at(-1), declaredQualifiedName: `${node.type}@${node.startIndex}` };
        symbols.push(callable);
      }
      if (isCallable && callable) callableStack.push(callable);
      if (node.type === "import_statement") processImport(node);
      if (node.type === "export_statement") processExport(node);
      if (node.type === "type_annotation" && !node.parent?.type.includes("parameter")) {
        declaredTypeAnnotations.push({ localId: next("type"), ownerId: callableStack.at(-1)?.localId ?? scopeStack.at(-1) ?? id("scope", 1), text: node.text.replace(/^:\s*/, ""), range: range(node) });
      }
      if (["lexical_declaration", "variable_declaration"].includes(node.type)) for (const declarator of node.namedChildren.filter((child) => child.type === "variable_declarator")) {
        const target = declarator.childForFieldName("name"), value = declarator.childForFieldName("value");
        if (!target) continue;
        const binding = { localId: next("binding"), name: target.text, bindingKind: "local", ownerId: scopeStack.at(-1), range: range(target) };
        bindingSeeds.push(binding);
        const annotation = declarator.namedChildren.find((child) => child.type === "type_annotation");
        if (annotation) declaredTypeAnnotations.push({ localId: next("type"), ownerId: binding.localId, text: annotation.text.replace(/^:\s*/, ""), range: range(annotation) });
        if (value) {
          const expression = expressionFor(value, value.type === "new_expression" ? "construct" : value.type === "call_expression" ? "call" : value.type === "member_expression" ? "member" : value.type === "identifier" ? "identifier" : "other");
          assignments.push({ localId: next("assignment"), targetId: binding.localId, sourceExpressionId: expression.localId, sourceName: value.type === "identifier" ? value.text : undefined, assignmentKind: value.type === "identifier" ? "alias" : "declaration", range: range(declarator) });
          if (value.type === "new_expression") {
            const constructor = value.childForFieldName("constructor") ?? value.namedChildren.find((child) => ["identifier", "type_identifier"].includes(child.type));
            if (constructor) constructors.push({ localId: next("constructor"), constructedTypeName: constructor.text, callExpressionId: expression.localId, resultBindingId: binding.localId, range: range(value) });
          }
        }
      }
      if (["required_parameter", "optional_parameter", "formal_parameter", "parameter"].includes(node.type)) {
        const parameterName = node.childForFieldName("pattern")?.text ?? node.childForFieldName("name")?.text ?? node.namedChildren.find((child) => child.type === "identifier")?.text;
        const owner = callableStack.at(-1);
        if (parameterName && owner) {
          const bindingId = next("binding");
          parameters.push({ localId: next("parameter"), ownerSymbolId: owner.localId, name: parameterName, bindingId, typeText: typeText(node), index: parameters.filter((item) => item.ownerSymbolId === owner.localId).length, range: range(node) });
          bindingSeeds.push({ localId: bindingId, name: parameterName, bindingKind: "parameter", ownerId: scopeStack.at(-1), range: range(node) });
          if (typeText(node)) declaredTypeAnnotations.push({ localId: next("type"), ownerId: bindingId, text: typeText(node)!, range: range(node) });
        }
      }
      if (node.type === "member_expression") {
        const object = node.childForFieldName("object"), property = node.childForFieldName("property");
        if (object && property) {
          const receiver = expressionFor(object, object.type === "call_expression" ? "call" : object.type === "member_expression" ? "member" : object.type === "identifier" ? "identifier" : "other");
          members.push({ localId: next("member"), receiverId: receiver.localId, memberName: property.text, memberKind: "method", access: "instance", range: range(node) });
          expressionFor(node, "member");
        }
      }
      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        callSites.push({ localId: next("call"), calleeText: callee?.text ?? node.text, scopeId: scopeStack.at(-1), range: range(node) });
        expressionFor(node, "call");
      }
      if (node.type === "return_statement") {
        const value = node.namedChildren[0];
        const owner = callableStack.at(-1);
        if (owner) returns.push({ localId: next("return"), ownerSymbolId: owner.localId, expressionId: value ? expressionFor(value, value.type === "member_expression" ? "member" : "identifier").localId : undefined, range: range(node) });
      }
      if (node.type === "arrow_function") {
        const body = node.childForFieldName("body");
        const owner = callableStack.at(-1);
        if (body && body.type !== "statement_block" && owner) returns.push({ localId: next("return"), ownerSymbolId: owner.localId, expressionId: expressionFor(body, body.type === "member_expression" ? "member" : "identifier").localId, range: range(body) });
      }
      if (node.type === "identifier" && node.parent && !["variable_declarator", "required_parameter", "optional_parameter", "formal_parameter", "type_annotation", "type_identifier", "import_specifier", "export_specifier"].includes(node.parent.type)) references.push({ localId: next("reference"), name: node.text, scopeId: scopeStack.at(-1), range: range(node) });
      for (const child of node.namedChildren) visit(child);
      if (isCallable && callable) callableStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    const parserDiagnostics: string[] = [];
    const collectDiagnostics = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) parserDiagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const child of node.children) collectDiagnostics(child); };
    collectDiagnostics(parsed.tree.rootNode);
    const uniqueDiagnostics = [...new Set(parserDiagnostics)];
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: exports.length > 0, range: range(parsed.tree.rootNode) });
    const facts: ParsedFactsBlob = {
      factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: input.language,
      parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: parsed.tree.rootNode.hasError || uniqueDiagnostics.length > 0 ? "deterministic_partial" : "complete", parserDiagnostics: uniqueDiagnostics,
      symbols, containmentScopes, imports, exports, references, callSites, bindingSeeds, declaredTypeAnnotations, expressions, members, assignments,
      parameters, returns, constructors, inheritances, implementations, aliases, modules, namespaces,
    };
    return { kind: "facts", facts };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export function extractEcmascriptFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  return extractEcmascriptTreeFacts(parseSource(input.source, input.filePath, input.language), input);
}

function exactExtractor(language: "javascript" | "typescript" | "tsx"): LanguageFactExtractor {
  return { language, extract: (input) => input.language === language ? extractEcmascriptFacts(input) : { kind: "infrastructure_failure", error: new Error(`Extractor ${language} received ${input.language} input`) } };
}

export const javascriptFactExtractor = exactExtractor("javascript");
export const typescriptFactExtractor = exactExtractor("typescript");
export const tsxFactExtractor = exactExtractor("tsx");
