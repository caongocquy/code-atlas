import type Parser from "tree-sitter";

export const LANGUAGE_IDS = ["typescript", "tsx", "javascript"] as const;

export type SupportedLanguage = (typeof LANGUAGE_IDS)[number];

export type ParserAdapterMetadata = {
  parserName: string;
  parserVersion: string;
  grammarName: string;
  grammarVersion: string;
  adapterVersion: string;
};

export type SymbolType =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "route"
  | "module";

export type CodeChunk = {
  symbolName: string;
  symbolType: SymbolType;
  language: SupportedLanguage;
  content: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  part?: number;
  totalParts?: number;
};

export type LanguageAdapter = {
  language: SupportedLanguage;
  extensions: string[];
  grammar: Parser.Language;
  metadata: ParserAdapterMetadata;
  extractSymbols(root: Parser.SyntaxNode): CodeChunk[];
};
