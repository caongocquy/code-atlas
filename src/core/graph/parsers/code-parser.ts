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
): ParsedSource | undefined {
  const adapter = getLanguageAdapter(filePath);

  if (!adapter) {
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
