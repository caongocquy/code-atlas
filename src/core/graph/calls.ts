import Parser from "tree-sitter";

import { getLanguageAdapter } from "./parsers/registry.js";

export type CallReference = {
  calleeName: string;
  callerName?: string;
  callerQualifiedName?: string;
  callerType?: "function" | "method";
  callerClassName?: string;
  line: number;
};

function getCallName(node: Parser.SyntaxNode): string | undefined {
  const functionNode = node.childForFieldName("function");

  if (!functionNode) {
    return undefined;
  }

  if (functionNode.type === "identifier") {
    return functionNode.text;
  }

  if (functionNode.type === "member_expression") {
    const object = functionNode.childForFieldName("object");

    const property = functionNode.childForFieldName("property");

    if (object && property) {
      return `${object.text}.${property.text}`;
    }
  }

  return functionNode.text;
}

function findContainingClassName(node: Parser.SyntaxNode): string | undefined {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (current.type === "class_declaration") {
      const name = current.childForFieldName("name");

      return name?.text;
    }

    current = current.parent;
  }

  return undefined;
}

function findCaller(node: Parser.SyntaxNode): {
  name?: string;
  qualifiedName?: string;
  type?: "function" | "method";
  className?: string;
} {
  let current: Parser.SyntaxNode | null = node.parent;

  while (current) {
    if (current.type === "function_declaration") {
      const name = current.childForFieldName("name")?.text;

      return {
        name,
        qualifiedName: name,
        type: "function",
      };
    }

    if (current.type === "method_definition") {
      const name = current.childForFieldName("name")?.text;

      const className = findContainingClassName(current);

      return {
        name,
        qualifiedName: name && className ? `${className}.${name}` : name,
        type: "method",
        className,
      };
    }

    current = current.parent;
  }

  return {};
}

function walk(node: Parser.SyntaxNode, calls: CallReference[]): void {
  if (node.type === "call_expression") {
    const calleeName = getCallName(node);

    if (calleeName) {
      const caller = findCaller(node);

      calls.push({
        calleeName,
        callerName: caller.name,
        callerQualifiedName: caller.qualifiedName,
        callerType: caller.type,
        callerClassName: caller.className,
        line: node.startPosition.row + 1,
      });
    }
  }

  for (const child of node.namedChildren) {
    walk(child, calls);
  }
}

export function extractCalls(
  source: string,
  filePath: string,
): CallReference[] {
  const adapter = getLanguageAdapter(filePath);

  if (!adapter) {
    return [];
  }

  const parser = new Parser();

  parser.setLanguage(adapter.grammar);

  const tree = parser.parse(source);

  const calls: CallReference[] = [];

  walk(tree.rootNode, calls);

  return calls;
}

export function hasParserErrors(source: string, filePath: string): boolean {
  const adapter = getLanguageAdapter(filePath);
  if (!adapter) return false;
  const parser = new Parser();
  parser.setLanguage(adapter.grammar);
  return parser.parse(source).rootNode.hasError;
}
