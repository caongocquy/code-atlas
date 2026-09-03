import Parser from "tree-sitter";

import { getLanguageAdapter } from "./parsers/registry.js";
import type { ImportBinding } from "./import-bindings.js";
import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";

function createParser(filePath: string): Parser | undefined {
  const adapter = getLanguageAdapter(filePath);

  if (!adapter) {
    return undefined;
  }

  const parser = new Parser();
  parser.setLanguage(adapter.grammar);

  return parser;
}

function findClassNode(
  graph: CodeGraph,
  file: string,
  name: string,
): GraphNode | undefined {
  return graph.nodes.find(
    (node) => node.file === file && node.type === "class" && node.name === name,
  );
}

function getParentName(classNode: Parser.SyntaxNode): string | undefined {
  const heritage = classNode.namedChildren.find(
    (child) => child.type === "class_heritage",
  );
  const extendsClause = heritage?.namedChildren.find(
    (child) => child.type === "extends_clause",
  );
  const value = extendsClause?.childForFieldName("value");

  if (value?.type !== "identifier" && value?.type !== "type_identifier") {
    return undefined;
  }

  return value.text;
}

export function resolveExtendsEdges(
  graph: CodeGraph,
  file: string,
  source: string,
  importBindings: ImportBinding[],
): GraphEdge[] {
  const parser = createParser(file);

  if (!parser) {
    return [];
  }

  const importByLocalName = new Map(
    importBindings.map((binding) => [binding.localName, binding]),
  );
  const edges: GraphEdge[] = [];
  const tree = parser.parse(source);

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration") {
      const childName = node.childForFieldName("name")?.text;
      const parentName = getParentName(node);

      if (childName && parentName) {
        const child = findClassNode(graph, file, childName);
        const binding = importByLocalName.get(parentName);
        const parentFile = binding?.targetFile ?? file;
        const resolvedParentName = binding?.importedName ?? parentName;
        const parent =
          binding?.targetFile || !binding
            ? findClassNode(graph, parentFile, resolvedParentName)
            : undefined;

        if (child && parent) {
          edges.push({
            from: child.id,
            to: parent.id,
            type: "extends",
          });
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(tree.rootNode);

  return edges;
}
