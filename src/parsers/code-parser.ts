import Parser from "tree-sitter";

import { getLanguageAdapter } from "./registry.js";
import type { CodeChunk } from "./types.js";

export function parseCodeSymbols(
  source: string,
  filePath: string,
): CodeChunk[] {
  const adapter = getLanguageAdapter(filePath);

  if (!adapter) {
    return [];
  }

  const parser = new Parser();
  parser.setLanguage(adapter.grammar);

  const tree = parser.parse(source);

  return adapter.extractSymbols(tree.rootNode);
}
