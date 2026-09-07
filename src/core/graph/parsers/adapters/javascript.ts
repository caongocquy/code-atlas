import JavaScript from "tree-sitter-javascript";

import type { LanguageAdapter } from "../types.js";
import { extractJavaScriptSymbols } from "./javascript-extractor.js";

export const javascriptAdapter: LanguageAdapter = {
  language: "javascript",
  extensions: [".js", ".jsx"],
  grammar: JavaScript,
  metadata: {
    parserName: "tree-sitter",
    parserVersion: "0.25.1",
    grammarName: "tree-sitter-javascript",
    grammarVersion: "0.25.0",
    adapterVersion: "1",
  },
  extractSymbols(root) {
    return extractJavaScriptSymbols(root);
  },
};
