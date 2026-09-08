import JavaScript from "tree-sitter-javascript";

import type { LanguageAdapter } from "../types.js";
import { extractJavaScriptSymbols } from "./javascript-extractor.js";

export const javascriptAdapter: LanguageAdapter = {
  language: "javascript",
  extensions: [".js", ".jsx"],
  grammar: JavaScript,
  metadata: {
    runtimeName: "tree-sitter",
    runtimeVersion: "0.25.1",
    packageName: "tree-sitter-javascript",
    grammarName: "tree-sitter-javascript",
    grammarVersion: "0.25.0",
  },
  extractSymbols(root) {
    return extractJavaScriptSymbols(root);
  },
};
