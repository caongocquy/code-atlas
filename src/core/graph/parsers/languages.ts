import path from "node:path";
import type Parser from "tree-sitter";

import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import C from "tree-sitter-c";
import Cpp from "tree-sitter-cpp";
import Go from "tree-sitter-go";
import Java from "tree-sitter-java";
import Kotlin from "tree-sitter-kotlin";
import Python from "tree-sitter-python";
import Rust from "tree-sitter-rust";
import Swift from "tree-sitter-swift";
import Dart from "@driftlog/tree-sitter-dart";

import type { ParserAdapterMetadata, SupportedLanguage } from "./types.js";

export type LanguageConfig = {
  language: SupportedLanguage;
  extensions: readonly string[];
  grammar:
    | Parser.Language;
  metadata: ParserAdapterMetadata;
};

const runtimeVersion = "0.25.1";

export const LANGUAGE_CONFIGS: readonly LanguageConfig[] = [
  { language: "typescript", extensions: [".ts"], grammar: TypeScript.typescript, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-typescript", grammarName: "tree-sitter-typescript", grammarVersion: "0.23.2" } },
  { language: "tsx", extensions: [".tsx"], grammar: TypeScript.tsx, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-typescript", grammarName: "tree-sitter-typescript", grammarVersion: "0.23.2" } },
  { language: "javascript", extensions: [".js", ".jsx"], grammar: JavaScript, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-javascript", grammarName: "tree-sitter-javascript", grammarVersion: "0.25.0" } },
  { language: "python", extensions: [".py"], grammar: Python, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-python", grammarName: "tree-sitter-python", grammarVersion: "0.25.0" } },
  { language: "java", extensions: [".java"], grammar: Java, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-java", grammarName: "tree-sitter-java", grammarVersion: "0.23.5" } },
  { language: "kotlin", extensions: [".kt", ".kts"], grammar: Kotlin, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-kotlin", grammarName: "tree-sitter-kotlin", grammarVersion: "0.3.8" } },
  { language: "go", extensions: [".go"], grammar: Go, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-go", grammarName: "tree-sitter-go", grammarVersion: "0.25.0" } },
  { language: "rust", extensions: [".rs"], grammar: Rust, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-rust", grammarName: "tree-sitter-rust", grammarVersion: "0.24.0" } },
  { language: "swift", extensions: [".swift"], grammar: Swift, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-swift", grammarName: "tree-sitter-swift", grammarVersion: "0.7.1" } },
  { language: "dart", extensions: [".dart"], grammar: Dart as unknown as Parser.Language, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "@driftlog/tree-sitter-dart", grammarName: "tree-sitter-dart", grammarVersion: "1.0.4" } },
  { language: "c", extensions: [".c", ".h"], grammar: C, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-c", grammarName: "tree-sitter-c", grammarVersion: "0.24.1" } },
  { language: "cpp", extensions: [".cc", ".cpp", ".cxx", ".hpp"], grammar: Cpp, metadata: { runtimeName: "tree-sitter", runtimeVersion, packageName: "tree-sitter-cpp", grammarName: "tree-sitter-cpp", grammarVersion: "0.23.4" } },
];

export function getLanguageConfig(filePath: string): LanguageConfig | null {
  const extension = path.extname(filePath).toLowerCase();

  return LANGUAGE_CONFIGS.find((config) => config.extensions.includes(extension)) ?? null;
}
