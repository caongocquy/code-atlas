import type Parser from "tree-sitter";

import type { CodeChunk, SupportedLanguage, SymbolType } from "./types.js";

export function createChunk(
  node: Parser.SyntaxNode,
  language: SupportedLanguage,
  symbolType: SymbolType,
  symbolName: string,
  content = node.text,
): CodeChunk {
  return {
    symbolName,
    symbolType,
    language,
    content,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column,
    endColumn: node.endPosition.column,
  };
}

export function getNodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

export function buildClassContext(
  node: Parser.SyntaxNode,
  className: string,
): string {
  const heritage = node.childForFieldName("heritage");

  if (heritage) {
    return `class ${className} ${heritage.text}`;
  }

  return `class ${className}`;
}

export function stripQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, "");
}
