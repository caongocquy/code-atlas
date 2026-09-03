import path from "node:path";

import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

import type { SupportedLanguage } from "./types.js";

type LanguageConfig = {
  language: SupportedLanguage;
  grammar:
    | typeof TypeScript.typescript
    | typeof TypeScript.tsx
    | typeof JavaScript;
};

export function getLanguageConfig(filePath: string): LanguageConfig | null {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".ts":
      return {
        language: "typescript",
        grammar: TypeScript.typescript,
      };

    case ".tsx":
      return {
        language: "tsx",
        grammar: TypeScript.tsx,
      };

    case ".js":
    case ".jsx":
      return {
        language: "javascript",
        grammar: JavaScript,
      };

    default:
      return null;
  }
}
