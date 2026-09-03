import JavaScript from "tree-sitter-javascript";

import type { LanguageAdapter } from "../types.js";
import { extractJavaScriptSymbols } from "./javascript-extractor.js";

export const javascriptAdapter: LanguageAdapter = {
  language: "javascript",
  extensions: [".js", ".jsx"],
  grammar: JavaScript,
  extractSymbols(root) {
    return extractJavaScriptSymbols(root);
  },
};
