import type Parser from "tree-sitter";

export const LANGUAGE_IDS = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "java",
  "kotlin",
  "go",
  "rust",
  "swift",
  "dart",
  "c",
  "cpp",
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

export type SupportedLanguage = LanguageId;

export type ParserAdapterMetadata = {
  runtimeName: "tree-sitter";
  runtimeVersion: string;
  packageName: string;
  grammarName: string;
  grammarVersion: string;
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
