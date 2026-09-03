import type Parser from "tree-sitter";

import {
  buildClassContext,
  createChunk,
  getNodeName,
  stripQuotes,
} from "../base.js";
import type { CodeChunk } from "../types.js";

const NAMED_TOP_LEVEL_TYPES = new Set([
  "class_declaration",
  "function_declaration",
]);

export function extractJavaScriptSymbols(root: Parser.SyntaxNode): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  function visit(node: Parser.SyntaxNode) {
    if (node.type === "class_declaration") {
      const name = getNodeName(node);

      if (name) {
        chunks.push(
          createChunk(
            node,
            "javascript",
            "class",
            name,
            buildClassContext(node, name),
          ),
        );
      }
    }

    if (node.type === "function_declaration") {
      const name = getNodeName(node);

      if (name) {
        chunks.push(createChunk(node, "javascript", "function", name));
      }
    }

    if (node.type === "method_definition") {
      const name = getNodeName(node);

      if (name) {
        chunks.push(createChunk(node, "javascript", "method", name));
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);

  for (const node of root.namedChildren) {
    if (node.type === "import_statement" || node.type === "comment") {
      continue;
    }

    if (NAMED_TOP_LEVEL_TYPES.has(node.type)) {
      continue;
    }

    if (
      node.type === "lexical_declaration" ||
      node.type === "variable_declaration"
    ) {
      for (const child of node.namedChildren) {
        if (child.type !== "variable_declarator") {
          continue;
        }

        const name = getNodeName(child);

        if (!name) {
          continue;
        }

        chunks.push(createChunk(node, "javascript", "variable", name));
      }

      continue;
    }

    if (node.type === "expression_statement") {
      const callExpression = node.namedChildren.find(
        (child) => child.type === "call_expression",
      );

      const functionNode = callExpression?.childForFieldName("function");

      const match = functionNode?.text.match(
        /\.(get|post|put|patch|delete|options|head)$/i,
      );

      if (match && callExpression) {
        const argumentsNode = callExpression.childForFieldName("arguments");

        const routePath = argumentsNode?.namedChildren[0]
          ? stripQuotes(argumentsNode.namedChildren[0].text)
          : "unknown";

        chunks.push(
          createChunk(
            node,
            "javascript",
            "route",
            `${match[1].toUpperCase()} ${routePath}`,
          ),
        );

        continue;
      }
    }

    if (node.text.trim()) {
      chunks.push(
        createChunk(
          node,
          "javascript",
          "module",
          `module:${node.startPosition.row + 1}`,
        ),
      );
    }
  }

  return chunks;
}
