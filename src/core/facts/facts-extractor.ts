import type Parser from "tree-sitter";

import {
  getLanguageAdapterForLanguage,
  parserMetadata,
  parseSource,
} from "../graph/parsers/code-parser.js";
import type {
  BindingSeedFact,
  CallSiteFact,
  ContainmentScopeFact,
  DeclaredTypeAnnotationFact,
  ExportFact,
  FactLocalId,
  ImportFact,
  MaterializedFileFacts,
  ParsedFactsBlob,
  ParsedSymbolFact,
  ReferenceFact,
  SourceRangeFact,
} from "./facts.types.js";
import type { SupportedLanguage } from "../graph/parsers/types.js";

export type FactExtractionInput = {
  source: string;
  language: SupportedLanguage;
  contentHash: string;
  factsVersion: string;
  factsSchemaVersion: string;
};

export type FactExtractionOutcome =
  | { kind: "facts"; facts: ParsedFactsBlob }
  | { kind: "infrastructure_failure"; error: Error };

function range(node: Parser.SyntaxNode): SourceRangeFact {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
}

function id(kind: FactLocalId extends `${infer Prefix}:${number}` ? Prefix : never, value: number): FactLocalId {
  return `${kind}:${value}` as FactLocalId;
}

function stringChild(node: Parser.SyntaxNode): string | undefined {
  const stringNode = node.namedChildren.find(
    (child) => child.type === "string" || child.type === "string_fragment",
  );
  if (!stringNode) return undefined;
  if (stringNode.type === "string_fragment") return stringNode.text;
  return stringNode.namedChildren.find((child) => child.type === "string_fragment")?.text
    ?? stringNode.text.replace(/^['"]|['"]$/g, "");
}

function importSpecifiers(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  const named = clause?.namedChildren.find((child) => child.type === "named_imports");
  return named?.namedChildren.filter((child) => child.type === "import_specifier") ?? [];
}

function declarationName(node: Parser.SyntaxNode): string | undefined {
  const directName = node.childForFieldName("name")?.text;
  if (directName) return directName;
  if (node.type === "variable_declarator") {
    return node.childForFieldName("name")?.text;
  }
  for (const child of node.namedChildren) {
    const name = declarationName(child);
    if (name) return name;
  }
  return undefined;
}

function exportEntries(node: Parser.SyntaxNode): Array<{
  exportedName?: string;
  localName?: string;
}> {
  const declaration = node.childForFieldName("declaration");
  if (declaration) {
    const name = declarationName(declaration);
    return [{ exportedName: name, localName: name }];
  }

  const clause = node.namedChildren.find((child) => child.type === "export_clause");
  return clause?.namedChildren
    .filter((child) => child.type === "export_specifier")
    .map((specifier) => {
      const names = specifier.namedChildren
        .filter((child) => child.type === "identifier" || child.type === "type_identifier")
        .map((child) => child.text);
      const localName = specifier.childForFieldName("name")?.text ?? names[0];
      const exportedName = specifier.childForFieldName("alias")?.text
        ?? names[1]
        ?? localName;
      return { exportedName, localName };
    }) ?? [];
}

function isDeclarationIdentifier(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === "import_specifier" || parent.type === "export_specifier") return true;
  if (parent.type === "variable_declarator" && parent.childForFieldName("name") === node) return true;
  if (["function_declaration", "class_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "enum_declaration"].includes(parent.type) && parent.childForFieldName("name") === node) return true;
  if (parent.type === "required_parameter" || parent.type === "optional_parameter") return parent.childForFieldName("pattern") === node || parent.childForFieldName("name") === node;
  return false;
}

function isInsideImport(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "import_statement") return true;
    current = current.parent;
  }
  return false;
}

function diagnosticNodes(root: Parser.SyntaxNode): string[] {
  const diagnostics: string[] = [];
  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "ERROR" || node.isMissing) {
      diagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`);
    }
    for (const child of node.namedChildren) visit(child);
  }
  visit(root);
  return [...new Set(diagnostics)];
}

export function extractParsedFacts(input: FactExtractionInput): FactExtractionOutcome {
  try {
    if (!getLanguageAdapterForLanguage(input.language)) {
      return { kind: "infrastructure_failure", error: new Error(`No parser adapter for ${input.language}`) };
    }

    const extension = input.language === "typescript"
      ? "ts"
      : input.language === "tsx"
        ? "tsx"
        : "js";
    const parsed = parseSource(input.source, `source.${extension}`);
    if (!parsed) {
      return { kind: "infrastructure_failure", error: new Error(`Unable to parse ${input.language} source`) };
    }

    const root = parsed.tree.rootNode;
    const symbols: ParsedSymbolFact[] = [];
    const containmentScopes: ContainmentScopeFact[] = [];
    const imports: ImportFact[] = [];
    const exports: ExportFact[] = [];
    const references: ReferenceFact[] = [];
    const callSites: CallSiteFact[] = [];
    const bindingSeeds: BindingSeedFact[] = [];
    const declaredTypeAnnotations: DeclaredTypeAnnotationFact[] = [];
    let scopeNumber = 0;
    let importNumber = 0;
    let exportNumber = 0;
    let referenceNumber = 0;
    let callNumber = 0;
    let bindingNumber = 0;
    let typeNumber = 0;
    const scopeStack: FactLocalId[] = [];

    const chunks = parsed.adapter.extractSymbols(root).sort((left, right) =>
      left.startLine - right.startLine
      || (left.startColumn ?? 0) - (right.startColumn ?? 0)
      || left.symbolName.localeCompare(right.symbolName),
    );
    for (const chunk of chunks) {
      symbols.push({
        localId: id("symbol", symbols.length + 1),
        name: chunk.symbolName,
        kind: chunk.symbolType,
        range: {
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          startColumn: chunk.startColumn,
          endColumn: chunk.endColumn,
        },
        declaredQualifiedName: chunk.symbolName,
      });
    }

    function visit(node: Parser.SyntaxNode): void {
      const isScope = ["program", "class_declaration", "method_definition", "function_declaration", "function_expression", "arrow_function", "statement_block"].includes(node.type);
      let currentScope: FactLocalId | undefined = scopeStack.at(-1);
      if (isScope) {
        currentScope = id("scope", ++scopeNumber);
        containmentScopes.push({
          localId: currentScope,
          kind: node.type,
          name: node.childForFieldName("name")?.text,
          parentId: scopeStack.at(-1),
          range: range(node),
        });
        scopeStack.push(currentScope);
      }

      if (node.type === "import_statement") {
        const moduleSpecifier = stringChild(node);
        if (moduleSpecifier) {
          const clause = node.namedChildren.find((child) => child.type === "import_clause");
          const candidates = importSpecifiers(node).map((specifier) => {
            const names = specifier.namedChildren.filter((child) => child.type === "identifier");
            return { node: specifier, importedName: names[0]?.text, localName: names[1]?.text ?? names[0]?.text, kind: "named" };
          });
          const defaultImport = clause?.namedChildren.find((child) => child.type === "identifier");
          if (defaultImport) candidates.push({ node: defaultImport, importedName: "default", localName: defaultImport.text, kind: "default" });
          const namespaceImport = clause?.namedChildren.find((child) => child.type === "namespace_import")?.namedChildren.find((child) => child.type === "identifier");
          if (namespaceImport) candidates.push({ node: namespaceImport, importedName: "*", localName: namespaceImport.text, kind: "namespace" });
          candidates.sort((left, right) => left.node.startPosition.column - right.node.startPosition.column);
          for (const candidate of candidates) {
            if (!candidate.importedName || !candidate.localName) continue;
            imports.push({ localId: id("import", ++importNumber), moduleSpecifier, importedName: candidate.importedName, localName: candidate.localName, kind: candidate.kind, range: range(candidate.node) });
            bindingSeeds.push({ localId: id("binding", ++bindingNumber), name: candidate.localName, bindingKind: "import", sourceModule: moduleSpecifier, importedName: candidate.importedName, ownerId: currentScope, range: range(candidate.node) });
          }
          if (candidates.length === 0) {
            imports.push({ localId: id("import", ++importNumber), moduleSpecifier, kind: "side-effect", range: range(node) });
          }
        }
      }

      if (node.type === "export_statement") {
        for (const entry of exportEntries(node)) {
          exports.push({ localId: id("export", ++exportNumber), exportedName: entry.exportedName, localName: entry.localName, moduleSpecifier: stringChild(node), kind: node.childForFieldName("declaration") ? "declaration" : "named", range: range(node) });
        }
      }

      if (node.type === "variable_declarator") {
        const name = node.childForFieldName("name");
        if (name?.type === "identifier") {
          bindingSeeds.push({ localId: id("binding", ++bindingNumber), name: name.text, bindingKind: "local", ownerId: currentScope, range: range(name) });
        }
      }

      if (node.type === "call_expression") {
        const callee = node.childForFieldName("function");
        callSites.push({ localId: id("call", ++callNumber), calleeText: callee?.text ?? node.text, scopeId: currentScope, range: range(node) });
      }

      if (node.type === "type_annotation") {
        declaredTypeAnnotations.push({ localId: id("type", ++typeNumber), ownerId: currentScope ?? "scope:1", text: node.text.replace(/^:\s*/, ""), range: range(node) });
      }

      if (node.type === "identifier" && !isDeclarationIdentifier(node) && !isInsideImport(node) && node.parent?.type !== "type_annotation") {
        references.push({ localId: id("reference", ++referenceNumber), name: node.text, scopeId: currentScope, range: range(node) });
      }

      for (const child of node.namedChildren) visit(child);
      if (isScope) scopeStack.pop();
    }

    visit(root);
    const parserDiagnostics = diagnosticNodes(root);
    const facts: ParsedFactsBlob = {
      factsSchemaVersion: input.factsSchemaVersion,
      factsVersion: input.factsVersion,
      contentHash: input.contentHash,
      language: input.language,
      parserIdentity: parserMetadata(parsed.adapter),
      parseStatus: parserDiagnostics.length > 0 ? "deterministic_partial" : "complete",
      parserDiagnostics,
      symbols,
      containmentScopes,
      imports,
      exports,
      references,
      callSites,
      bindingSeeds,
      declaredTypeAnnotations,
    };
    return { kind: "facts", facts };
  } catch (error) {
    return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function materializeFileFacts(relativePath: string, facts: ParsedFactsBlob): MaterializedFileFacts {
  return { relativePath, facts };
}
