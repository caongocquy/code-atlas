import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type {
  AliasFact, AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact,
  DeclaredTypeAnnotationFact, ExpressionFact, FactLocalId, ImportFact, InheritanceFact, MemberFact,
  ModuleFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact, ReferenceFact, ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const id = (kind: string, number: number) => `${kind}:${number}` as FactLocalId;
const range = (node: Parser.SyntaxNode): SourceRangeFact => ({
  startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
  startColumn: node.startPosition.column, endColumn: node.endPosition.column,
});
const child = (node: Parser.SyntaxNode, field: string): Parser.SyntaxNode | undefined => node.childForFieldName(field) ?? undefined;
const typeText = (node: Parser.SyntaxNode | undefined): string | undefined => child(node!, "type")?.text;
const nameText = (node: Parser.SyntaxNode | undefined): string | undefined => child(node!, "name")?.text;
const runtimeNames = new Set(["eval", "exec", "compile", "__import__", "setattr", "delattr", "globals", "locals"]);

export function extractPythonFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error(`Unable to parse ${input.language} source`) };
    const symbols: ParsedSymbolFact[] = [], containmentScopes: ContainmentScopeFact[] = [];
    const imports: ImportFact[] = [], references: ReferenceFact[] = [], callSites: CallSiteFact[] = [];
    const bindingSeeds: BindingSeedFact[] = [], declaredTypeAnnotations: DeclaredTypeAnnotationFact[] = [];
    const expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [];
    const inheritances: InheritanceFact[] = [], aliases: AliasFact[] = [], modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [], classStack: ParsedSymbolFact[] = [], callableStack: ParsedSymbolFact[] = [];
    const expressionIds = new WeakMap<Parser.SyntaxNode, FactLocalId>();
    const returnTypes = new Map<FactLocalId, string>();
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const symbolFor = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string, scopeId = scopeStack.at(-1)): ParsedSymbolFact => {
      const symbol = { localId: next("symbol"), name, kind, range: range(node), scopeId, declaredQualifiedName: name };
      symbols.push(symbol); return symbol;
    };
    const expressionFor = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => {
      const previous = expressionIds.get(node);
      if (previous) return expressions.find((item) => item.localId === previous)!;
      const expression = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) };
      expressions.push(expression); expressionIds.set(node, expression.localId); return expression;
    };
    const addMember = (node: Parser.SyntaxNode, receiver: Parser.SyntaxNode, memberName: string): void => {
      const receiverExpression = expressionFor(receiver, receiver.type === "attribute" ? "member" : "identifier");
      members.push({ localId: next("member"), receiverId: receiverExpression.localId, memberName, memberKind: "field", access: "instance", range: range(node) });
    };
    const bindingFor = (node: Parser.SyntaxNode, bindingKind: string, ownerId = scopeStack.at(-1), name = node.text): BindingSeedFact => {
      const binding = { localId: next("binding"), name, bindingKind, ownerId, range: range(node) };
      bindingSeeds.push(binding); return binding;
    };
    const visit = (node: Parser.SyntaxNode): void => {
      const isModule = node.type === "module";
      const isClass = node.type === "class_definition";
      const isFunction = node.type === "function_definition";
      if (isModule || isClass || isFunction) {
        const scope = { localId: next("scope"), kind: node.type, name: nameText(node), parentId: scopeStack.at(-1), range: range(node) };
        containmentScopes.push(scope); scopeStack.push(scope.localId);
      }
      let declared: ParsedSymbolFact | undefined;
      if (isClass) {
        const name = nameText(node);
        if (name) { declared = symbolFor(node, "class", name); classStack.push(declared); }
        const supers = child(node, "superclasses");
        for (const target of supers?.namedChildren ?? []) if (["identifier", "attribute"].includes(target.type)) {
          inheritances.push({ localId: next("inheritance"), subjectId: declared?.localId ?? next("symbol"), targetName: target.text, relationKind: "base", range: range(target) });
        }
      } else if (isFunction) {
        const name = nameText(node);
        if (name) {
          declared = symbolFor(node, classStack.at(-1) ? "method" : "function", name, classStack.at(-1)?.scopeId ?? scopeStack.at(-1));
          const returnType = child(node, "return_type") ?? child(node, "type");
          if (returnType) returnTypes.set(declared.localId, returnType.text);
          callableStack.push(declared);
        }
      }
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        const moduleNode = node.namedChildren[0];
        const moduleSpecifier = node.type === "import_from_statement" ? moduleNode?.text : undefined;
        const importItems = node.type === "import_from_statement" ? node.namedChildren.slice(1) : node.namedChildren;
        if (node.type === "import_statement") for (const item of importItems) {
          const names = item.type === "aliased_import" ? item.namedChildren : [item];
          const importedName = names[0]?.text, localName = names[1]?.text ?? importedName;
          if (!importedName || !localName) continue;
          imports.push({ localId: next("import"), moduleSpecifier: importedName, localName, kind: "named", range: range(item) });
          bindingFor(item, "import", scopeStack.at(-1), localName);
          if (item.type === "aliased_import" && names[1]) aliases.push({ localId: next("alias"), aliasName: localName, targetName: importedName, aliasKind: "import", range: range(item) });
        }
        if (node.type === "import_from_statement" && moduleSpecifier) for (const item of importItems) {
          if (item.type === "aliased_import") {
            const names = item.namedChildren;
            const importedName = names[0]?.text, localName = names[1]?.text ?? importedName;
            imports.push({ localId: next("import"), moduleSpecifier, importedName: node.type === "import_from_statement" ? importedName : undefined, localName, kind: "named", range: range(item) });
            if (localName) { bindingFor(item, "import", scopeStack.at(-1), localName); if (node.type === "import_from_statement" && importedName) aliases.push({ localId: next("alias"), aliasName: localName, targetName: importedName, aliasKind: "import", range: range(item) }); }
          } else if (["dotted_name", "identifier"].includes(item.type)) {
            const localName = item.text.split(".").at(-1);
            imports.push({ localId: next("import"), moduleSpecifier, localName, kind: "named", range: range(item) });
            if (localName) bindingFor(item, "import", scopeStack.at(-1), localName);
          }
        }
      }
      if (node.type === "parameters") {
        for (const parameter of node.namedChildren) {
          const name = parameter.type === "typed_parameter" ? parameter.namedChildren[0]?.text : parameter.text;
          const owner = callableStack.at(-1);
          if (!name || !owner) continue;
          const binding = bindingFor(parameter, "parameter", scopeStack.at(-1), name);
          parameters.push({ localId: next("parameter"), ownerSymbolId: owner.localId, name, bindingId: binding.localId, typeText: typeText(parameter), index: parameters.filter((item) => item.ownerSymbolId === owner.localId).length, range: range(parameter) });
          if (typeText(parameter)) declaredTypeAnnotations.push({ localId: next("type"), ownerId: binding.localId, text: typeText(parameter)!, range: range(child(parameter, "type")!) });
        }
      }
      if (isFunction && declared && returnTypes.has(declared.localId)) {
        const returnType = child(node, "return_type") ?? child(node, "type");
        if (returnType) declaredTypeAnnotations.push({ localId: next("type"), ownerId: declared.localId, text: returnTypes.get(declared.localId)!, range: range(returnType) });
      }
      if (node.type === "assignment") {
        const target = child(node, "left"), value = child(node, "right");
        if (target?.type === "identifier") {
          const binding = bindingFor(target, "local");
          if (child(node, "type")) declaredTypeAnnotations.push({ localId: next("type"), ownerId: binding.localId, text: child(node, "type")!.text, range: range(child(node, "type")!) });
          if (value) {
            const expression = expressionFor(value, value.type === "call" ? "call" : value.type === "identifier" ? "identifier" : "other");
            assignments.push({ localId: next("assignment"), targetId: binding.localId, sourceExpressionId: expression.localId, sourceName: value.type === "identifier" ? value.text : undefined, assignmentKind: value.type === "identifier" ? "alias" : "declaration", range: range(node) });
            if (value.type === "call") { const callee = value.namedChildren[0]; if (callee?.type === "identifier") constructors.push({ localId: next("constructor"), constructedTypeName: callee.text, callExpressionId: expression.localId, resultBindingId: binding.localId, range: range(value) }); }
          }
        } else if (target?.type === "attribute") {
          const receiver = target.namedChildren[0], memberName = target.namedChildren[1];
          if (receiver && memberName) { addMember(target, receiver, memberName.text); if (classStack.at(-1)) { if (!symbols.some((item) => item.name === memberName.text && item.scopeId === classStack.at(-1)?.scopeId)) symbolFor(memberName, "variable", memberName.text, classStack.at(-1)?.scopeId); } }
        }
      }
      if (node.type === "call") {
        const callee = node.namedChildren[0];
        callSites.push({ localId: next("call"), calleeText: callee?.text ?? node.text, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
        if (callee?.type === "attribute") { const receiver = callee.namedChildren[0], member = callee.namedChildren[1]; if (receiver && member) addMember(callee, receiver, member.text); }
      }
      if (node.type === "return_statement") { const value = node.namedChildren[0], owner = callableStack.at(-1); if (owner) returns.push({ localId: next("return"), ownerSymbolId: owner.localId, expressionId: value ? expressionFor(value, value.type === "attribute" ? "member" : "identifier").localId : undefined, typeText: returnTypes.get(owner.localId), range: range(node) }); }
      if (node.type === "attribute") { const receiver = node.namedChildren[0], member = node.namedChildren[1]; if (receiver && member && node.parent?.type !== "assignment" && node.parent?.type !== "call") addMember(node, receiver, member.text); }
      if (node.type === "identifier" && node.parent?.type !== "attribute" && node.parent?.type !== "assignment" && node.parent?.type !== "typed_parameter") references.push({ localId: next("reference"), name: node.text, scopeId: scopeStack.at(-1), range: range(node) });
      for (const childNode of node.namedChildren) visit(childNode);
      if (node.type === "call" && node.namedChildren[0]?.type === "identifier" && runtimeNames.has(node.namedChildren[0].text)) {
        const runtime = node.namedChildren[0]; references.push({ localId: next("reference"), name: runtime.text, scopeId: scopeStack.at(-1), range: range(runtime) });
      }
      if (isFunction && declared) callableStack.pop();
      if (isClass && declared) classStack.pop();
      if (isModule || isClass || isFunction) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    const parserDiagnostics: string[] = [];
    const collect = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) parserDiagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const item of node.children) collect(item); };
    collect(parsed.tree.rootNode);
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    const facts: ParsedFactsBlob = { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: input.language, parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: parserDiagnostics.length ? "deterministic_partial" : "complete", parserDiagnostics: [...new Set(parserDiagnostics)], symbols, containmentScopes, imports, exports: [], references, callSites, bindingSeeds, declaredTypeAnnotations, expressions, members, assignments, parameters, returns, constructors, inheritances, implementations: [], aliases, modules, namespaces: [] };
    return { kind: "facts", facts };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export const pythonFactExtractor: LanguageFactExtractor = { language: "python", extract: (input) => input.language === "python" ? extractPythonFacts(parseSource(input.source, input.filePath, input.language), input) : { kind: "infrastructure_failure", error: new Error(`Extractor python received ${input.language} input`) } };
