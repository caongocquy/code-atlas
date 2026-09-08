import type Parser from "tree-sitter";
import Python from "tree-sitter-python";

import { createChunk, getNodeName } from "../base.js";
import type { CodeChunk, LanguageAdapter } from "../types.js";

function extractSymbols(root: Parser.SyntaxNode): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === "function_definition" || node.type === "class_definition") {
      const name = getNodeName(node);
      if (name) {
        chunks.push(createChunk(
          node,
          "python",
          node.type === "class_definition" ? "class" : "function",
          name,
        ));
      }
    }

    for (const child of node.namedChildren) visit(child);
  }

  visit(root);
  return chunks;
}

export const pythonAdapter: LanguageAdapter = {
  language: "python",
  extensions: [".py", ".pyi"],
  grammar: Python,
  metadata: {
    runtimeName: "tree-sitter",
    runtimeVersion: "0.25.1",
    packageName: "tree-sitter-python",
    grammarName: "tree-sitter-python",
    grammarVersion: "0.25.0",
  },
  extractSymbols,
};
