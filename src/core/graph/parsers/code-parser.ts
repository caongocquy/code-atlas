import Parser from "tree-sitter";

import { getLanguageAdapter } from "./registry.js";
import type {
  CodeChunk,
  LanguageAdapter,
  ParserAdapterMetadata,
  SupportedLanguage,
} from "./types.js";

export type ParsedSource = {
  adapter: LanguageAdapter;
  tree: Parser.Tree;
};

const LANGUAGE_FILE_NAMES: Partial<Record<SupportedLanguage, string>> = {
  typescript: "source.ts",
  tsx: "source.tsx",
  javascript: "source.js",
  python: "source.py",
  java: "source.java",
  kotlin: "source.kt",
  go: "source.go",
  rust: "source.rs",
  swift: "source.swift",
  dart: "source.dart",
  c: "source.c",
  cpp: "source.cpp",
};

export function getLanguageAdapterForLanguage(
  language: SupportedLanguage,
): LanguageAdapter | null {
  const fileName = LANGUAGE_FILE_NAMES[language];
  return fileName ? getLanguageAdapter(fileName) : null;
}

export function parseSource(
  source: string,
  filePath: string,
  expectedLanguage?: SupportedLanguage,
): ParsedSource | undefined {
  const adapter = getLanguageAdapter(filePath);

  if (!adapter || (expectedLanguage !== undefined && adapter.language !== expectedLanguage)) {
    return undefined;
  }

  const parser = new Parser();
  parser.setLanguage(adapter.grammar);

  return { adapter, tree: parser.parse(source) };
}

export function parserMetadata(
  adapter: LanguageAdapter,
): ParserAdapterMetadata & { language: SupportedLanguage } {
  return { language: adapter.language, ...adapter.metadata };
}

export function parseCodeSymbols(
  source: string,
  filePath: string,
): CodeChunk[] {
  const parsed = parseSource(source, filePath);

  if (!parsed) {
    return [];
  }

  return parsed.adapter.extractSymbols(parsed.tree.rootNode);
}
