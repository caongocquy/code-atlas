import type Parser from "tree-sitter";
import TypeScript from "tree-sitter-typescript";

import {
  buildClassContext,
  createChunk,
  getNodeName,
  stripQuotes,
} from "../base.js";
import type {
  CodeChunk,
  LanguageAdapter,
  SupportedLanguage,
  SymbolType,
} from "../types.js";

const NAMED_TOP_LEVEL_TYPES = new Set([
  "class_declaration",
  "function_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

function extract(
  root: Parser.SyntaxNode,
  language: SupportedLanguage,
): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  function pushNamed(node: Parser.SyntaxNode, symbolType: SymbolType) {
    const name = getNodeName(node);

    if (!name) {
      return;
    }

    const content =
      symbolType === "class" ? buildClassContext(node, name) : node.text;

    chunks.push(createChunk(node, language, symbolType, name, content));
  }

  function visit(node: Parser.SyntaxNode) {
    switch (node.type) {
      case "class_declaration":
        pushNamed(node, "class");
        break;

      case "function_declaration":
        pushNamed(node, "function");
        break;

      case "method_definition":
        pushNamed(node, "method");
        break;

      case "interface_declaration":
        pushNamed(node, "interface");
        break;

      case "type_alias_declaration":
        pushNamed(node, "type");
        break;

      case "enum_declaration":
        pushNamed(node, "enum");
        break;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);

  for (const node of root.namedChildren) {
    const moduleNode = resolveModuleNode(node);

    if (!moduleNode) {
      continue;
    }

    if (NAMED_TOP_LEVEL_TYPES.has(moduleNode.type)) {
      continue;
    }

    const variableChunks = extractVariableChunks(moduleNode, language);

    if (variableChunks.length > 0) {
      chunks.push(...variableChunks);
      continue;
    }

    const routeChunk = extractRouteChunk(moduleNode, language);

    if (routeChunk) {
      chunks.push(routeChunk);
      continue;
    }

    if (!moduleNode.text.trim()) {
      continue;
    }

    chunks.push(
      createChunk(
        moduleNode,
        language,
        "module",
        `module:${moduleNode.startPosition.row + 1}`,
      ),
    );
  }

  return chunks;
}

function resolveModuleNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "import_statement" || node.type === "comment") {
    return null;
  }

  if (node.type === "export_statement") {
    return node.childForFieldName("declaration") ?? null;
  }

  return node;
}

function extractVariableChunks(
  node: Parser.SyntaxNode,
  language: SupportedLanguage,
): CodeChunk[] {
  if (
    node.type !== "lexical_declaration" &&
    node.type !== "variable_declaration"
  ) {
    return [];
  }

  const chunks: CodeChunk[] = [];

  for (const child of node.namedChildren) {
    if (child.type !== "variable_declarator") {
      continue;
    }

    const name = getNodeName(child);

    if (!name) {
      continue;
    }

    chunks.push(createChunk(node, language, "variable", name));
  }

  return chunks;
}

function extractRouteChunk(
  node: Parser.SyntaxNode,
  language: SupportedLanguage,
): CodeChunk | null {
  if (node.type !== "expression_statement") {
    return null;
  }

  const callExpression = node.namedChildren.find(
    (child) => child.type === "call_expression",
  );

  if (!callExpression) {
    return null;
  }

  const functionNode = callExpression.childForFieldName("function");

  if (!functionNode) {
    return null;
  }

  const match = functionNode.text.match(
    /\.(get|post|put|patch|delete|options|head)$/i,
  );

  if (!match) {
    return null;
  }

  const method = match[1].toUpperCase();

  const argumentsNode = callExpression.childForFieldName("arguments");

  const routePath = argumentsNode?.namedChildren[0]
    ? stripQuotes(argumentsNode.namedChildren[0].text)
    : "unknown";

  return createChunk(node, language, "route", `${method} ${routePath}`);
}

export const typescriptAdapter: LanguageAdapter = {
  language: "typescript",
  extensions: [".ts"],
  grammar: TypeScript.typescript,
  metadata: {
    parserName: "tree-sitter",
    parserVersion: "0.25.1",
    grammarName: "tree-sitter-typescript",
    grammarVersion: "0.23.2",
    adapterVersion: "1",
  },
  extractSymbols(root) {
    return extract(root, "typescript");
  },
};

export const tsxAdapter: LanguageAdapter = {
  language: "tsx",
  extensions: [".tsx"],
  grammar: TypeScript.tsx,
  metadata: {
    parserName: "tree-sitter",
    parserVersion: "0.25.1",
    grammarName: "tree-sitter-typescript",
    grammarVersion: "0.23.2",
    adapterVersion: "1",
  },
  extractSymbols(root) {
    return extract(root, "tsx");
  },
};
