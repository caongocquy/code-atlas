import { createRequire } from "node:module";
import type Parser from "tree-sitter";

const require = createRequire(import.meta.url);

export const ParserRuntime: typeof Parser = require("../../../../vendor/parsers/tree-sitter");
export const JavaScript: Parser.Language = require("../../../../vendor/parsers/tree-sitter-javascript");
export const TypeScript: { typescript: Parser.Language; tsx: Parser.Language } = require("../../../../vendor/parsers/tree-sitter-typescript");
export const C: Parser.Language = require("../../../../vendor/parsers/tree-sitter-c");
export const Cpp: Parser.Language = require("../../../../vendor/parsers/tree-sitter-cpp");
export const Go: Parser.Language = require("../../../../vendor/parsers/tree-sitter-go");
export const Java: Parser.Language = require("../../../../vendor/parsers/tree-sitter-java");
export const Kotlin: Parser.Language = require("../../../../vendor/parsers/tree-sitter-kotlin");
export const Python: Parser.Language = require("../../../../vendor/parsers/tree-sitter-python");
export const Rust: Parser.Language = require("../../../../vendor/parsers/tree-sitter-rust");
export const Swift: Parser.Language = require("../../../../vendor/parsers/tree-sitter-swift");
export const Dart: Parser.Language = require("../../../../vendor/parsers/@driftlog/tree-sitter-dart");
