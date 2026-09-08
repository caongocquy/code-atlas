import type Parser from "tree-sitter";

import { parserMetadata, parseSource } from "../graph/parsers/code-parser.js";
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
import type { LanguageId } from "../graph/parsers/types.js";
import {
  getLanguageFactExtractor,
  registerLanguageFactExtractor,
  type LanguageFactExtractorInput,
} from "./language-fact-extractor.js";

export type FactExtractionInput = Omit<LanguageFactExtractorInput, "filePath"> & {
  filePath?: string;
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

function id(kind: string, value: number): FactLocalId {
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
  kind?: string;
}> {
  const declaration = node.childForFieldName("declaration");
  if (declaration) {
    const name = declarationName(declaration);
    return [{ exportedName: name, localName: name, kind: "declaration" }];
  }

  const namespaceExport = node.namedChildren.find((child) => child.type === "namespace_export");
  if (namespaceExport) {
    return [{
      exportedName: namespaceExport.namedChildren[0]?.text ?? "*",
      localName: "*",
      kind: "star",
    }];
  }

  const clause = node.namedChildren.find((child) => child.type === "export_clause");
  const entries = clause?.namedChildren
    .filter((child) => child.type === "export_specifier")
    .map((specifier) => {
      const names = specifier.namedChildren
        .filter((child) => child.type === "identifier" || child.type === "type_identifier")
        .map((child) => child.text);
      const localName = specifier.childForFieldName("name")?.text ?? names[0];
      const exportedName = specifier.childForFieldName("alias")?.text
        ?? names[1]
        ?? localName;
      return { exportedName, localName, kind: "named" };
    }) ?? [];
  if (entries.length > 0) return entries;

  return /export\s+\*\s+from\b/.test(node.text)
    ? [{ exportedName: "*", kind: "star" }]
    : [];
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
    for (const child of node.children) visit(child);
  }
  visit(root);
  if (root.hasError && diagnostics.length === 0) {
    diagnostics.push(`parse_error@${root.startPosition.row + 1}:${root.startPosition.column}`);
  }
  return [...new Set(diagnostics)];
}

function comparePosition(
  lineA: number,
  columnA: number | undefined,
  lineB: number,
  columnB: number | undefined,
): number {
  return lineA - lineB || (columnA ?? 0) - (columnB ?? 0);
}

function containsRange(outer: SourceRangeFact, inner: SourceRangeFact): boolean {
  return comparePosition(outer.startLine, outer.startColumn, inner.startLine, inner.startColumn) <= 0
    && comparePosition(outer.endLine, outer.endColumn, inner.endLine, inner.endColumn) >= 0;
}

function rangeSpan(value: SourceRangeFact): number {
  return value.endLine - value.startLine + (value.endColumn ?? 0) / 1_000_000;
}

function smallestContainingSymbol(
  value: SourceRangeFact,
  symbols: ParsedSymbolFact[],
): ParsedSymbolFact | undefined {
  return symbols
    .filter((symbol) => containsRange(symbol.range, value))
    .sort((left, right) => rangeSpan(left.range) - rangeSpan(right.range)
      || left.localId.localeCompare(right.localId))[0];
}

function scopeKindForSymbol(kind: ParsedSymbolFact["kind"]): string | undefined {
  switch (kind) {
    case "class": return "class_declaration";
    case "function": return "function_declaration";
    case "method": return "method_definition";
    default: return undefined;
  }
}

function scopeForSymbol(
  symbol: ParsedSymbolFact,
  scopes: ContainmentScopeFact[],
): FactLocalId | undefined {
  const scopeKind = scopeKindForSymbol(symbol.kind);
  const exactScope = scopeKind
    ? scopes.find((scope) => scope.kind === scopeKind
      && scope.name === symbol.name
      && scope.range.startLine === symbol.range.startLine
      && scope.range.endLine === symbol.range.endLine
      && scope.range.startColumn === symbol.range.startColumn
      && scope.range.endColumn === symbol.range.endColumn)
    : undefined;
  if (exactScope) return exactScope.parentId;

  return scopes
    .filter((scope) => containsRange(scope.range, symbol.range))
    .sort((left, right) => rangeSpan(left.range) - rangeSpan(right.range)
      || left.localId.localeCompare(right.localId))[0]?.localId;
}

export function extractFactsForLanguage(input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    const parsed = parseSource(input.source, input.filePath, input.language);
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
          exports.push({ localId: id("export", ++exportNumber), exportedName: entry.exportedName, localName: entry.localName, moduleSpecifier: stringChild(node), kind: entry.kind ?? "named", range: range(node) });
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
        declaredTypeAnnotations.push({ localId: id("type", ++typeNumber), ownerId: currentScope ?? ("scope:1" as FactLocalId), text: node.text.replace(/^:\s*/, ""), range: range(node) });
      }

      if (node.type === "identifier" && !isDeclarationIdentifier(node) && !isInsideImport(node) && node.parent?.type !== "type_annotation") {
        references.push({ localId: id("reference", ++referenceNumber), name: node.text, scopeId: currentScope, range: range(node) });
      }

      for (const child of node.namedChildren) visit(child);
      if (isScope) scopeStack.pop();
    }

    visit(root);
    for (const symbol of symbols) {
      symbol.scopeId = scopeForSymbol(symbol, containmentScopes);
    }
    for (const callSite of callSites) {
      callSite.callerId = smallestContainingSymbol(callSite.range, symbols)?.localId;
    }
    for (const reference of references) {
      reference.ownerId = smallestContainingSymbol(reference.range, symbols)?.localId;
    }
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
      expressions: [],
      members: [],
      assignments: [],
      parameters: [],
      returns: [],
      constructors: [],
      inheritances: [],
      implementations: [],
      aliases: [],
      modules: [],
      namespaces: [],
    };
    return { kind: "facts", facts };
  } catch (error) {
    return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function materializeFileFacts(relativePath: string, facts: ParsedFactsBlob): MaterializedFileFacts {
  return { relativePath, facts };
}

for (const language of ["typescript", "tsx", "javascript"] as const) {
  registerLanguageFactExtractor({
    language,
    extract: extractFactsForLanguage,
  });
}

export function extractParsedFacts(input: FactExtractionInput): FactExtractionOutcome {
  const filePath = input.filePath ?? `source.${input.language === "typescript"
    ? "ts"
    : input.language === "tsx"
      ? "tsx"
      : input.language === "javascript"
        ? "js"
        : "unknown"}`;
  const extractor = getLanguageFactExtractor(input.language as LanguageId);
  return extractor === undefined
    ? { kind: "infrastructure_failure", error: new Error("Parser or extractor unavailable") }
    : extractor.extract({ ...input, filePath, language: input.language as LanguageId });
}
